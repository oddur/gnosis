import type { DiffHunk, FileChangeSummary } from './types';

export const FILE_SUMMARY_DIRECTIVE = `
FILE HEADER SUMMARIES: Include fileSummaries with one entry per file whose diff hunks appear in this slide.
- filePath must exactly match the provided hunk's path, including any PR prefix. Never combine files from different PRs.
- summary is one plain-text sentence, at most 20 words and 160 characters, describing the concrete change to this file in THIS topic.
- Lead with the behavior or responsibility that changed. Name a specific symbol only when useful.
- Do not repeat the file name, topic title, or review advice. Do not use Markdown or speculate beyond the supplied code.
- If the same file appears in other topics, summarize only this topic's hunks. Omit files without enough evidence.
`;

/** Accept optional generated text without letting malformed output break a
 * review, attach to another stack member, or crowd the code header. */
export function normalizeFileSummaries(value: unknown, hunks: Pick<DiffHunk, 'filePath'>[]): FileChangeSummary[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(hunks.map((hunk) => hunk.filePath));
  const seen = new Set<string>();
  const result: FileChangeSummary[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.filePath !== 'string' ||
      typeof entry.summary !== 'string' ||
      !allowed.has(entry.filePath) ||
      seen.has(entry.filePath)
    )
      continue;
    const text = entry.summary.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const chars = Array.from(text);
    const summary = chars.length > 200 ? chars.slice(0, 197).join('').trimEnd() + '…' : text;
    result.push({ filePath: entry.filePath, summary });
    seen.add(entry.filePath);
  }
  return result;
}
