import { getProvider } from './provider';
import type { ModelId, Provider, ReviewGuide } from './types';

// ── System prompt & schema constants ─────────────────────────────

const SYSTEM_PROMPT = `You are an expert code reviewer helping a developer understand a pull request before they review it. Your job is to analyze the PR and produce a guided review — a sequence of "slides" that walks the reviewer through the changes in the best possible order.

Guidelines for producing a great review guide:

ORDERING: Order slides so the reviewer always has context before they need it.
- Show foundational changes first (base types, interfaces, schemas, abstract classes)
- Then show implementations that depend on those foundations
- Then show call sites and consumers
- Show tests after the code they test
- Show config and documentation last

GROUPING: Group changes that are logically related and should be understood together.
- A change to an interface and its implementation belong in the same slide if small, or sequential slides if large
- Unrelated changes to the same file should be in different slides
- Refactoring a function and adding a test for it are two different slides

NARRATIVE: For each slide, explain WHY this changed, not just WHAT changed.
- Assume the reviewer is smart but hasn't read the PR description carefully
- Lead with the business or technical motivation in one sentence
- Then explain what specifically changed and how it works
- Wrap up with anything non-obvious or worth keeping in mind
- Write 2–4 short paragraphs — never one dense wall of text
- Use **bold** for emphasis, \`backticks\` for code symbols, and markdown lists where helpful
- No headings in narrative — just bold, lists, inline code

REVIEW FOCUS: Write 2–4 actionable checks as a markdown bullet list.
- Each bullet should be a single clear sentence
- Focus on what could actually go wrong, not just what to look at

MERMAID DIAGRAM (optional): Include a Mermaid diagram when it genuinely helps the reviewer understand the flow or structure. Omit it (null) when the change is simple or the diagram would add clutter.
- Use sequenceDiagram for request/response flows, async calls, event handling, or service interactions
- Use flowchart TD for conditional logic, branching, or state transitions
- Use classDiagram for data model changes or new type hierarchies
- Keep diagrams small: 5–8 nodes max. Label edges clearly. Omit obvious steps.
- The diagram should show the BEHAVIOUR, not just list the classes in the diff

WRITING STYLE (apply to all text fields — narrative, reviewFocus, summary, riskRationale):
- Short sentences. Plain words. No jargon when plain English works.
- One idea per sentence. One topic per paragraph.
- Avoid filler: "It's worth noting that", "This means that", "In order to"
- Never pad text to seem thorough — concise and clear beats long and complete
- Markdown is allowed: bold, inline code, bullet lists. Use sparingly — no headings in narrative fields.

RISK: Assess overall risk based on:
- Changes to auth, payments, data models, or public APIs = high risk
- New features with tests = medium risk
- Refactoring with test coverage = low risk
- Docs and config = low risk

You are given:
- <full_diff>: the complete unified diff with expanded context (up to 10 lines around each change)
- <file_contents_before>: full file contents at base ref (before the PR)
- <file_contents_after>: full file contents at head ref (after the PR)
- <neighbor_files>: files imported by the changed files

Use file_contents_before and file_contents_after to understand the full shape of each changed file, not just the lines in the diff. Reference surrounding functions, types, and patterns when writing narratives to give the reviewer genuine codebase context.

When generating diffHunks.content, use unified diff format: each line MUST start with '+' (added), '-' (removed), or ' ' (space, for context). Include 10 lines of context before and after each change. Draw from the file contents if the diff context is shorter.

You must respond with valid JSON matching the ReviewGuide schema exactly. No explanation outside the JSON.`;

const USER_SUFFIX = `

Produce a ReviewGuide JSON object for this pull request. The slides array must be ordered for optimal review flow as described. Every slide must have a clear narrative and reviewFocus. Remember: short paragraphs, plain language, one idea per sentence — the goal is to reduce cognitive load for the reviewer.

The JSON must match this schema exactly:
{
  "prTitle": string,
  "prDescription": string,
  "prUrl": string,
  "author": string,
  "summary": string,
  "riskLevel": "low" | "medium" | "high",
  "riskRationale": string,
  "totalFilesChanged": number,
  "totalLinesChanged": number,
  "slides": [
    {
      "id": string,
      "slideNumber": number,
      "title": string,
      "slideType": "foundation" | "feature" | "refactor" | "bugfix" | "test" | "config" | "docs",
      "narrative": string,
      "reviewFocus": string,
      "diffHunks": [
        {
          "filePath": string,
          "hunkHeader": string,
          "content": string,
          "language": string,
          "renderedHtml": ""
        }
      ],
      "contextSnippets": string[],
      "affectedFiles": string[],
      "dependsOn": string[],
      "mermaidDiagram": string | null
    }
  ]
}`;

