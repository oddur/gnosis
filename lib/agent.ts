import { getProvider } from './provider';
import type { AIReviewGuide, ModelId, PlannerOutput, Provider, WriterSlideOutput } from './types';

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

REVIEW CHECKS (structured): Also produce a reviewChecks array with the same items as reviewFocus but in structured form.
- Each entry has "text" (the check sentence), plus optional "filePath" and "startLine" to pinpoint where the reviewer should look.
- filePath must exactly match one of the diffHunks[].filePath values on the same slide.
- startLine is the new-file line number (right side) within one of that file's hunk ranges.
- If a check is general and doesn't reference a specific line, set filePath and startLine to null.

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

SLIDE IMPORTANCE: Classify each slide's importance for the reviewer:
- "critical" = changes to auth, security, data integrity, public API contracts, payment/billing logic, or anything where a bug would cause data loss or a security vulnerability
- "important" = core business logic, new features, significant refactors, changes to error handling or validation
- "minor" = config files, documentation, test boilerplate, import reordering, whitespace cleanup, dependency bumps, generated code. These slides may start collapsed so the reviewer can focus on what matters first.

You are given:
- <full_diff>: the complete unified diff with expanded context (up to 15 lines around each change)
- <hunk_index>: a list of all diff hunks with unique IDs, file paths, and change counts
- <file_contents_before>: full file contents at base ref (before the PR)
- <file_contents_after>: full file contents at head ref (after the PR)
- <neighbor_files>: files imported by the changed files
- <excluded_files> (if present): files that were changed but excluded from the diff because they are generated or low-value (e.g. lock files, minified assets). Mention these in the relevant slide's narrative — for example, if a lock file was excluded, note it alongside the dependency manifest changes. Include excluded files in the "affectedFiles" array of the relevant slide. Do NOT create a separate slide just for excluded files.

Use file_contents_before and file_contents_after to understand the full shape of each changed file, not just the lines in the diff. Reference surrounding functions, types, and patterns when writing narratives to give the reviewer genuine codebase context.

HUNK ASSIGNMENT: The <hunk_index> lists all diff hunks with unique IDs. For each slide, assign relevant hunk IDs to "diffHunkIds". Rules:
- Each hunk ID must appear in exactly one slide
- Every hunk ID must be assigned to some slide
- If a hunk doesn't fit a specific slide, include it in a final "Other changes" slide
- Order IDs within each slide by file path (alphabetical), then hunk number (ascending)
- Do NOT generate diff content — just reference hunks by ID

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
      "reviewFocus": string | null,
      "diffHunkIds": ["hunk-0", "hunk-3", ...],
      "contextSnippets": string[],
      "affectedFiles": string[],
      "dependsOn": string[],
      "mermaidDiagram": string | null,
      "importance": "critical" | "important" | "minor",
      "reviewChecks": [
        {
          "text": string,
          "filePath": string | null,
          "startLine": number | null
        }
      ]
    }
  ]
}`;

const CONCISE_SUFFIX = `

IMPORTANT: Be concise. Keep narrative and reviewFocus under 2 sentences each. Omit contextSnippets entirely (use empty arrays). Limit diffHunkIds to the 5 most important hunk IDs per slide. Return only raw JSON starting with { and ending with }.`;

const WEB_RESEARCH_DIRECTIVE = `
WEB RESEARCH MODE — ACTIVE
You have access to web search and fetch tools. Before producing the review guide:
1. Identify frameworks, libraries, and APIs referenced in the code
2. Search for their official documentation, migration guides, or changelogs when relevant
3. Look up best practices or known issues for patterns used in the PR
4. Use this research to enrich your narratives with accurate technical context

Include every URL you consulted in the "webSources" array. Each entry needs "url" and "title".
`;

const FOCUS_DIRECTIVE = `
REVIEW FOCUS RULES
Apply these rules on top of all other guidelines:

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

