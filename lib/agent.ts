import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import type { ReviewGuide } from './types';

// ── Claude binary resolution ─────────────────────────────────────
// When launched from Dock/Finder the app gets a minimal PATH that
// won't include npm/homebrew/volta/nvm bin dirs. Ask the login shell
// once so the user's full profile is sourced, then cache the result.

let resolvedClaudePath: string | null = null;

function resolveClaudePath(): string {
  if (resolvedClaudePath) return resolvedClaudePath;

  if (process.platform === 'win32') {
    try {
      const result = execFileSync('where.exe', ['claude'], { encoding: 'utf-8', timeout: 5000 }).trim().split('\n')[0].trim();
      if (result) return (resolvedClaudePath = result);
    } catch { /* fall through */ }
  } else {
    for (const shell of ['/bin/zsh', '/bin/bash']) {
      if (!fs.existsSync(shell)) continue;
      try {
        const result = execFileSync(shell, ['-lc', 'which claude'], { encoding: 'utf-8', timeout: 5000 }).trim();
        if (result) return (resolvedClaudePath = result);
      } catch { /* try next */ }
    }
  }

  // Common install locations as a fast fallback
  const home = os.homedir();
  const candidates = [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    `${home}/.volta/bin/claude`,
    `${home}/.npm-global/bin/claude`,
    `${home}/.nvm/current/bin/claude`,
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return (resolvedClaudePath = p);
  }

  // Last resort — let spawn try PATH as-is
  return (resolvedClaudePath = 'claude');
}

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
- Use backtick notation for code symbols: \`symbolName\`

REVIEW FOCUS: Write 2–4 numbered points, each a short actionable check.
- "1) Check that ... 2) Verify that ..."
- Each point should be a single clear sentence
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

When generating diffHunks.content, include 10 lines of context before and after each change. Draw from the file contents if the diff context is shorter.

You must respond with valid JSON matching the ReviewGuide schema exactly. No markdown, no explanation outside the JSON.`;

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

const MODEL_IDS = {
  opus:   'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
} as const;

function callClaudeCLI(
  userContent: string,
  systemPrompt: string,
  model: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const claudePath = resolveClaudePath();
    const proc = spawn(claudePath, [
      '-p',
      '--model', model,
      '--system-prompt', systemPrompt,
      '--tools', '',
      '--output-format', 'text',
      '--no-session-persistence',
    ], { env });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(new Error(
          `Claude Code CLI not found at "${claudePath}". ` +
          'Install it from claude.ai/code and authenticate with `claude auth`.',
        ));
      } else {
        reject(err);
      }
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.stdin.write(userContent);
    proc.stdin.end();

    proc.on('close', (code: number | null) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr.slice(0, 300)}`));
      }
    });
  });
}

function extractJson(text: string): string {
  // Try to strip markdown code fences if present
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fenceMatch) return fenceMatch[1];
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

const CONCISE_SUFFIX = `

IMPORTANT: Be concise. Keep narrative and reviewFocus under 2 sentences each. Omit contextSnippets entirely (use empty arrays). Limit diffHunks to the 3 most important hunks per slide. Return only raw JSON starting with { and ending with }.`;

export async function generateReviewGuide(
  contextPackage: string,
  prUrl: string,
  model: 'opus' | 'sonnet' = 'opus',
  instructions?: string,
): Promise<ReviewGuide> {
  const modelId = MODEL_IDS[model];

  async function attempt(extraInstruction: string = ''): Promise<{ guide: ReviewGuide; truncated: boolean }> {
    const userMessage = contextPackage + USER_SUFFIX + extraInstruction;

    const system = instructions?.trim()
      ? `${SYSTEM_PROMPT}\n\nREVIEWER INSTRUCTIONS: ${instructions.trim()}`
      : SYSTEM_PROMPT;

    console.log('[agent] Calling Claude CLI...');
    const fullText = await callClaudeCLI(userMessage, system, modelId);
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

    (parsed as ReviewGuide).prUrl = prUrl;
    return { guide: parsed as ReviewGuide, truncated: false };
  }

  // First attempt
  let result: { guide: ReviewGuide; truncated: boolean };
  try {
    result = await attempt();
  } catch (err) {
    const isTruncated = err instanceof Error && err.message === 'truncated';
    console.warn(`[agent] First attempt failed (${isTruncated ? 'truncated' : 'parse error'}), retrying concisely`);
    try {
      result = await attempt(CONCISE_SUFFIX);
    } catch (retryErr) {
      throw new Error(
        `AI review generation failed after retry: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
      );
    }
  }

  // If first attempt succeeded but was truncated, retry concisely
  if (result.truncated) {
    console.warn('[agent] Response was truncated, retrying with concise instructions');
    try {
      result = await attempt(CONCISE_SUFFIX);
    } catch (retryErr) {
      throw new Error(
        `AI review generation failed after retry: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
      );
    }
  }

  return result.guide;
}
