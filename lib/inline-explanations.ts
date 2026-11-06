import { parseDiffLines } from './diff-lines';
import { prepareReviewHunk } from './review-diff';
import type { DiffHunk, FileMetadata, InlineExplanation } from './types';

export const INLINE_EXPLANATION_DIRECTIVE = `
SELECTIVE INLINE INSIGHTS: Help the reviewer understand the mechanisms they would otherwise miss or have to reconstruct. Select for explanatory value, not for a target number of annotations.
READER: A developer who knows the language and ordinary programming patterns but is new to this subsystem. Explain local algorithms, ownership, ordering, state transitions, and contracts; do not teach syntax or hunt for obscure trivia.

Select the useful local insights before drafting the narrative, then substantiate, write, and prune them. Return only the final notes, not candidate questions or your selection process:
1. SELECT: Inspect the changed behavior for relationships a reader could miss: an operation that affects later cleanup, two sources of identity or state with different roles, an ordering requirement, a fallback with different guarantees, or a subtle algorithm step. Ask what the reader would misunderstand without tracing those connections. These are examples, not a checklist. Keep every distinct, well-supported insight needed to understand the topic; a complex topic can need several, while a straightforward change can need none.
2. SUBSTANTIATE: Trace the answer through the supplied source, including callers or consumers when the claim depends on them. Distinguish a condition for taking a fast path from a guarantee that the input is valid. Scope claims to the relevant branch, ownership state, or measurement interval. Do not infer author intent, speedups, safety, or end-to-end guarantees from a local operation. If evidence is missing, omit the claim; an actionable unresolved risk belongs in reviewChecks.
3. WRITE: Answer the reader's question by connecting the local mechanism to its consequence in concrete terms. Name the relevant state, identities, or operations so the note makes sense beside the code without requiring the narrative. Explain why this particular implementation works, what a result actually guarantees, or how separate steps interact. A small example or comparison can help, but do not invent a failure merely to make a note sound important.
Before keeping a note, compare it with a plain-language translation of its anchor. If both teach the same thing, remove the note. Keep the supported consequence or connection that requires reading beyond the statement. Do not manufacture importance by adding "ensures", "prevents", or "so that" to a paraphrase.
4. PRUNE AND PLACE: Read each note beside its anchor. Remove it if nearby code/comments already explain the same relationship, or if it repeats another note. Different wording is not a new insight. Keep a useful connection between facts even when each fact is already documented. Place the note immediately below the statement or completed expression that establishes the mechanism it explains; do not interrupt an expression to describe a result established later.

COORDINATE THE SURFACES: Plan these together. File summaries say what changed; the narrative explains overall purpose and flow; inline notes explain a specific local mechanism; reviewChecks identify unresolved risks; educationNotes define general concepts. A narrative may introduce an ownership rule while an inline note explains the exact check enforcing it. If the narrative repeats a selected local insight, shorten that part of the narrative and keep the detail beside the code. Do not write every mechanism into the narrative and then discard useful notes as duplicates.

TEST CODE: Explain a subtle fixture choice, the state it creates, and why that state distinguishes the intended behavior from an incorrect implementation. Do not routinely annotate what a test does NOT cover. Coverage limitations belong in the narrative or reviewChecks unless that boundary is essential to understanding the exact statement. A test repeating a production rule needs no second explanation unless its setup or assertion adds a distinct insight.

FINAL QUALITY AND COVERAGE CHECK: Would this note let the reader explain how the mechanism works, rather than just repeat what the code does? Is its causal claim supported by the source? Does it add something beyond nearby comments? Remove notes that fail these checks. Then check for non-obvious behavior left unexplained: include each useful local insight, even when a topic or file needs many notes or the anchors are close together. Identify consequential unknowns in reviewChecks rather than asserting them as facts.

Selection examples (only use an explanation when the supplied code supports it):
- KEEP: "A unique record can still hold shared component bytes. The second ownership check prevents an in-place update from changing a value retained by another reader." This connects two ownership layers.
- KEEP: "This early return rejects the fast path before the remaining fields are checked. The fallback merge must still validate them before updating storage." This explains the limited meaning of the result.
- OMIT: "The loop advances after a partial write so already-sent bytes are not sent again" when the adjacent comment already explains that exact behavior. Correctness alone does not justify another note.
- OMIT: "This avoids allocation and makes requests faster" when the code establishes only that one temporary allocation is removed. Do not turn an unmeasured benefit into a guarantee.
- OMIT: A straightforward rename, accessor, or test setup with no meaningful hidden relationship. Do not manufacture a question to fill the field.

OUTPUT AND ANCHOR RULES:
- Usefulness determines the number of notes. There is no quota, maximum count, or minimum line spacing. Combine notes only when they explain the same relationship; keep distinct insights even within the same block. Omit notes when the code is already clear.
- text: 1–2 short sentences, at most 45 words and 320 characters. Inline backticks for symbols are allowed; no headings, lists, links, or images.
- filePath: the exact provided diff path, including any PR prefix. Never mix stack members.
- line: an integer source line in a provided hunk. side: RIGHT for new/current code, LEFT for removed code. Notes appear immediately BELOW the anchor line: choose the key statement or the end of the relevant block.
- When the source has [L:n R:n] labels, copy the number for the chosen side. A dash means that side has no line. Labels are coordinates, not code; do not include them or the diff marker in code. Do not count lines yourself.
- code: copy the exact anchor line without the diff +/-/space marker (indentation may be omitted). The app verifies the path, side, line number, and quoted code. If you cannot confidently locate the note, omit it.
`;

