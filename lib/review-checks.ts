import type { DiffHunk, ReviewCheck, Slide } from './types';

// Shared "what to check" logic. SlideView renders checks and the
// all-checks prompt serializes them; both must agree on how a slide's
// checks are derived (structured vs reviewFocus fallback, prose
// splitting, anchor validation) or the copied prompt drifts from what
// the reviewer sees on screen. Keep every rule here, import from both.

// A loose heuristic for "this single string is actually multiple
// bullets jammed together". The model sometimes returns one long
// reviewFocus or one single reviewCheck that contains its own
// markdown list. If that happens, we want to render it as a list
// instead of a wall of text.
export function looksLikePackedList(text: string): boolean {
  // Markdown bullets on their own line.
  if (/\n\s*[-*]\s+/.test(text)) return true;
  // Numbered list items on their own line.
  if (/\n\s*\d+[.)]\s+/.test(text)) return true;
  return false;
}

// Try to split a prose check into its constituent sentences so a
// model-emitted "one giant check with three topics" renders as
// bullets instead of a paragraph. Splits on sentence terminators
// (`.`, `?`, `!`) followed by whitespace then a capital letter or
// a backtick (next sentence starts with an identifier). Only returns
// multiple segments when each is a reasonable bullet length — under
// 20 chars is probably noise, over 500 is a tell the split picked
// the wrong boundary.
export function splitIntoProseChecks(text: string): string[] {
  if (!text) return [];
  const trimmed = text.trim();
  const parts = trimmed.split(/(?<=[.?!])\s+(?=[A-Z`])/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return [trimmed];
  if (parts.some((p) => p.length < 20 || p.length > 500)) return [trimmed];
  return parts;
}

// Build the set of `{filePath}:{newFileLine}` + `{filePath}:{oldFileLine}`
// keys that any review check could resolve to inside this slide's
// hunks. Used to pre-filter anchors so neither surface presents a
// `file:line` that doesn't exist in the slide's diff. Parses
// hunk headers directly (`@@ -baseStart,baseCount +headStart,headCount @@`)
// rather than walking rendered lines — much cheaper.
export function buildAnchorableSet(hunks: DiffHunk[]): Set<string> {
  const keys = new Set<string>();
  for (const hunk of hunks) {
    const m = hunk.hunkHeader.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!m) continue;
    const baseStart = parseInt(m[1], 10);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- regex optional groups can be undefined at runtime
    const baseCount = m[2] !== undefined ? parseInt(m[2], 10) : 1;
    const headStart = parseInt(m[3], 10);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- regex optional groups can be undefined at runtime
    const headCount = m[4] !== undefined ? parseInt(m[4], 10) : 1;
    for (let i = 0; i < headCount; i++) keys.add(`${hunk.filePath}:${headStart + i}`);
    for (let i = 0; i < baseCount; i++) keys.add(`${hunk.filePath}:${baseStart + i}`);
  }
  return keys;
}

// A check's anchor only counts when the `{filePath, line}` actually
// resolves to a line inside this slide's hunks. Prevents silent no-op
// clicks (SlideView) and wrong-location hints in agent prompts on
// hallucinated or out-of-slide anchors.
export function isAnchorable(check: ReviewCheck, anchorable: Set<string>): boolean {
  if (!check.filePath || check.startLine == null || check.startLine <= 0) return false;
  return anchorable.has(`${check.filePath}:${check.startLine}`);
}

/** One flattened "What to check" bullet, anchor already validated. */
export interface DerivedCheck {
  text: string;
  filePath?: string | null;
  startLine?: number | null;
}

/**
 * Flatten a slide's "What to check" content into the same bullets
 * SlideView renders: structured reviewChecks when present, prose-split
 * when a single check or the reviewFocus fallback packs several topics
 * into one string. Anchors are included only when they resolve into the
 * slide's own hunks.
 */
export function deriveSlideChecks(slide: Slide): DerivedCheck[] {
  const anchorable = buildAnchorableSet(slide.diffHunks);
  const anchorFor = (check: ReviewCheck): Partial<DerivedCheck> =>
    isAnchorable(check, anchorable) ? { filePath: check.filePath, startLine: check.startLine } : {};

  const checks = slide.reviewChecks ?? [];
  if (checks.length > 1) {
    return checks.map((c) => ({ text: c.text.trim(), ...anchorFor(c) }));
  }
  if (checks.length === 1) {
    const check = checks[0];
    const split =
      looksLikePackedList(check.text) || check.text.length > 180
        ? splitIntoProseChecks(check.text)
        : [check.text];
    return split.map((text) => ({ text: text.trim(), ...anchorFor(check) }));
  }

  // Fallback: reviewFocus prose, same splitting rules, never anchored.
  const focus = (slide.reviewFocus ?? '').trim();
  if (!focus) return [];
  const split =
    looksLikePackedList(focus) || focus.length > 180 ? splitIntoProseChecks(focus) : [focus];
  return split.map((text) => ({ text: text.trim() }));
}

/**
 * Human/agent-readable form of `review.prUrl`. GitHub URLs pass
 * through; the internal `local:/abs/path#base..head` pseudo-URL for
 * local-repo reviews (see lib/localGit.ts) is rewritten so an agent
 * gets a usable repo path + ref range instead of a fake URL.
 */
export function formatReviewSource(prUrl: string): string {
  if (!prUrl.startsWith('local:')) return prUrl;
  const hashIdx = prUrl.lastIndexOf('#');
  const repoPath = hashIdx === -1 ? prUrl.slice('local:'.length) : prUrl.slice('local:'.length, hashIdx);
  const range = hashIdx === -1 ? '' : prUrl.slice(hashIdx + 1);
  return range
    ? `local repository at ${repoPath} (diff ${range})`
    : `local repository at ${repoPath}`;
}

// Turn a review check into a ready-to-paste agent prompt. The agent
// gets the bare question plus enough pointers to find the code, so
// the user can paste into Claude Code / Cursor / similar and have it
// investigate without further explanation. The verdict vocabulary
// (valid / handled / unclear) is shared with buildAllChecksPrompt so
// per-check and bulk copies ask for the same thing.
export function buildAgentPrompt(
  text: string,
  slideTitle: string,
  prUrl: string,
  filePath?: string | null,
  startLine?: number | null
): string {
  const lines = [
    'Please investigate this code-review check against the change and report whether the concern is valid, handled, or unclear, with file:line evidence.',
    '',
    `Check: ${text.trim()}`,
    '',
    `Slide: ${slideTitle}`,
    `Source: ${formatReviewSource(prUrl)}`,
  ];
  if (filePath) {
    lines.push(`Location: ${filePath}${startLine ? `:${startLine}` : ''}`);
  }
  return lines.join('\n');
}
