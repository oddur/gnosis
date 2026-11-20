import type * as TreeSitter from 'web-tree-sitter';
import { diffArrays } from 'diff';
import type { DefinitionKind, SyntaxDefinition, SyntaxLanguage } from './syntax-scope';
import { COMMENTS } from './semantic-noise';

/**
 * Moved and renamed symbols (#398): functions, methods and classes matched across files and positions by their
 * structure, so a symbol that moved shows as "Moved from a.ts:12", or "renamed from foo", and only its real edits
 * keep their change colour.
 *
 * Each changed file is read once, in the tree-sitter worker, from the same parse the other structure features use
 * (lib/syntax-scope.ts). A definition is a candidate when it is a function, method, class, struct, interface, trait,
 * impl or test, has at least `MIN_LINES` lines with code, and at least 80% of those lines are removed (on the old side)
 * or added (on the new side). Its fingerprint (`SymbolPrint`) is:
 * - its tokens in order, comments and whitespace left out, with its own name masked, so a rename keeps the hash and a
 *   recursive call does too;
 * - an exact hash of that token stream;
 * - a bottom-k sketch of its distinct token 4-grams, for a similarity estimate;
 * - one hash per line, of that line's tokens, to diff the old body against the new one.
 *
 * Matching (`matchMoves`) pairs removed candidates with added ones, per language family and kind group:
 * 1. Exact: the same hash on both sides, exactly one candidate on each side. A hash held by more than one candidate on
 *    either side (duplicated boilerplate, copies) is ambiguous and matches nothing, in either pass.
 * 2. Similar: the Jaccard similarity of the two 4-gram sets, for bodies of `MIN_SIMILAR_TOKENS` tokens or more whose
 *    token counts are within `SIZE_RATIO` of each other. A pair matches at `SAME_NAME` with the same name, and at the
 *    stricter `RENAMED` with another name, and only when it beats every other pair of either symbol by `MARGIN`: two
 *    near-equal candidates (overloads, sibling handlers) match nothing.
 * Larger symbols match first, and a match takes the symbols inside both ends with it: a moved class is one move, not
 * one per method. A symbol whose removed and added copies sit at the same place in the same file was edited in place,
 * not moved, and never matches.
 *
 * Work is bounded: at most `MAX_CANDIDATES` candidates per side and `MAX_PAIRS` similarity comparisons per PR. Past the
 * pair limit the similarity pass is dropped whole (exact matches stay), so a cut-off never leaves a match whose rival
 * went unseen.
 */

/** The kinds that can move, by the group they match within: a function can become a method, never a class. */
export const MOVE_GROUPS: Partial<Record<DefinitionKind, 'callable' | 'type' | 'test'>> = {
  function: 'callable',
  method: 'callable',
  class: 'type',
  struct: 'type',
  interface: 'type',
  trait: 'type',
  impl: 'type',
  test: 'test',
};
/** Grammars whose trees share token types: a JavaScript function moved into a TypeScript file still matches. */
export const languageFamily = (language: SyntaxLanguage) =>
  language === 'typescript' || language === 'tsx' || language === 'javascript' ? 'script' : language;

/** Lines with code a candidate needs: one-line and two-line definitions (getters, stubs) never match. */
export const MIN_LINES = 3;
/** Tokens a candidate needs for an exact match. A three-line getter is about 12. */
export const MIN_TOKENS = 40;
/** Tokens both sides need for a similarity match: small bodies change too much with one edit to compare. */
export const MIN_SIMILAR_TOKENS = 60;
/** Share of a candidate's lines with code that the diff must remove (old side) or add (new side). */
export const MIN_CHANGED = 0.8;
/** Jaccard similarity of 4-gram sets for a match under the same name, and under another name. */
export const SAME_NAME = 0.7;
export const RENAMED = 0.85;
/** How far a match's similarity must stand above either symbol's next best pair. */
export const MARGIN = 0.1;
/** Pairs below this similarity are not kept: they are neither matches nor rivals worth a margin. */
const FLOOR = 0.4;
/** The larger token count of a similarity pair is at most this many times the smaller. */
export const SIZE_RATIO = 1.5;
/**
 * Pairs this far apart in size are still compared, as rivals: a body's 4-gram Jaccard with one `r` times its size is
 * at most about 1/r, so past 1 / (SAME_NAME - MARGIN) a rival can never come within the margin of a match.
 */
