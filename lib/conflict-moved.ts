import { diffArrays } from 'diff';
import { identifierPattern, parseConflicts, textLines as lines } from './conflict-blocks';
import type { ConflictFile, ConflictProposal } from './conflict-resolution';
import { languageFamily, matchMoves, type FilePrints, type SymbolMove } from './moved-symbols';
import { MOVE_LANGUAGES } from './moved-symbols-plan';
import { syntaxLanguage, type SyntaxLanguage } from './syntax-scope';

/**
 * One side moved or renamed a function and the other edited it (#445 item 17). Git sees a deletion against an edit;
 * the right result is the moved function with the other side's edit. The move is found with the moved-symbol matcher
 * (lib/moved-symbols.ts, #438) on the ancestor and the moving side, and the edit is applied at the new place.
 *
 * Only a proposal, and only when nothing is in doubt:
 * - the matcher finds the move on the moving side, with the same body (its name aside) and the same comments, and no
 *   other move in the file takes an edit too: one source, one target;
 * - the other side changed lines inside the definition only, and the moving side changed none of those lines or the
 *   lines next to them (a rename changes only the lines with the name);
 * - each conflict left open is at the definition, where it was or where it went, and together they hold exactly the
 *   other side's edits to the definition, and nothing else of that side's;
 * - the moved copy is in the merged text exactly once.
 *
 * The result is a whole-file proposal (`wholeFile`, source 'moved'): it changes lines outside Git's conflicts. The
 * checks (lib/conflict-verify.ts verifyWholeFile) never Merge it; it is in Check when it parses and passes the line
 * accounting, with the note that call sites in other files were not checked. Anything else proposes nothing, and the
 * conflicts stay with Git's markers, to decide.
 */

/** The fingerprints of the candidates that `after` adds and removes against `before` (lib/syntax-scope.ts symbols). */
export type ReadPrints = (language: SyntaxLanguage, before: string, after: string) => Promise<FilePrints>;

const SIDE_NAMES = { ours: 'The PR', theirs: 'Main' } as const;
const OTHER_NAMES = { ours: 'the PR', theirs: 'main' } as const;

/** A change of `after` against `before`: lines [b0, b1) of before replaced by lines [a0, a1) of after. */
interface Hunk {
  b0: number;
  b1: number;
  a0: number;
  a1: number;
}
function hunks(before: readonly string[], after: readonly string[]): Hunk[] {
  const found: Hunk[] = [];
  let [b, a] = [0, 0];
  let open: Hunk | undefined;
  for (const part of diffArrays([...before], [...after])) {
    const n = part.count;
    if (!part.added && !part.removed) {
      open = undefined;
      b += n;
      a += n;
      continue;
    }
    if (!open) found.push((open = { b0: b, b1: b, a0: a, a1: a }));
    if (part.removed) open.b1 = b += n;
    else open.a1 = a += n;
  }
  return found;
}
/** The lines a diff removes and adds, as a multiset key. */
function changeKey(pairs: readonly (readonly [readonly string[], readonly string[]])[]) {
  const removed: string[] = [];
  const added: string[] = [];
  for (const [before, after] of pairs)
    for (const h of hunks(before, after)) {
      removed.push(...before.slice(h.b0, h.b1));
      added.push(...after.slice(h.a0, h.a1));
    }
  return `${removed.sort().join('\u0000')}\u0001${added.sort().join('\u0000')}`;
}
/** Where `part` (whole lines) starts in `whole`, each time. */
function occurrences(whole: readonly string[], part: readonly string[]) {
  const found: number[] = [];
  if (!part.length) return found;
  for (let i = 0; i + part.length <= whole.length; i++)
    if (part.every((line, k) => whole[i + k] === line)) found.push(i);
  return found;
}
const words = (text: string, name: string) => text.match(identifierPattern(name))?.length ?? 0;

/**
 * The moved definition with the other side's edit: the ancestor's body with both sides' changes, when they change
 * different lines with at least one unchanged line between. Undefined otherwise.
 */