/** Give the model the same coordinates used by the diff renderer, without duplicating source. */
export function numberExplanationDiffs(context: string): string {
  return context.replace(/<(diff_hunks|full_diff)>([\s\S]*?)<\/\1>/g, (_, tag: string, body: string) => {
    const output: string[] = [];
    let header = '';
    let pending: string[] = [];
    const flush = () => {
      if (!header) return;
      output.push(header);
      for (const line of parseDiffLines(header, pending.join('\n'))) {
        const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
        output.push(`[L:${line.baseLineNumber ?? '-'} R:${line.headLineNumber ?? '-'}] ${prefix}${line.text}`);
      }
      header = '';
      pending = [];
    };
    for (const line of body.split('\n')) {
      if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
        flush();
        header = line;
      } else if (
        /^diff --git /.test(line) ||
        /^--- .* \((?:added|modified|deleted|renamed)\) \[hunk-\d+\]$/.test(line)
      ) {
        flush();
        output.push(line);
      } else if (header) {
        if (line.startsWith('\\ No newline at end of file')) continue;
        pending.push(line);
      } else output.push(line);
    }
    flush();
    return `<${tag}>${output.join('\n')}\n</${tag}>`;
  });
}

/** Saved notes remain pinned to their saved coordinates. Never relocate them when loading a review. */
export function normalizeInlineExplanations(
  value: unknown,
  hunks: DiffHunk[],
  files: Pick<FileMetadata, 'filename' | 'status'>[] = []
): InlineExplanation[] {
  return resolveInlineExplanations(value, hunks, files, false);
}

/** Only for fresh model output: repair a wrong number when exact code has one unambiguous location. */
export function resolveGeneratedInlineExplanations(
  value: unknown,
  hunks: DiffHunk[],
  files: Pick<FileMetadata, 'filename' | 'status'>[] = []
): InlineExplanation[] {
  return resolveInlineExplanations(value, hunks, files, true);
}

function resolveInlineExplanations(
  value: unknown,
  hunks: DiffHunk[],
  files: Pick<FileMetadata, 'filename' | 'status'>[],
  repairLine: boolean
): InlineExplanation[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  const status = new Map(files.map((file) => [file.filename, file.status]));
  const source = new Map<
    string,
    { filePath: string; side: 'LEFT' | 'RIGHT'; line: number; changed: boolean; codes: Set<string> }
  >();
  for (const hunk of hunks) {
    for (const line of prepareReviewHunk(hunk, status.get(hunk.filePath))?.lines ?? []) {
      for (const side of ['LEFT', 'RIGHT'] as const) {
        const number = side === 'LEFT' ? line.baseLineNumber : line.headLineNumber;
        if (number == null) continue;
        const key = JSON.stringify([hunk.filePath, side, number]);
        const code = line.text.trim();
        const changed = line.type !== 'context';
        const previous = source.get(key);
        // Expanded saved hunks can contain stale neighboring context. An explicit
        // addition/deletion owns that coordinate; equal-priority conflicts stay ambiguous.
        if (!previous || (changed && !previous.changed)) {
          source.set(key, { filePath: hunk.filePath, side, line: number, changed, codes: new Set([code]) });
        } else if (changed === previous.changed) previous.codes.add(code);
      }
    }
  }
  const positions = new Map<string, Set<number>>();
  if (repairLine)
    for (const entry of source.values()) {
      for (const code of entry.codes) {
        const key = JSON.stringify([entry.filePath, entry.side, code]);
        const lines = positions.get(key) ?? new Set<number>();
        lines.add(entry.line);
        positions.set(key, lines);
      }
    }
  const matches = (filePath: string, side: string, line: number, code: string) => {
    const entry = source.get(JSON.stringify([filePath, side, line]));
    return entry?.codes.size === 1 && entry.codes.has(code);
  };
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
    let line = entry.line as number;
    const code = entry.code.trim();
    const text = entry.text.replace(/\s+/g, ' ').trim();
    if (!code || !text || text.length > 320 || text.split(/\s+/).length > 45 || texts.has(text.toLowerCase())) continue;
    if (!matches(filePath, side, line, code)) {
      if (!repairLine || code.length < 8 || !/[\p{L}_$]/u.test(code)) continue;
      const locations = positions.get(JSON.stringify([filePath, side, code]));
      if (locations?.size !== 1) continue;
      const [resolved] = locations;
      if (!matches(filePath, side, resolved, code)) continue;
      line = resolved;
    }
    result.push({ filePath, line, side, code, text });
    texts.add(text.toLowerCase());
  }
  return result;
}