const RIVAL_RATIO = 2;
/** Shingles kept per sketch. Bodies with fewer distinct 4-grams keep them all, and compare exactly. */
export const SKETCH = 256;
/** Candidates per file side, per side of a PR, and similarity comparisons per PR. */
export const MAX_FILE_CANDIDATES = 400;
export const MAX_CANDIDATES = 5000;
export const MAX_PAIRS = 60_000;
/** Bodies longer than this many lines match, but are not diffed line by line: every line keeps its colour. */
const MAX_EDIT_LINES = 4000;

export interface SymbolPrint {
  kind: DefinitionKind;
  name: string;
  /** As a hunk header names it, such as `Store.save()`. */
  label: string;
  /** First and last line, and the signature's last line, on the print's side. */
  start: number;
  end: number;
  signatureEnd: number;
  /** Tokens, comments and whitespace left out. */
  tokens: number;
  /** Lines with code. */
  lines: number;
  /** The token stream's hash, the name masked: equal hashes are the same body. */
  hash: string;
  /** The smallest `SKETCH` hashes of its distinct 4-grams, ascending. */
  sketch: Uint32Array;
  /** One hash per line from `start` to `end`: its tokens as written, or 0 for a line without code. */
  lineHashes: Uint32Array;
  /** The hash of its comments' texts in order, whitespace squashed; 0 without comments. */
  comments: number;
  /** Old side of a modified file: the new lines its removed lines sat between, for the in-place check. */
  at?: [number, number];
}
export interface FilePrints {
  before: SymbolPrint[];
  after: SymbolPrint[];
  /** A side held more than `MAX_FILE_CANDIDATES` candidates: the ones past it went unseen, so its family is refused. */
  capped?: boolean;
}

// ── Hashing ─────────────────────────────────────────────────────────────────

const fnv = (text: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
};
const mix = (h: number) => {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
};
const WORD = /[\p{L}\p{N}_$]/u;

/** A file's tokens in order: each one's hash, its row, and whether it is a word (a name, a keyword, a number). */
interface Tokens {
  hash: Uint32Array;
  row: Int32Array;
  count: number;
  /** Rows with a word token: lines with code. */
  wordRows: Uint8Array;
  /** Each comment's row and the hash of its text, in order: an exact move whose comments changed is not unchanged. */
  comments: { row: number; hash: number }[];
}

/** Every token of a tree, comments left out. One walk with a cursor, rows found from offsets. */
export function treeTokens(tree: TreeSitter.Tree, text: string): Tokens {
  const lineStarts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  let hint = 0;
  const rowOf = (index: number) => {
    if (lineStarts[hint] <= index && (hint + 1 >= lineStarts.length || lineStarts[hint + 1] > index)) return hint;
    let low = 0,
      high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= index) low = mid;
      else high = mid - 1;
    }
    hint = low;
    return low;
  };
  let hash = new Uint32Array(1024),
    row = new Int32Array(1024),
    count = 0;
  const wordRows = new Uint8Array(lineStarts.length + 1);
  const comments: Tokens['comments'] = [];
  const push = (value: string, at: number) => {
    if (count === hash.length) {
      const nextHash = new Uint32Array(count * 2);
      nextHash.set(hash);
      hash = nextHash;
      const nextRow = new Int32Array(count * 2);
      nextRow.set(row);
      row = nextRow;
    }
    hash[count] = fnv(value);
    row[count] = at;
    count++;
    if (WORD.test(value)) wordRows[at] = 1;
  };
  const cursor = tree.walk();
  try {
    outer: for (;;) {
      const comment = COMMENTS.has(cursor.nodeType);
      if (!comment && cursor.gotoFirstChild()) continue;
      if (comment) {
        const value = text.slice(cursor.startIndex, cursor.endIndex).replace(/\s+/g, ' ').trim();
        if (value) comments.push({ row: rowOf(cursor.startIndex), hash: fnv(value) });
      } else {
        const start = cursor.startIndex,
          end = cursor.endIndex;
        if (end > start) {
          const value = text.slice(start, end);
          if (/\S/.test(value)) push(value.trim(), rowOf(start));
        }
      }
      for (;;) {
        if (cursor.gotoNextSibling()) continue outer;
        if (!cursor.gotoParent()) break outer;
      }
    }
  } finally {
    cursor.delete();
  }
  return { hash, row, count, wordRows, comments };
}