function mergeBody(base: readonly string[], moved: readonly string[], edited: readonly string[]) {
  const mine = hunks(base, moved);
  const theirs = hunks(base, edited);
  if (!theirs.length) return undefined;
  const apart = (x: Hunk, y: Hunk) => x.b1 < y.b0 || y.b1 < x.b0;
  if (!mine.every((m) => theirs.every((e) => apart(m, e)))) return undefined;
  const all = [...mine.map((h) => ({ h, from: moved })), ...theirs.map((h) => ({ h, from: edited }))].sort(
    (x, y) => x.h.b0 - y.h.b0
  );
  const out: string[] = [];
  let at = 0;
  for (const { h, from } of all) {
    out.push(...base.slice(at, h.b0), ...from.slice(h.a0, h.a1));
    at = h.b1;
  }
  out.push(...base.slice(at));
  return out;
}

/** One way to read the file: `mover` moved `move`, and the other side edited it. Undefined when anything is in doubt. */
function plan(
  file: Pick<ConflictFile, 'base' | 'ours' | 'theirs' | 'original' | 'proposals'>,
  mover: 'ours' | 'theirs',
  move: SymbolMove
) {
  const editor = mover === 'ours' ? 'theirs' : 'ours';
  const base = lines(file.base);
  const moverLines = lines(file[mover]);
  const editorLines = lines(file[editor]);
  // 0-based, end exclusive: the definition in the ancestor, and where it is on the moving side.
  const [f0, f1] = [move.from.start - 1, move.from.end];
  const [t0, t1] = [move.to.start - 1, move.to.end];
  const baseBody = base.slice(f0, f1);
  const movedBody = moverLines.slice(t0, t1);
  if (!baseBody.length || !movedBody.length) return undefined;
  // The other side's changes: each wholly inside the definition, or wholly outside it.
  let before = 0;
  let inside = 0;
  for (const h of hunks(base, editorLines)) {
    const delta = h.a1 - h.a0 - (h.b1 - h.b0);
    const empty = h.b0 === h.b1;
    const within = empty ? h.b0 > f0 && h.b0 < f1 : h.b0 >= f0 && h.b1 <= f1;
    const ahead = empty ? h.b0 <= f0 : h.b1 <= f0;
    const after = empty ? h.b0 >= f1 : h.b0 >= f1;
    if (within) inside += delta;
    else if (ahead) before += delta;
    else if (!after) return undefined;
  }
  const editedBody = editorLines.slice(f0 + before, f1 + before + inside);
  if (editedBody.join('') === baseBody.join('')) return undefined;
  const merged = mergeBody(baseBody, movedBody, editedBody);
  if (!merged) return undefined;
  // The open conflicts hold exactly the other side's edits to the definition: nothing of its elsewhere is dropped.
  const segments = parseConflicts(file.original);
  const open = segments.flatMap((s) => (s.kind === 'conflict' && !file.proposals?.[s.index] ? [s] : []));
  if (!open.length || open.some((s) => s.block.base === undefined || !s.block.base.trim())) return undefined;
  // Each open conflict is at the definition: its ancestor lines where the definition was, or its moving side's lines
  // where the definition went, found once. Equal edits elsewhere in the file are not this definition's.
  const overlaps = (whole: readonly string[], part: readonly string[], from: number, to: number) => {
    const found = occurrences(whole, part);
    return found.length === 1 && found[0] < to && found[0] + part.length > from;
  };
  const placed = (s: (typeof open)[number]) =>
    overlaps(base, lines(s.block.base ?? ''), f0, f1) || overlaps(moverLines, lines(s.block[mover]), t0, t1);
  if (!open.every(placed)) return undefined;
  const edits = changeKey(open.map((s) => [lines(s.block.base ?? ''), lines(s.block[editor])]));
  if (edits !== changeKey([[baseBody, editedBody]])) return undefined;
  // The merged text: the moving side's lines in the open conflicts, the other conflicts' proposals, and Git's text.
  const resolved = lines(
    segments.map((s) => (s.kind === 'text' ? s.text : (file.proposals?.[s.index]?.text ?? s.block[mover]))).join('')
  );
  const at = occurrences(resolved, movedBody);
  if (at.length !== 1 || occurrences(moverLines, movedBody).length !== 1) return undefined;
  const text = [...resolved.slice(0, at[0]), ...merged, ...resolved.slice(at[0] + movedBody.length)].join('');
  const [from, to] = [move.from.name, move.to.name];
  // A rename: the other side's lines must not bring the old name back where the moving side has none.
  if (from !== to && words(text, from) > words(file[mover], from)) return undefined;
  const what = from === to ? `moved ${from}` : `renamed ${from} to ${to} and moved it`;
  return { text, note: `${SIDE_NAMES[mover]} ${what}, and ${OTHER_NAMES[editor]} edited it.` };
}

