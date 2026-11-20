import { fileRevisionKey, type PrChangeFile, type PrChanges, type PrFileSide } from './pr-changes';
import type { DefinitionKind, SymbolsInput } from './syntax-scope';
import { languageFamily, type FilePrints, type MoveFile, type MovesResult, type SymbolMove } from './moved-symbols';
import { movesFilePlan, movesLanguage as languageOf } from './moved-symbols-plan';
import { readMoves, readSymbols, symbolReadTimings } from './syntax-scope-client';
import { patchHunks } from './semantic-noise';
import { wholeFileText } from './syntax-contents';
import { onInspectionForget } from './inspection-cache';
import { addDiagnosticsSource } from './diagnostics-sources';

/**
 * A PR's moved and renamed symbols (#398), on the page. Changes asks for them with the files it prefetches
 * (lib/use-syntax-contents.ts): each changed file whose patch removes or adds a run of lines is fingerprinted in the
 * tree-sitter worker as its new side arrives (an added or deleted file from its patch alone), below every other parse.
 * Once every such file of a language family is fingerprinted, the family is matched in the worker
 * (lib/moved-symbols.ts), once per PR revision. A family with a file that cannot be read (too large, no patch, not
 * text) is not matched: that file could hold a rival, and a wrong "moved from" is worse than none. A PR with more than
 * `MOVES_MAX_FILES` such files is not matched at all.
 *
 * Marks are kept by file revision key (`fileRevisionKey`), so every view of a file, Changes and Explanation topics
 * alike, shows the same moves (useDiffFileModel).
 */
export const MOVES_MAX_FILES = 300;
/** Fingerprinted files kept, across PRs: most hold no candidate and cost a few bytes. */
const FILE_ENTRIES = 4000;
const PR_ENTRIES = 24;

/** One end of a move, seen from the file that shows it: where the symbol is here, and where it went or came from. */
export interface MoveMark {
  /** The side of this file the symbol is on: `after` for a symbol that came here, `before` for one that left. */
  side: 'before' | 'after';
  kind: DefinitionKind;
  name: string;
  label: string;
  start: number;
  end: number;
  signatureEnd: number;
  /** The other end: where it came from (an old side) or went to (a new side). */
  other: SymbolMove['from'];
  /** Both ends are in this file. */
  sameFile: boolean;
  exact: boolean;
  renamed: boolean;
  similarity: number;
  /** Lines on this side that differ from the other end's body: the move's real edits. */
  edits: readonly number[];
}
export interface FileMoves {
  marks: readonly MoveMark[];
}

type FileState =
  | { url: string; family: string; state: 'waiting' | 'reading' }
  | { url: string; family: string; state: 'done'; prints: FilePrints; file: MoveFile }
  | { url: string; family: string; state: 'failed'; reason: string };
interface FamilyState {
  files: string[];
  state: 'waiting' | 'matching' | 'matched' | 'incomplete';
  result?: MovesResult;
}
interface PrState {
  url: string;
  families: Map<string, FamilyState>;
  /** Too many files: nothing is matched. */
  skipped?: boolean;
  at: number;
}