/** The first token index at or after `row`. */
function firstAt(tokens: Tokens, row: number): number {
  let low = 0,
    high = tokens.count;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (tokens.row[mid] < row) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** A definition's fingerprint, from its lines' tokens. */
export function symbolPrint(definition: SyntaxDefinition, tokens: Tokens): SymbolPrint | undefined {
  const from = firstAt(tokens, definition.start - 1),
    to = firstAt(tokens, definition.end);
  const count = to - from;
  if (count <= 0) return undefined;
  // Its own name, as a name or a quoted test title, is masked: a rename keeps the body's hash.
  const name = definition.name;
  const masked = new Set(name ? [fnv(name), fnv(`"${name}"`), fnv(`'${name}'`), fnv(`\`${name}\``)] : []);
  const NAME = 0x6e616d65;
  let h1 = 0x811c9dc5,
    h2 = 0x9747b28c;
  const stream = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const t = masked.has(tokens.hash[from + i]) ? NAME : tokens.hash[from + i];
    stream[i] = t;
    h1 = Math.imul(h1 ^ t, 0x01000193) >>> 0;
    h2 = mix((h2 + t) | 0);
  }
  const shingles = new Set<number>();
  for (let i = 0; i + 3 < count; i++) {
    let h = stream[i];
    h = Math.imul(h ^ stream[i + 1], 0x9e3779b1);
    h = Math.imul(h ^ stream[i + 2], 0x85ebca6b);
    h = Math.imul(h ^ stream[i + 3], 0xc2b2ae35);
    shingles.add(mix(h));
  }
  const sorted = Uint32Array.from(shingles).sort();
  const lineCount = definition.end - definition.start + 1;
  const lineHashes = new Uint32Array(lineCount);
  for (let i = from; i < to; i++) {
    const at = tokens.row[i] - (definition.start - 1);
    lineHashes[at] = (Math.imul(lineHashes[at] ^ tokens.hash[i], 0x01000193) | 1) >>> 0;
  }
  let lines = 0;
  for (let r = definition.start - 1; r < definition.end; r++) lines += tokens.wordRows[r];
  let comments = 0;
  for (const comment of tokens.comments)
    if (comment.row >= definition.start - 1 && comment.row < definition.end)
      comments = (Math.imul(comments ^ comment.hash, 0x01000193) | 1) >>> 0;
  return {
    kind: definition.kind,
    name,
    label: definition.label,
    start: definition.start,
    end: definition.end,
    signatureEnd: definition.signatureEnd,
    tokens: count,
    lines,
    hash: `${count.toString(36)}.${h1.toString(36)}.${h2.toString(36)}`,
    sketch: sorted.length > SKETCH ? sorted.slice(0, SKETCH) : sorted,
    lineHashes,
    comments,
  };
}

/**
 * The candidates of one side of a file: movable definitions with enough code, most of whose lines with code the diff
 * changed. `changed[row]` is 1 for each changed row (0-based) of the side.
 */