/**
 * Whether the move rule could find anything, read from the text alone, before the worker parses anything: a language
 * the matcher reads, on, and an open conflict where one side removed most of the ancestor's lines, as a move does
 * where the definition was.
 */
export function mayHaveMove(
  file: Pick<ConflictFile, 'path' | 'original' | 'proposals' | 'unsupported'>,
  disabled: readonly SyntaxLanguage[] = []
) {
  const language = syntaxLanguage(file.path);
  if (!language || !MOVE_LANGUAGES.has(language) || disabled.includes(language) || file.unsupported) return false;
  return parseConflicts(file.original).some((s) => {
    if (s.kind !== 'conflict' || file.proposals?.[s.index] || s.block.base === undefined) return false;
    const base = lines(s.block.base).filter((line) => line.trim());
    if (!base.length) return false;
    return (['ours', 'theirs'] as const).some((side) => {
      const kept = lines(s.block[side]);
      const removed = base.filter((line) => {
        const at = kept.indexOf(line);
        if (at >= 0) kept.splice(at, 1);
        return at < 0;
      });
      return removed.length * 2 > base.length;
    });
  });
}

/**
 * The 'moved' proposal for a file whose conflicts structural merge left open, or undefined. `read` fingerprints the
 * moved-symbol candidates of one side against the ancestor, in the tree-sitter worker.
 */
export async function movedProposal(
  file: Pick<ConflictFile, 'path' | 'base' | 'ours' | 'theirs' | 'original' | 'proposals' | 'unsupported'>,
  read: ReadPrints
): Promise<ConflictProposal | undefined> {
  const language = syntaxLanguage(file.path);
  if (!language || !MOVE_LANGUAGES.has(language) || file.unsupported) return undefined;
  const texts = [file.base, file.ours, file.theirs, file.original];
  // Plain LF text that ends in a line break: line endings are another merge's problem.
  if (texts.some((text) => text.includes('\r') || !text.endsWith('\n'))) return undefined;
  const segments = parseConflicts(file.original);
  if (!segments.some((s) => s.kind === 'conflict' && !file.proposals?.[s.index])) return undefined;
  const found: { text: string; note: string }[] = [];
  for (const mover of ['ours', 'theirs'] as const) {
    if (file[mover] === file.base) continue;
    const prints = await read(language, file.base, file[mover]);
    const result = matchMoves([
      { file: file.path, url: '', headSha: '', path: file.path, family: languageFamily(language), prints },
    ]);
    if (result.capped) return undefined;
    for (const move of result.moves) {
      if (move.from.side !== 'before' || move.to.side !== 'after') continue;
      // The same body, its name aside, with the same comments: any other change is the moving side's edit.
      if (!move.exact || move.commentsChanged) continue;
      const one = plan(file, mover, move);
      if (one) found.push(one);
    }
  }
  if (found.length !== 1) return undefined;
  return { source: 'moved', text: found[0].text, note: found[0].note };
}