const CONCISE_SUFFIX = `

IMPORTANT: Be concise. Keep narrative and reviewFocus under 2 sentences each. Omit contextSnippets entirely (use empty arrays). Limit diffHunks to the 3 most important hunks per slide. Return only raw JSON starting with { and ending with }.`;

const SIGNAL_BOOST_DIRECTIVE = `
SIGNAL BOOST MODE — ACTIVE
You must apply these rules on top of all other guidelines:

1. SKIP slides for trivial changes: whitespace-only edits, import reordering, rename-only refactors, boilerplate ceremony (license headers, generated code, auto-formatted files).
2. If there are minor changes worth noting, merge them into a single "Minor changes" slide at the END of the slides array. Otherwise omit them entirely.
3. FOCUS slides on: system design decisions, algorithmic complexity, state management, API surface changes, security implications, error handling patterns.
4. In reviewFocus, be more opinionated — call out what actually matters, not just what changed. Flag risks, trade-offs, and design choices the reviewer should push back on.
`;

// ── Helpers ──────────────────────────────────────────────────────

/** Strip markdown fences or surrounding text, returning just the JSON object. */
function extractJson(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

function validateReviewGuide(obj: unknown): obj is ReviewGuide {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.prTitle === 'string' &&
    typeof o.summary === 'string' &&
    typeof o.riskLevel === 'string' &&
    Array.isArray(o.slides)
  );
}

// ── Main entry point ─────────────────────────────────────────────

export async function generateReviewGuide(
  contextPackage: string,
  prUrl: string,
  providerName: Provider,
  model: ModelId,
  instructions?: string,
  onChunk?: (chunk: string, isThinking: boolean) => void,
  thinking: boolean = false,
  signalBoost: boolean = false,
  mcpConfigPath?: string,
  allowedTools?: string[]
): Promise<ReviewGuide> {
  const provider = getProvider(providerName);

  async function attempt(extraInstruction: string = ''): Promise<ReviewGuide> {
    const customInstructions = instructions?.trim();
    const userMessage = customInstructions
      ? contextPackage +
        USER_SUFFIX +
        extraInstruction +
        `\n\n<reviewer_instructions>\nThe reviewer has provided custom instructions that MUST take priority over default style guidelines.\n${customInstructions}\n</reviewer_instructions>`
      : contextPackage + USER_SUFFIX + extraInstruction;

    const baseSystem = signalBoost ? `${SIGNAL_BOOST_DIRECTIVE}\n${SYSTEM_PROMPT}` : SYSTEM_PROMPT;

    const system = customInstructions
      ? `${baseSystem}\n\nIMPORTANT — CUSTOM REVIEWER INSTRUCTIONS:\nThe reviewer has provided the following instructions. These take precedence over the default writing style and tone guidelines above. Adapt your narrative, reviewFocus, summary, and all prose fields accordingly.\n\n<instructions>\n${customInstructions}\n</instructions>`
      : baseSystem;

    const totalInputChars = system.length + userMessage.length;
    const estimatedTokens = Math.ceil(totalInputChars / 4);
    console.log('[agent] Custom instructions:', customInstructions ?? '(none)');
    console.log(
      `[agent] Input size: system=${system.length} + user=${userMessage.length} = ${totalInputChars} chars (~${estimatedTokens.toLocaleString()} tokens)`
    );
    console.log(`[agent] Calling ${providerName} (${model})...`);
    const fullText = await provider.generate({
      content: userMessage,
      systemPrompt: system,
      model,
      thinking,
      onChunk,
      mcpConfigPath,
      allowedTools,
    });
    console.log('[agent] Generation complete, parsing response...');

    const jsonText = extractJson(fullText);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      throw new Error(`JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!validateReviewGuide(parsed)) {
      throw new Error('Response is missing required fields (prTitle, summary, riskLevel, slides)');
    }

    parsed.prUrl = prUrl;
    return parsed;
  }

  try {
    return await attempt();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';

    // Don't retry on errors where retrying won't help
    if (msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('prompt is too long')) {
      throw new Error(msg);
    }

    console.warn(`[agent] First attempt failed (${msg}), retrying concisely`);
    try {
      return await attempt(CONCISE_SUFFIX);
    } catch (retryErr) {
      throw new Error(
        `AI review generation failed after retry: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
      );
    }
  }
}