export function sideCandidates(
  definitions: readonly SyntaxDefinition[],
  tokens: Tokens,
  changed: Uint8Array
): { prints: SymbolPrint[]; capped: boolean } {
  const result: SymbolPrint[] = [];
  for (const definition of definitions) {
    if (!MOVE_GROUPS[definition.kind]) continue;
    let code = 0,
      touched = 0,
      signature = true;
    for (let r = definition.start - 1; r < definition.end; r++)
      if (tokens.wordRows[r]) {
        code++;
        touched += changed[r] ?? 0;
        // Its declaration must change too: a class whose header stays lost (or gained) its members, it did not move.
        if (r < definition.signatureEnd && !changed[r]) signature = false;
      }
    if (!signature || code < MIN_LINES || touched < code * MIN_CHANGED) continue;
    const print = symbolPrint(definition, tokens);
    if (!print || print.tokens < MIN_TOKENS) continue;
    // Past the limit the rest go unseen: the side says so, and its family is not matched.
    if (result.length >= MAX_FILE_CANDIDATES) return { prints: result, capped: true };
    result.push(print);
  }
  return { prints: result, capped: false };
}

// ── Matching ────────────────────────────────────────────────────────────────

/** One changed file's candidates, as the matcher sees them. */
export interface MoveFile {
  /** The file's revision key (`fileRevisionKey`): where its marks are kept. */
  file: string;
  url: string;
  /** The PR revision's head, so a view opens the file at the same revision. */
  headSha: string;
  path: string;
  /** The old path of a renamed file: its old side's symbols sat there. */
  previousPath?: string;
  family: string;
  prints: FilePrints;
}
export interface MoveEnd {
  file: string;
  url: string;
  headSha: string;
  /** Where the symbol is on its side: the old path for the old side of a renamed file. */
  path: string;
  /** The path the diff shows the file under: the new path. */
  diffPath: string;
  side: 'before' | 'after';
  kind: DefinitionKind;
  name: string;
  label: string;
  start: number;
  end: number;
  signatureEnd: number;
}
export interface SymbolMove {
  from: MoveEnd;
  to: MoveEnd;
  /** The bodies' tokens are the same, the name aside. */
  exact: boolean;
  renamed: boolean;
  /** Jaccard similarity of the two bodies' 4-grams: 1 for an exact match. */
  similarity: number;
  /** The two bodies' comments differ: an exact move whose comments changed is not unchanged. */
  commentsChanged: boolean;
  /**
   * Each body's per-line token hashes (`SymbolPrint.lineHashes`), for the line diff a view makes when it shows the move
   * (`moveEdits`): the diff waits until then, so a large refactor's match stays one short task.
   */
  lines: { before: Uint32Array; after: Uint32Array };
}
/** A move's line diff (`moveEdits`): the lines that differ, and the lines it matched, on each side. */
export interface MoveEdits {
  before: number[];
  after: number[];
  /**
   * Lines the line diff matched between the two bodies: carried over unchanged. Lines without code (comments, blank
   * lines) are in neither list: nothing says whether they changed.
   */
  kept: { before: number[]; after: number[] };
}
export interface MovesResult {
  moves: SymbolMove[];
  candidates: { before: number; after: number };
  /** Similarity comparisons made. */
  compared: number;
  /** A limit was reached: the similarity pass was dropped, or candidates were left out. */
  capped: boolean;
  ms: number;
}

interface Candidate {
  print: SymbolPrint;
  file: MoveFile;
  side: 'before' | 'after';
  group: string;
  /** Index among its file side's candidates, for nesting. */
  index: number;
}

/** The Jaccard similarity of two sets from their bottom-k sketches: exact when both sets are smaller than k. */
export function sketchSimilarity(a: Uint32Array, b: Uint32Array, k = SKETCH): number {
  let i = 0,
    j = 0,
    union = 0,
    both = 0;
  while (union < k && (i < a.length || j < b.length)) {
    if (j >= b.length || (i < a.length && a[i] < b[j])) i++;
    else if (i >= a.length || b[j] < a[i]) j++;
    else {
      both++;
      i++;
      j++;
    }
    union++;
  }
  return union ? both / union : 0;
}