const files = new Map<string, FileState>();
/** By file revision: what each file was planned from, for reads that land later. */
const planned = new Map<string, { snapshot: PrChanges; file: PrChangeFile; revision: string }>();
const prs = new Map<string, PrState>();
const marks = new Map<string, FileMoves>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  for (const listener of listeners) listener();
};
/** Tells `listener` when a file's moves land or leave; the return stops it. */
export function onMoves(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export const movesRevision = () => version;
/** A file revision's moves, once its PR's family is matched. */
export const peekFileMoves = (fileKey: string): FileMoves | undefined => marks.get(fileKey);

const revisionOf = (snapshot: PrChanges) =>
  `${snapshot.url}\u0000${snapshot.metadata.baseSha}\u0000${snapshot.metadata.headSha}`;
const keyOf = (snapshot: PrChanges, file: PrChangeFile) =>
  fileRevisionKey(snapshot.url, file.path, snapshot.metadata.baseSha, snapshot.metadata.headSha);
/** A file's input for its fingerprints, from its patch or the sides read so far; `null` when it cannot be read. */
function inputOf(file: PrChangeFile, after?: PrFileSide, before?: PrFileSide): SymbolsInput | null | undefined {
  const patch = file.patch ?? '';
  if (file.status === 'added') {
    const text = wholeFileText(patch, 'after') ?? (after?.kind === 'text' ? after.content : undefined);
    if (text !== undefined) return { mode: 'added', text };
    return after && after.kind !== 'text' ? null : undefined;
  }
  if (file.status === 'deleted') {
    const text = wholeFileText(patch, 'before') ?? (before?.kind === 'text' ? before.content : undefined);
    if (text !== undefined) return { mode: 'deleted', text };
    return before && before.kind !== 'text' ? null : undefined;
  }
  if (!after) return undefined;
  if (after.kind !== 'text') return null;
  const hunks = patchHunks(patch);
  return hunks ? { mode: 'modified', text: after.content, hunks } : null;
}

function fingerprint(key: string, input: SymbolsInput) {
  const entry = files.get(key);
  const plan = planned.get(key);
  if (!entry || !plan || entry.state !== 'waiting') return;
  const language = languageOf(plan.file);
  if (!language) return;
  files.set(key, { url: entry.url, family: entry.family, state: 'reading' });
  void readSymbols({ key: `${key}:symbols`, url: entry.url, language, input, priority: 'prefetch' }).then(
    (prints) => {
      if (files.get(key)?.state !== 'reading') return;
      const { snapshot, file } = plan;
      files.set(key, {
        url: entry.url,
        family: entry.family,
        state: 'done',
        prints,
        file: {
          file: key,
          url: snapshot.url,
          headSha: snapshot.metadata.headSha,
          path: file.path,
          previousPath: file.previousPath,
          family: entry.family,
          prints,
        },
      });
      recheck(plan.revision);
    },
    (error: unknown) => {
      if (files.get(key)?.state !== 'reading') return;
      files.set(key, {
        url: entry.url,
        family: entry.family,
        state: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
      recheck(plan.revision);
    }
  );
}

/** Matches each family whose files are all fingerprinted. */
function recheck(revision: string) {
  const pr = prs.get(revision);
  if (!pr || pr.skipped) return;
  for (const [family, state] of pr.families) {
    if (state.state !== 'waiting') continue;
    const entries = state.files.map((key) => files.get(key));
    if (entries.some((entry) => entry?.state === 'failed')) {
      state.state = 'incomplete';
      continue;
    }
    const done = entries.flatMap((entry) => (entry?.state === 'done' ? [entry] : []));
    if (done.length < entries.length) continue;
    const moveFiles = done.flatMap((entry) =>
      entry.prints.before.length || entry.prints.after.length ? [entry.file] : []
    );
    const removed = moveFiles.some((f) => f.prints.before.length),
      added = moveFiles.some((f) => f.prints.after.length);
    if (!removed || !added) {
      state.state = 'matched';
      state.result = { moves: [], candidates: { before: 0, after: 0 }, compared: 0, capped: false, ms: 0 };
      continue;
    }
    state.state = 'matching';
    void readMoves(moveFiles).then(
      (result) => {
        if (prs.get(revision) !== pr || pr.families.get(family) !== state) return;
        state.state = 'matched';
        state.result = result;
        publish(result.moves);
      },
      () => {
        if (pr.families.get(family) === state) state.state = 'incomplete';
      }
    );
  }
}

function publish(moves: readonly SymbolMove[]) {
  if (!moves.length) return;
  const byFile = new Map<string, MoveMark[]>();
  const add = (key: string, mark: MoveMark) => byFile.set(key, [...(byFile.get(key) ?? []), mark]);
  for (const move of moves) {
    const common = {
      sameFile: move.from.file === move.to.file,
      exact: move.exact,
      renamed: move.renamed,
      similarity: move.similarity,
    };
    const here = (end: SymbolMove['from']) => ({
      side: end.side,
      kind: end.kind,
      name: end.name,
      label: end.label,
      start: end.start,
      end: end.end,
      signatureEnd: end.signatureEnd,
    });
    add(move.to.file, { ...here(move.to), other: move.from, edits: move.edits.after, ...common });
    add(move.from.file, { ...here(move.from), other: move.to, edits: move.edits.before, ...common });
  }
  for (const [key, list] of byFile)
    marks.set(key, { marks: [...(marks.get(key)?.marks ?? []), ...list].sort((a, b) => a.start - b.start) });
  changed();
}

/**
 * Starts matching a PR's files, or picks up where it left off: called with the files Changes shows, each time they
 * change. Files whose text is already here (an added file's patch, a read side in the cache) are fingerprinted now;
 * `text` finds a modified file's sides in the cache. Returns the files still waiting for their new side, for the
 * caller to read.
 */
export function trackMoves(
  entries: readonly { snapshot: PrChanges; file: PrChangeFile }[],
  allowed: (path: string) => boolean,
  text: (snapshot: PrChanges, file: PrChangeFile) => { after?: PrFileSide; before?: PrFileSide } | undefined
): { snapshot: PrChanges; file: PrChangeFile }[] {
  const byRevision = new Map<string, { snapshot: PrChanges; file: PrChangeFile }[]>();
  for (const entry of entries) {
    // Commit ranges and stack comparisons are other diffs of the same files: only the PR's own diff is matched.
    // A PR whose file list GitHub cut short may hold a rival in a file not listed: it is not matched.
    if (entry.snapshot.comparison || entry.snapshot.stackComparison || entry.snapshot.filesTruncated) continue;
    const key = revisionOf(entry.snapshot);
    byRevision.set(key, [...(byRevision.get(key) ?? []), entry]);
  }
  const waiting: { snapshot: PrChanges; file: PrChangeFile }[] = [];
  for (const [revision, list] of byRevision) {
    let pr = prs.get(revision);
    if (!pr) {
      const families = new Map<string, FamilyState>();
      const plans = list.flatMap((entry) => {
        const plan = movesFilePlan(entry.snapshot, entry.file, allowed);
        return plan ? [{ ...entry, plan }] : [];
      });
      pr = { url: list[0].snapshot.url, families, skipped: plans.length > MOVES_MAX_FILES, at: Date.now() };
      prs.set(revision, pr);
      for (const old of prs.keys()) {
        if (prs.size <= PR_ENTRIES) break;
        prs.delete(old);
      }
      if (!pr.skipped)
        for (const { snapshot, file, plan } of plans) {
          const key = keyOf(snapshot, file);
          const family = languageFamily(plan.language);
          const state = families.get(family) ?? { files: [], state: 'waiting' as const };
          state.files.push(key);
          families.set(family, state);
          planned.set(key, { snapshot, file, revision });
          if (!files.has(key))
            files.set(
              key,
              plan.readable
                ? { url: snapshot.url, family, state: 'waiting' }
                : { url: snapshot.url, family, state: 'failed', reason: 'No patch' }
            );
        }
      for (const old of files.keys()) {
        if (files.size <= FILE_ENTRIES) break;
        files.delete(old);
        planned.delete(old);
      }
    }
    pr.at = Date.now();
    if (pr.skipped) continue;
    for (const state of pr.families.values())
      for (const key of state.files) {
        const entry = files.get(key),
          plan = planned.get(key);
        if (entry?.state !== 'waiting' || !plan) continue;
        const sides = text(plan.snapshot, plan.file);
        const input = inputOf(plan.file, sides?.after, sides?.before);
        if (input === null)
          files.set(key, { url: entry.url, family: entry.family, state: 'failed', reason: 'Not text' });
        else if (input) fingerprint(key, input);
        else waiting.push({ snapshot: plan.snapshot, file: plan.file });
      }
    recheck(revision);
  }
  return waiting;
}

/** A file's sides were read (for its scopes, lib/use-syntax-contents.ts): its fingerprints can start. */
export function noteMovesText(snapshot: PrChanges, file: PrChangeFile, after?: PrFileSide, before?: PrFileSide) {
  if (snapshot.comparison || snapshot.stackComparison) return;
  const key = keyOf(snapshot, file);
  const entry = files.get(key);
  if (entry?.state !== 'waiting') return;
  const input = inputOf(file, after, before);
  if (input === null) {
    files.set(key, { url: entry.url, family: entry.family, state: 'failed', reason: 'Not text' });
    const plan = planned.get(key);
    if (plan) recheck(plan.revision);
  } else if (input) fingerprint(key, input);
}

/** A file's read failed for good: its family is not matched. */
export function noteMovesFailure(snapshot: PrChanges, file: PrChangeFile, reason: string) {
  const key = keyOf(snapshot, file);
  const entry = files.get(key);
  if (entry?.state !== 'waiting') return;
  files.set(key, { url: entry.url, family: entry.family, state: 'failed', reason });
  const plan = planned.get(key);
  if (plan) recheck(plan.revision);
}

function forget(urls?: ReadonlySet<string>) {
  const gone = (url: string) => !urls || urls.has(url);
  for (const [key, entry] of files)
    if (gone(entry.url)) {
      files.delete(key);
      planned.delete(key);
    }
  for (const [key, pr] of prs) if (gone(pr.url)) prs.delete(key);
  let dropped = false;
  for (const key of marks.keys())
    if (!urls || [...urls].some((url) => key.startsWith(JSON.stringify([url]).slice(0, -1)))) {
      marks.delete(key);
      dropped = true;
    }
  if (dropped) changed();
}
onInspectionForget((urls) => forget(urls));

/** What the store holds and how long its work took, for the diagnostics export and the browser checks. */
export function movedSymbolsStats() {
  return {
    files: files.size,
    marked: marks.size,
    prs: [...prs.values()].map((pr) => ({
      url: pr.url,
      skipped: !!pr.skipped,
      families: [...pr.families].map(([family, state]) => ({
        family,
        files: state.files.length,
        done: state.files.filter((key) => files.get(key)?.state === 'done').length,
        failed: state.files.filter((key) => files.get(key)?.state === 'failed').length,
        // Files still on their way, and how far each got.
        pending: state.files.flatMap((key) => {
          const entry = files.get(key);
          return entry?.state === 'done' || entry?.state === 'failed' ? [] : [{ path: planned.get(key)?.file.path, state: entry?.state ?? 'forgotten' }];
        }),
        state: state.state,
        moves: state.result?.moves.length,
        candidates: state.result?.candidates,
        compared: state.result?.compared,
        capped: state.result?.capped,
        matchMs: state.result && Math.round(state.result.ms * 10) / 10,
      })),
    })),
    reads: symbolReadTimings.slice(-10),
  };
}
addDiagnosticsSource('movedSymbols', movedSymbolsStats);
