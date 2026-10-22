import { prepareReviewHunk } from './review-diff';
import type { DiffHunk, FileMetadata, InlineExplanation } from './types';

export const INLINE_EXPLANATION_DIRECTIVE = `
SELECTIVE INLINE EXPLANATIONS: Write sparse inlineExplanations where a short note beside the code saves the reviewer real reasoning.
- First identify any mechanism a competent reviewer could misread from the local syntax. If there is no such mechanism, return an empty array. If there is a clear high-value mechanism, explain it at the decisive line instead of burying all implementation detail in the narrative.
- Most topics need zero or one note. Never fill a quota or annotate every file/function.
- Include a note ONLY for a non-obvious invariant, algorithm step, state transition, ordering constraint, failure/recovery path, or cross-file contract supported by the supplied code.
- Apply this test: would a competent developer learn something beyond what the nearby code, its existing comments, and the file summary already say? If not, omit it.
- Explain the mechanism and its consequence, not the syntax. Do not narrate assignments, imports, accessors, obvious guards, ordinary loops, straightforward CRUD, formatting, or test boilerplate.
- Divide the explanation between surfaces: the narrative covers overall purpose and flow; inline notes explain the local mechanism at the exact statement where a reader needs it. Do not suppress a useful local explanation merely because the narrative discusses the broader behavior.
- Do not copy sentences from the narrative or paraphrase the file summary, existing code comments, or another annotation. Review concerns/questions belong in reviewChecks, not here. Do not invent intent or guarantees.
- Useful: "Recording the generation before awaiting prevents a late response from replacing newer results." Noise: "This stores the generation number." A subtle language/runtime interaction deserves a local note; an obvious operation does not.
- At most 3 notes per topic and 2 per file. One note per conceptual block; keep notes at least 8 lines apart on the same side. Choose only the highest-value insights.
- text: 1–2 short sentences, at most 45 words and 320 characters. Inline backticks for symbols are allowed; no headings, lists, links, or images.
- filePath: the exact provided diff path, including any PR prefix. Never mix stack members.
- line: an integer source line in a provided hunk. side: RIGHT for new/current code, LEFT for removed code. Notes appear immediately BELOW the anchor line: choose the key statement or the end of the relevant block.
- code: copy the exact anchor line without the diff +/-/space marker (indentation may be omitted). The app verifies the path, side, line number, and quoted code. If you cannot confidently locate the note, omit it.
`;

/** Optional model output must never mislabel source or turn a diff into a wall of notes. */
export function normalizeInlineExplanations(
  value: unknown,
  hunks: DiffHunk[],
  files: Pick<FileMetadata, 'filename' | 'status'>[] = []
): InlineExplanation[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  const status = new Map(files.map((file) => [file.filename, file.status]));
  const source = new Map<string, string>();
  for (const hunk of hunks) {
    for (const line of prepareReviewHunk(hunk, status.get(hunk.filePath))?.lines ?? []) {
      if (line.baseLineNumber != null)
        source.set(JSON.stringify([hunk.filePath, 'LEFT', line.baseLineNumber]), line.text.trim());
      if (line.headLineNumber != null)
        source.set(JSON.stringify([hunk.filePath, 'RIGHT', line.headLineNumber]), line.text.trim());
    }
  }
  const result: InlineExplanation[] = [];
  const texts = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue;
    const entry = candidate as Record<string, unknown>;
    if (
      typeof entry.filePath !== 'string' ||
      !Number.isSafeInteger(entry.line) ||
      (entry.line as number) < 1 ||
      (entry.side !== 'LEFT' && entry.side !== 'RIGHT') ||
      typeof entry.code !== 'string' ||
      typeof entry.text !== 'string'
    )
      continue;
    const { filePath, side } = entry;
    const line = entry.line as number;
    const code = entry.code.trim();
    const text = entry.text.replace(/\s+/g, ' ').trim();
    if (
      !code ||
      !text ||
      text.length > 320 ||
      text.split(/\s+/).length > 45 ||
      source.get(JSON.stringify([filePath, side, line])) !== code ||
      texts.has(text.toLowerCase())
    )
      continue;
    const sameFile = result.filter((note) => note.filePath === filePath);
    if (sameFile.length >= 2 || sameFile.some((note) => note.side === side && Math.abs(note.line - line) < 8)) continue;
    result.push({ filePath, line, side, code, text });
    texts.add(text.toLowerCase());
    if (result.length === 3) break;
  }
  return result;
}