const end = (candidate: Candidate): MoveEnd => ({
  file: candidate.file.file,
  url: candidate.file.url,
  headSha: candidate.file.headSha,
  path: candidate.side === 'before' ? (candidate.file.previousPath ?? candidate.file.path) : candidate.file.path,
  diffPath: candidate.file.path,
  side: candidate.side,
  kind: candidate.print.kind,
  name: candidate.print.name,
  label: candidate.print.label,
  start: candidate.print.start,
  end: candidate.print.end,
  signatureEnd: candidate.print.signatureEnd,
});

/**
 * Old and new lines that differ, by a line diff of the bodies' per-line token hashes (lines without code skipped), and
 * the lines it matched. Undefined for bodies too long to diff (`MAX_EDIT_LINES`): a view then neither dims nor counts.
 */
export function moveEdits(move: Pick<SymbolMove, 'from' | 'to' | 'lines'>): MoveEdits | undefined {
  const lines = (start: number, all: Uint32Array) => {
    const numbers: number[] = [],
      hashes: number[] = [];
    all.forEach((hash, i) => {
      if (!hash) return;
      numbers.push(start + i);
      hashes.push(hash);
    });
    return { numbers, hashes };
  };
  const old = lines(move.from.start, move.lines.before),
    now = lines(move.to.start, move.lines.after);
  if (old.hashes.length + now.hashes.length > MAX_EDIT_LINES) return undefined;
  const edits: MoveEdits = { before: [], after: [], kept: { before: [], after: [] } };
  let i = 0,
    j = 0;
  for (const part of diffArrays(old.hashes, now.hashes)) {
    const n = part.count;
    if (part.removed) for (let k = 0; k < n; k++) edits.before.push(old.numbers[i++]);
    else if (part.added) for (let k = 0; k < n; k++) edits.after.push(now.numbers[j++]);
    else
      for (let k = 0; k < n; k++) {
        edits.kept.before.push(old.numbers[i++]);
        edits.kept.after.push(now.numbers[j++]);
      }
  }
  return edits;
}

/**
 * The PR's moved symbols, from the candidates of its changed files. Files of one language family must all be read
 * before their family is matched (the caller's job): a file left out could hold a rival.
 */