function validateAIReviewGuide(obj: unknown): obj is AIReviewGuide {
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
  mcpConfigPath?: string,
  allowedTools?: string[],
  reviewSuggestions: boolean = true,
  webResearch: boolean = false,
  onToolUse?: (toolName: string) => void,
  onPromptReady?: (system: string, userMessage: string) => void,
  signal?: AbortSignal
): Promise<AIReviewGuide> {
  const provider = getProvider(providerName);

  async function attempt(extraInstruction: string = ''): Promise<AIReviewGuide> {
    const customInstructions = instructions?.trim();
    const webSourcesSchema = webResearch ? `,\n  "webSources": [{ "url": string, "title": string }, ...]` : '';
    const userMessage = customInstructions
      ? contextPackage +
        USER_SUFFIX.replace('\n}', `${webSourcesSchema}\n}`) +
        extraInstruction +
        `\n\n<reviewer_instructions>\nThe reviewer has provided custom instructions that MUST take priority over default style guidelines.\n${customInstructions}\n</reviewer_instructions>`
      : contextPackage + USER_SUFFIX.replace('\n}', `${webSourcesSchema}\n}`) + extraInstruction;

    const reviewSuggestionsDirective = reviewSuggestions
      ? ''
      : `\nREVIEW SUGGESTIONS DISABLED: The reviewer has turned off review suggestions. Set "reviewFocus" to null for every slide. Do not generate any review focus content.\n`;

    const webResearchDirective = webResearch ? WEB_RESEARCH_DIRECTIVE : '';

    // Signal boost is always on — deprioritize formatting and
    // import-only changes, emphasize design decisions.
    const baseSystem = `${FOCUS_DIRECTIVE}\n${webResearchDirective}${SYSTEM_PROMPT}${reviewSuggestionsDirective}`;

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
    onPromptReady?.(system, userMessage);
    const fullText = await provider.generate({
      content: userMessage,
      systemPrompt: system,
      model,
      thinking,
      onChunk,
      onToolUse,
      mcpConfigPath,
      allowedTools,
      signal,
    });
    console.log('[agent] Generation complete, parsing response...');

    const jsonText = extractJson(fullText);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      throw new Error(`JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!validateAIReviewGuide(parsed)) {
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

// ── Two-phase generation: Planner + Writers ──────────────────────

const PLANNER_SYSTEM = `You are a code review architect. Given a pull request's metadata and its diff hunk index, your job is to plan the review structure — grouping related hunks into logical topics and ordering them for optimal understanding.

ORDERING: Foundations first (types, interfaces, schemas) → implementations → consumers → tests → config/docs.

GROUPING: Group hunks that are logically related and should be understood together.
- A change to an interface and its implementation belong in the same topic
- Unrelated changes to the same file should be in different topics
- Refactoring and its tests are separate topics
- Trivial changes (whitespace, imports, formatting) should be merged into a single "Minor changes" topic at the end, or omitted entirely

STORY ARC: Write a 2-3 sentence narrative thread that connects all topics into a coherent story. This tells each slide writer how their topic fits into the bigger picture. Example: "This PR migrates the auth layer from session cookies to JWT tokens. The foundation is a new Token type and validation middleware, which the route handlers then adopt, followed by test updates."

NARRATIVE BRIEF per topic: Write a 1-2 sentence direction for each topic's slide writer. Explain what angle to take, what to emphasize, and how this topic relates to others. Example: "This introduces the core Token type that all subsequent auth changes depend on. Emphasize the design choices in the token structure and expiry handling."

RISK: Assess based on: auth/payment/data model changes = high; new features with tests = medium; refactoring with coverage = low; docs/config = low.

IMPORTANCE per topic:
- "critical" = auth, security, data integrity, public API contracts, payment/billing
- "important" = core logic, new features, significant refactors, error handling
- "minor" = config, docs, test boilerplate, import reordering, whitespace

Respond with valid JSON only. No explanation outside the JSON.`;

const PLANNER_USER_SUFFIX = `

Plan the review structure for this pull request. Group the hunks into logical topics and order them for optimal review flow.

Respond with JSON matching this schema exactly:
{
  "summary": string,
  "riskLevel": "low" | "medium" | "high",
  "riskRationale": string,
  "storyArc": string,
  "topics": [
    {
      "title": string,
      "slideType": "foundation" | "feature" | "refactor" | "bugfix" | "test" | "config" | "docs",
      "importance": "critical" | "important" | "minor",
      "hunkIds": ["hunk-0", "hunk-3", ...],
      "dependsOn": [],
      "order": 1,
      "narrativeBrief": string
    }
  ]
}`;

function validatePlannerOutput(obj: unknown): obj is PlannerOutput {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.summary === 'string' &&
    typeof o.riskLevel === 'string' &&
    Array.isArray(o.topics) &&
    o.topics.length > 0
  );
}

export async function planReview(
  hunkIndex: string,
  prMetadata: string,
  providerName: Provider,
  model: ModelId,
  onChunk?: (chunk: string, isThinking: boolean) => void,
  thinking: boolean = false,
  signal?: AbortSignal
): Promise<PlannerOutput> {
  const provider = getProvider(providerName);
  const userMessage = prMetadata + '\n' + hunkIndex + PLANNER_USER_SUFFIX;

  console.log(`[planner] Calling ${providerName} (${model}) with ${userMessage.length} chars...`);
  const fullText = await provider.generate({
    content: userMessage,
    systemPrompt: PLANNER_SYSTEM,
    model,
    thinking,
    onChunk,
    signal,
  });

  const jsonText = extractJson(fullText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Planner JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!validatePlannerOutput(parsed)) {
    throw new Error('Planner response missing required fields (summary, riskLevel, topics)');
  }

  return parsed;
}

// ── Writer: generates a single slide for one topic ──────────────

const WRITER_SYSTEM = `You are an expert code reviewer writing one slide of a guided code review. You are given a specific topic with its relevant diff hunks, file contents, and narrative direction from the review planner.

CONTEXT: You are writing ONE slide in a multi-slide review. The <story_arc> tells you the overall PR narrative. The <narrative_brief> tells you what angle to take for THIS slide. Follow these directions to maintain consistency across slides.

NARRATIVE: 2–4 short paragraphs. Lead with motivation, explain what changed, note anything non-obvious.
- Short sentences. Plain words. One idea per sentence.
- Use **bold** for emphasis, \`backticks\` for code symbols, markdown lists where helpful
- No headings — just bold, lists, inline code
- Reference how this topic connects to the broader PR story when relevant
- If this topic depends on earlier topics, briefly acknowledge what was established (e.g., "Building on the Token type introduced earlier...")

REVIEW FOCUS: 2–4 actionable checks as a markdown bullet list. Focus on what could go wrong.

REVIEW CHECKS: Same items as reviewFocus in structured form.
- "text" = the check sentence
- "filePath" must exactly match a file in the provided hunks
- "startLine" is the new-file line number within a hunk range
- Set filePath and startLine to null for general checks

MERMAID DIAGRAM: Include only when it genuinely helps understanding (sequence diagrams for flows, flowcharts for branching, class diagrams for data models). Keep small: 5–8 nodes max. Omit (null) when not useful.

Respond with valid JSON only. No explanation outside the JSON.`;

const WRITER_USER_SUFFIX = `

Write the slide content for this topic. Respond with JSON matching this schema exactly:
{
  "narrative": string,
  "reviewFocus": string | null,
  "contextSnippets": string[],
  "mermaidDiagram": string | null,
  "reviewChecks": [
    {
      "text": string,
      "filePath": string | null,
      "startLine": number | null
    }
  ]
}`;

function validateWriterOutput(obj: unknown): obj is WriterSlideOutput {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return typeof o.narrative === 'string';
}

export async function generateSlide(
  topicContext: string,
  providerName: Provider,
  model: ModelId,
  instructions?: string,
  reviewSuggestions: boolean = true,
  onChunk?: (chunk: string, isThinking: boolean) => void,
  thinking: boolean = false,
  signal?: AbortSignal
): Promise<WriterSlideOutput> {
  const provider = getProvider(providerName);

  const reviewSuggestionsDirective = reviewSuggestions
    ? ''
    : '\nSet "reviewFocus" to null. Do not generate review focus content.\n';

  let system = WRITER_SYSTEM + reviewSuggestionsDirective;
  if (instructions?.trim()) {
    system += `\n\nCUSTOM REVIEWER INSTRUCTIONS (take precedence over style guidelines):\n${instructions.trim()}`;
  }

  const userMessage = topicContext + WRITER_USER_SUFFIX;

  const fullText = await provider.generate({
    content: userMessage,
    systemPrompt: system,
    model,
    thinking,
    onChunk,
    signal,
  });

  const jsonText = extractJson(fullText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Writer JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!validateWriterOutput(parsed)) {
    throw new Error('Writer response missing required fields (narrative)');
  }

  return parsed;
}