export function matchMoves(
  files: readonly MoveFile[],
  limits: { candidates?: number; pairs?: number } = {}
): MovesResult {
  const started = performance.now();
  const maxCandidates = limits.candidates ?? MAX_CANDIDATES,
    maxPairs = limits.pairs ?? MAX_PAIRS;
  const removed: Candidate[] = [],
    added: Candidate[] = [];
  let capped = false as boolean;
  for (const file of files)
    for (const side of ['before', 'after'] as const) {
      const into = side === 'before' ? removed : added;
      file.prints[side].forEach((print, index) => {
        if (into.length >= maxCandidates) {
          capped = true;
          return;
        }
        into.push({ print, file, side, group: `${file.family}\u0000${MOVE_GROUPS[print.kind]}`, index });
      });
    }
  // A file that held more candidates than it kept may hide a rival: nothing matches.
  if (files.some((file) => file.prints.capped)) capped = true;
  const result: MovesResult = {
    moves: [],
    candidates: { before: removed.length, after: added.length },
    compared: 0,
    capped,
    ms: 0,
  };
  // Past the candidate limit a rival may be among those left out: nothing matches.
  if (capped) {
    result.ms = performance.now() - started;
    return result;
  }
  const consumed = new Set<Candidate>();
  const excluded = new Set<Candidate>();
  const bySide = new Map<string, Candidate[]>();
  for (const candidate of [...removed, ...added]) {
    const key = `${candidate.file.file}\u0000${candidate.side}`;
    const list = bySide.get(key) ?? [];
    list.push(candidate);
    bySide.set(key, list);
  }
  /** A match takes the candidates inside it on its side: they moved with it. */
  const take = (candidate: Candidate) => {
    consumed.add(candidate);
    for (const other of bySide.get(`${candidate.file.file}\u0000${candidate.side}`) ?? [])
      if (other.print.start >= candidate.print.start && other.print.end <= candidate.print.end) consumed.add(other);
  };
  /** Removed and added copies at the same place in the same file: an edit in place. */
  const inPlace = (from: Candidate, to: Candidate) => {
    if (from.file !== to.file) return false;
    const at = from.print.at;
    if (!at) return false;
    return at[0] <= to.print.end + 1 && at[1] >= to.print.start - 1;
  };
  const matched: { from: Candidate; to: Candidate; exact: boolean; similarity: number }[] = [];
  // 1. Exact, largest first.
  const groups = new Map<string, { removed: Candidate[]; added: Candidate[]; size: number }>();
  for (const candidate of [...removed, ...added]) {
    const key = `${candidate.group}\u0000${candidate.print.hash}`;
    const group = groups.get(key) ?? { removed: [], added: [], size: 0 };
    (candidate.side === 'before' ? group.removed : group.added).push(candidate);
    group.size = Math.max(group.size, candidate.print.tokens);
    groups.set(key, group);
  }
  for (const group of [...groups.values()].sort((a, b) => b.size - a.size)) {
    const r = group.removed.filter((c) => !consumed.has(c)),
      a = group.added.filter((c) => !consumed.has(c));
    if (!r.length || !a.length) continue;
    if (r.length === 1 && a.length === 1) {
      if (inPlace(r[0], a[0])) {
        excluded.add(r[0]);
        excluded.add(a[0]);
        continue;
      }
      matched.push({ from: r[0], to: a[0], exact: true, similarity: 1 });
      take(r[0]);
      take(a[0]);
      continue;
    }
    // The same body more than once on a side: which copy went where is unknown.
    for (const c of [...r, ...a]) excluded.add(c);
  }
  // 2. Similar. Every candidate not yet matched is compared, as a rival at least: a tie's copies and small bodies
  // never match by similarity, but an edited copy that is as near to one of them as to its own original is unknown.
  const pool = (list: Candidate[]) => list.filter((c) => !consumed.has(c));
  const matchable = (c: Candidate) => !excluded.has(c) && c.print.tokens >= MIN_SIMILAR_TOKENS;
  const buckets = new Map<string, Candidate[]>();
  for (const candidate of pool(removed)) {
    const list = buckets.get(candidate.group) ?? [];
    list.push(candidate);
    buckets.set(candidate.group, list);
  }
  for (const list of buckets.values()) list.sort((x, y) => x.print.tokens - y.print.tokens);
  interface Pair {
    from: Candidate;
    to: Candidate;
    similarity: number;
    /** Both may match by similarity; any pair counts as a rival. */
    matchable: boolean;
  }
  const pairs: Pair[] = [];
  const partners = new Map<Candidate, Pair[]>();
  let compared = 0;
  similar: for (const to of pool(added)) {
    const list = buckets.get(to.group);
    if (!list) continue;
    const low = to.print.tokens / RIVAL_RATIO,
      high = to.print.tokens * RIVAL_RATIO;
    let first = 0,
      last = list.length;
    while (first < last) {
      const mid = (first + last) >> 1;
      if (list[mid].print.tokens < low) first = mid + 1;
      else last = mid;
    }
    for (let i = first; i < list.length && list[i].print.tokens <= high; i++) {
      if (++compared > maxPairs) {
        capped = true;
        break similar;
      }
      const from = list[i];
      const similarity = sketchSimilarity(from.print.sketch, to.print.sketch);
      if (similarity < FLOOR) continue;
      const ratio = Math.max(from.print.tokens, to.print.tokens) / Math.min(from.print.tokens, to.print.tokens);
      const pair = { from, to, similarity, matchable: matchable(from) && matchable(to) && ratio <= SIZE_RATIO };
      pairs.push(pair);
      for (const c of [from, to]) {
        const own = partners.get(c) ?? [];
        own.push(pair);
        partners.set(c, own);
      }
    }
  }
  result.compared = Math.min(compared, maxPairs);
  // Past the pair limit a pair's rival may not have been compared: the similarity pass is dropped whole.
  if (!capped) {
    pairs.sort((x, y) => y.similarity - x.similarity || y.to.print.tokens - x.to.print.tokens);
    const rival = (candidate: Candidate, pair: Pair) => {
      let best = 0;
      for (const other of partners.get(candidate) ?? [])
        if (other !== pair && !consumed.has(other.from) && !consumed.has(other.to))
          best = Math.max(best, other.similarity);
      return best;
    };
    for (const pair of pairs) {
      const { from, to, similarity } = pair;
      if (!pair.matchable || consumed.has(from) || consumed.has(to)) continue;
      if (similarity < (from.print.name === to.print.name ? SAME_NAME : RENAMED)) continue;
      if (similarity - Math.max(rival(from, pair), rival(to, pair)) < MARGIN) continue;
      if (inPlace(from, to)) continue;
      matched.push({ from, to, exact: false, similarity });
      take(from);
      take(to);
    }
  }
  result.capped = capped;
  // A symbol inside a matched one on both sides moved with it: the outer move says it.
  const inside = (inner: Candidate, outer: Candidate) =>
    inner !== outer &&
    inner.file === outer.file &&
    inner.side === outer.side &&
    inner.print.start >= outer.print.start &&
    inner.print.end <= outer.print.end;
  const kept = matched.filter((m) => !matched.some((o) => o !== m && inside(m.from, o.from) && inside(m.to, o.to)));
  result.moves = kept
    .map(({ from, to, exact, similarity }) => ({
      from: end(from),
      to: end(to),
      exact,
      renamed: from.print.name !== to.print.name,
      similarity,
      commentsChanged: from.print.comments !== to.print.comments,
      lines: { before: from.print.lineHashes, after: to.print.lineHashes },
    }))
    .sort((x, y) => (x.to.file < y.to.file ? -1 : x.to.file > y.to.file ? 1 : x.to.start - y.to.start));
  result.ms = performance.now() - started;
  return result;
}

/**
 * Whether a patch can hold a moved symbol's end: it removes or adds at least the changed lines a candidate needs
 * (`sideCandidates`: `MIN_LINES` lines with code, `MIN_CHANGED` of them changed), counted over the whole patch, since a
 * candidate's changed lines may sit in several hunks.
 */
export function patchMayMove(patch: string | undefined): boolean {
  if (!patch) return false;
  const need = Math.ceil(MIN_LINES * MIN_CHANGED);
  let removed = 0,
    added = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('-')) removed++;
    else if (line.startsWith('+')) added++;
    if (removed >= need || added >= need) return true;
  }
  return false;
}

// ── A file's two sides ──────────────────────────────────────────────────────

/** Changed rows (0-based) of each side and where each old block sits in the new file, from the comparison blocks. */
export interface SymbolSides {
  before?: { text: string; changed: Uint8Array };
  after?: { text: string; changed: Uint8Array };
  /** Old row → the new 1-based lines its block sits between, for a modified file. */
  at?: (row: number) => [number, number] | undefined;
}

/** Each changed row of a side, as an array the length of its rows. */
export function changedRows(rows: number, blocks: readonly { row: number; count: number }[]): Uint8Array {
  const changed = new Uint8Array(rows + 1);
  for (const block of blocks) for (let r = block.row; r < block.row + block.count && r <= rows; r++) changed[r] = 1;
  return changed;
}

/** The before candidates' `at`: the new lines their first and last lines' blocks sit between. */
export function placeBefore(prints: SymbolPrint[], at: SymbolSides['at']): SymbolPrint[] {
  if (!at) return prints;
  return prints.map((print) => {
    const first = at(print.start - 1),
      last = at(print.end - 1);
    return first && last ? { ...print, at: [Math.min(first[0], last[0]), Math.max(first[1], last[1])] } : print;
  });
}
