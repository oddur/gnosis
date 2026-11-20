import { fileRevisionKey, type PrChangeFile, type PrChanges, type PrFileSide } from './pr-changes';
import type { DefinitionKind, SymbolsInput, SyntaxLanguage } from './syntax-scope';
import {
  languageFamily,
  moveEdits,
  type FilePrints,
  type MoveFile,
  type MovesResult,
  type SymbolMove,
} from './moved-symbols';
import { movesFilePlan, movesLanguage } from './moved-symbols-plan';
import { patchHunks } from './semantic-noise';
import { wholeFileText } from './syntax-contents';

/**
 * A PR's moved and renamed symbols (#398), on the page, as a store with its worker calls passed in, so the unit tests
 * run it without a worker (lib/moved-symbols-store.ts makes the app's one).
 *
 * Changes asks for them with the files it prefetches (lib/use-syntax-contents.ts): each changed file whose patch
 * removes or adds a run of lines is fingerprinted in the tree-sitter worker as its new side arrives (an added or
 * deleted file from its patch alone), below every other parse. Once every such file of a language family is
 * fingerprinted, the family is matched in the worker (lib/moved-symbols.ts), once per PR revision. A family with a
 * file that is not read (too large, no patch, not text, its language off, more candidates than a side keeps) is not
 * matched: that file could hold a rival, and a wrong "moved from" is worse than none. A PR with more than
 * `MOVES_MAX_FILES` such files is not matched at all.
 *
 * Everything is kept per PR revision: its files, their fingerprints and its marks. A PR leaves whole, the least
 * recently used first, and a new head of a PR replaces the old revision. Marks are found by file revision key
 * (`fileRevisionKey`), so every view of a file, Changes and Explanation topics alike, shows the same moves.
 */
export const MOVES_MAX_FILES = 300;
/** PR revisions kept: each holds at most `MOVES_MAX_FILES` files, most with no candidate. */
export const MOVES_PR_ENTRIES = 24;

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
  /** The two bodies' comments differ. */
  commentsChanged: boolean;
  /**
   * Lines on this side that differ from the other end's body (the move's real edits), and lines the line diff matched
   * to the other end's (carried over unchanged). Undefined when the bodies are too long to diff: nothing dims or counts.
   */
  edits?: { changed: readonly number[]; kept: readonly number[] };
}
export interface FileMoves {
  marks: readonly MoveMark[];
}

type FileState =
  | { family: string; state: 'waiting' | 'reading' }
  | { family: string; state: 'done'; prints: FilePrints; file: MoveFile }
  /** `recoverable`: tries that could pass ran out; a later read of the file revives it. */
  | { family: string; state: 'failed'; reason: string; recoverable?: boolean };
interface FamilyState {
  files: string[];
  state: 'waiting' | 'matching' | 'matched' | 'incomplete';
  result?: MovesResult;
}
interface PrState {
  url: string;
  revision: string;
  families: Map<string, FamilyState>;
  files: Map<string, FileState>;
  /** What each file was planned from: reads that land later are fingerprinted from this, never from the caller's. */
  planned: Map<string, { snapshot: PrChanges; file: PrChangeFile; language: SyntaxLanguage }>;
  /** Each file's moves, as matched; its marks are made when a view first shows the file (`peek`). */
  moves: Map<string, SymbolMove[]>;
  marks: Map<string, FileMoves>;
  /** The files and the Settings it was planned from: either changing plans it again. */
  signature: string;
  /** Too many files: nothing is matched. */
  skipped?: boolean;
  at: number;
}

export interface MovesWorker {
  readSymbols: (request: {
    key: string;
    fileKey: string;
    url: string;
    language: SyntaxLanguage;
    input: SymbolsInput;
    priority: 'prefetch';
  }) => Promise<FilePrints>;
  readMoves: (files: MoveFile[]) => Promise<MovesResult>;
}

const revisionOf = (snapshot: PrChanges) =>
  `${snapshot.url}\u0000${snapshot.metadata.baseSha}\u0000${snapshot.metadata.headSha}`;
const keyOf = (snapshot: PrChanges, file: PrChangeFile) =>
  fileRevisionKey(snapshot.url, file.path, snapshot.metadata.baseSha, snapshot.metadata.headSha);
/** Commit ranges and stack comparisons are other diffs of the same files: only the PR's own diff is matched. A PR
 * whose file list GitHub cut short may hold a rival in a file not listed: it is not matched either. */
const tracked = (snapshot: PrChanges) => !snapshot.comparison && !snapshot.stackComparison && !snapshot.filesTruncated;

/** A file's input for its fingerprints, from its patch or the sides read so far; `null` when it cannot be read. */
export function movesInput(
  file: PrChangeFile,
  after?: PrFileSide,
  before?: PrFileSide
): SymbolsInput | null | undefined {
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

export function createMovesStore(worker: MovesWorker, now: () => number = Date.now) {
  const prs = new Map<string, PrState>();
  /** Each tracked file revision's PR revision. */
  const byKey = new Map<string, string>();
  const listeners = new Set<() => void>();
  let version = 0;
  const changed = () => {
    version++;
    for (const listener of listeners) listener();
  };

  /**
   * Views that track each PR revision and have not released it. A held PR never leaves: not to make room, not with
   * the inspection data, not for a newer head. Only PRs no view holds leave, the least recently used first.
   */
  const holds = new Map<string, number>();
  const held = (revision: string) => (holds.get(revision) ?? 0) > 0;
  function drop(revision: string) {
    const pr = prs.get(revision);
    if (!pr) return false;
    prs.delete(revision);
    for (const key of pr.files.keys()) if (byKey.get(key) === revision) byKey.delete(key);
    return true;
  }

  /**
   * A read of the file ended without it. A file whose fingerprints are under way or done keeps them: another read
   * brought its text. A recoverable failure never replaces a lasting one.
   */
  function fail(pr: PrState, key: string, reason: string, recoverable = false) {
    const entry = pr.files.get(key);
    if (!entry || entry.state === 'done' || entry.state === 'reading') return;
    if (entry.state === 'failed' && (!entry.recoverable || recoverable)) return;
    pr.files.set(key, { family: entry.family, state: 'failed', reason, ...(recoverable ? { recoverable } : {}) });
    recheck(pr);
  }
  /** Whether a file still wants its text: waiting for it, or failed in a way a later read can mend. */
  const wanting = (entry: FileState | undefined) =>
    entry?.state === 'waiting' || (entry?.state === 'failed' && !!entry.recoverable);

  function fingerprint(pr: PrState, key: string, input: SymbolsInput) {
    const entry = pr.files.get(key),
      plan = pr.planned.get(key);
    if (!entry || !wanting(entry) || !plan) return;
    pr.files.set(key, { family: entry.family, state: 'reading' });
    // A file mended after a failure that could pass: its family waits for it again instead of staying incomplete.
    const family = pr.families.get(entry.family);
    if (family?.state === 'incomplete') family.state = 'waiting';
    const live = () => prs.get(pr.revision) === pr && pr.files.get(key)?.state === 'reading';
    void worker
      .readSymbols({
        key: `${key}:symbols`,
        fileKey: key,
        url: pr.url,
        language: plan.language,
        input,
        priority: 'prefetch',
      })
      .then(
        (prints) => {
          if (!live()) return;
          if (prints.capped) {
            pr.files.set(key, { family: entry.family, state: 'failed', reason: 'Too many candidates' });
            recheck(pr);
            return;
          }
          const { snapshot, file } = plan;
          pr.files.set(key, {
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
          recheck(pr);
        },
        (error: unknown) => {
          if (!live()) return;
          pr.files.set(key, {
            family: entry.family,
            state: 'failed',
            reason: error instanceof Error ? error.message : String(error),
          });
          recheck(pr);
        }
      );
  }

  /** Plans a held PR's files it does not have yet; a family that gains one is matched again once it is read. */
  function merge(
    pr: PrState,
    list: readonly { snapshot: PrChanges; file: PrChangeFile }[],
    allowed: (path: string) => boolean
  ) {
    if (pr.skipped) return;
    for (const { snapshot, file } of list) {
      const key = keyOf(snapshot, file);
      if (pr.planned.has(key)) continue;
      const plan = movesFilePlan(snapshot, file, allowed);
      if (!plan) continue;
      const family = languageFamily(plan.language);
      const state = pr.families.get(family) ?? { files: [], state: 'waiting' as const };
      state.files.push(key);
      if (state.state !== 'matching') {
        state.state = 'waiting';
        state.result = undefined;
      }
      pr.families.set(family, state);
      pr.planned.set(key, { snapshot, file, language: movesLanguage(file) ?? plan.language });
      byKey.set(key, pr.revision);
      pr.files.set(
        key,
        plan.readable
          ? { family, state: 'waiting' }
          : { family, state: 'failed', reason: plan.reason === 'off' ? 'Language off' : 'No patch' }
      );
    }
  }

  /** Matches each family whose files are all fingerprinted. */
  function recheck(pr: PrState) {
    if (pr.skipped) return;
    for (const [family, state] of pr.families) {
      if (state.state !== 'waiting') continue;
      const entries = state.files.map((key) => pr.files.get(key));
      if (entries.some((entry) => entry?.state === 'failed')) {
        state.state = 'incomplete';
        continue;
      }
      const done = entries.flatMap((entry) => (entry?.state === 'done' ? [entry] : []));
      if (done.length < entries.length) continue;
      const moveFiles = done.flatMap((entry) =>
        entry.prints.before.length || entry.prints.after.length ? [entry.file] : []
      );
      if (!moveFiles.some((f) => f.prints.before.length) || !moveFiles.some((f) => f.prints.after.length)) {
        state.state = 'matched';
        state.result = { moves: [], candidates: { before: 0, after: 0 }, compared: 0, capped: false, ms: 0 };
        continue;
      }
      state.state = 'matching';
      const planned = state.files.length;
      void worker.readMoves(moveFiles).then(
        (result) => {
          if (prs.get(pr.revision) !== pr || pr.families.get(family) !== state) return;
          // Files joined the family meanwhile (`merge`): it is matched again once they are read.
          if (state.files.length !== planned) {
            state.state = 'waiting';
            recheck(pr);
            return;
          }
          state.state = 'matched';
          state.result = result;
          publish(pr, state.files, result.moves);
        },
        () => {
          if (pr.families.get(family) === state) state.state = 'incomplete';
        }
      );
    }
  }

  /** A family's moves: they replace whatever its files had, so a family matched again never shows a note twice. */
  function publish(pr: PrState, keys: readonly string[], moves: readonly SymbolMove[]) {
    const byFile = new Map<string, SymbolMove[]>();
    for (const move of moves)
      for (const key of new Set([move.from.file, move.to.file])) byFile.set(key, [...(byFile.get(key) ?? []), move]);
    let touched = false;
    for (const key of keys) {
      const list = byFile.get(key);
      // Both go: a file's marks are made from its moves, and old marks would outlive a match again.
      const hadMoves = pr.moves.delete(key),
        hadMarks = pr.marks.delete(key);
      const had = hadMoves || hadMarks;
      if (list) pr.moves.set(key, list);
      touched ||= had || !!list;
    }
    if (touched) changed();
  }

  /** A file's marks, made from its moves the first time a view shows it: the line diff of each body runs then. */
  function marksOf(pr: PrState, key: string): FileMoves | undefined {
    const known = pr.marks.get(key);
    if (known) return known;
    const moves = pr.moves.get(key);
    if (!moves) return undefined;
    const marks: MoveMark[] = [];
    for (const move of moves) {
      const edits = moveEdits(move);
      const common = {
        sameFile: move.from.file === move.to.file,
        exact: move.exact,
        renamed: move.renamed,
        similarity: move.similarity,
        commentsChanged: move.commentsChanged,
      };
      for (const [here, other, side] of [
        [move.to, move.from, 'after'],
        [move.from, move.to, 'before'],
      ] as const) {
        if (here.file !== key) continue;
        marks.push({
          side,
          kind: here.kind,
          name: here.name,
          label: here.label,
          start: here.start,
          end: here.end,
          signatureEnd: here.signatureEnd,
          other,
          ...common,
          edits: edits && {
            changed: side === 'after' ? edits.after : edits.before,
            kept: side === 'after' ? edits.kept.after : edits.kept.before,
          },
        });
      }
    }
    const value = { marks: marks.sort((a, b) => a.start - b.start) };
    pr.marks.set(key, value);
    return value;
  }

  return {
    /** Tells `listener` when a file's moves land or leave; the return stops it. */
    onMoves(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    revision: () => version,
    /** A file revision's moves, once its PR's family is matched. */
    peek(fileKey: string): FileMoves | undefined {
      const pr = prs.get(byKey.get(fileKey) ?? '');
      if (!pr) return undefined;
      // A PR a view shows is in use: it is the last to leave.
      pr.at = now();
      return marksOf(pr, fileKey);
    },
    /**
     * Starts matching a PR's files, or picks up where it left off, and holds the PRs for the caller until it releases
     * them: called by each view with every file it shows, each time they change. Files whose text is here (an added
     * file's patch, a side in the cache) are fingerprinted now; `text` finds a modified file's sides in the cache.
     * Returns the files still waiting for a side, for the caller to read, and the release.
     */
    track(
      entries: readonly { snapshot: PrChanges; file: PrChangeFile }[],
      allowed: (path: string) => boolean,
      text: (snapshot: PrChanges, file: PrChangeFile) => { after?: PrFileSide; before?: PrFileSide } | undefined,
      /** What `allowed` says, as a string: a change of Settings plans the PR again. */
      settings = ''
    ): { waiting: { snapshot: PrChanges; file: PrChangeFile }[]; release: () => void } {
      const byRevision = new Map<string, { snapshot: PrChanges; file: PrChangeFile }[]>();
      for (const entry of entries) {
        if (!tracked(entry.snapshot)) continue;
        const key = revisionOf(entry.snapshot);
        byRevision.set(key, [...(byRevision.get(key) ?? []), entry]);
      }
      const waiting: { snapshot: PrChanges; file: PrChangeFile }[] = [];
      let dropped = false;
      // Held before anything leaves: nothing this call touches can make room for something else it touches.
      for (const revision of byRevision.keys()) holds.set(revision, (holds.get(revision) ?? 0) + 1);
      for (const [revision, list] of byRevision) {
        const signature = `${settings}\u0001${list
          .map(({ file }) => `${file.path}\u0000${file.changeId}\u0000${file.status}`)
          .sort()
          .join('\u0001')}`;
        let pr = prs.get(revision);
        if (pr && pr.signature !== signature) {
          // Another view holds it as it was planned: its files stay, and this view's new files join the plan.
          if ((holds.get(revision) ?? 0) > 1) merge(pr, list, allowed);
          else {
            // Another file list or other Settings, and no other view: the PR is planned again from scratch.
            if (drop(revision)) dropped = true;
            pr = undefined;
          }
        }
        if (!pr) {
          const url = list[0].snapshot.url;
          // A new head replaces the PR's old revision, unless a view still shows that one.
          for (const [other, state] of prs) if (state.url === url && !held(other) && drop(other)) dropped = true;
          pr = {
            url,
            revision,
            families: new Map(),
            files: new Map(),
            planned: new Map(),
            moves: new Map(),
            marks: new Map(),
            signature,
            at: now(),
          };
          const plans = list.flatMap((entry) => {
            const plan = movesFilePlan(entry.snapshot, entry.file, allowed);
            return plan ? [{ ...entry, plan }] : [];
          });
          pr.skipped = plans.length > MOVES_MAX_FILES;
          prs.set(revision, pr);
          if (!pr.skipped)
            for (const { snapshot, file, plan } of plans) {
              const key = keyOf(snapshot, file);
              const family = languageFamily(plan.language);
              const state = pr.families.get(family) ?? { files: [], state: 'waiting' as const };
              state.files.push(key);
              pr.families.set(family, state);
              pr.planned.set(key, { snapshot, file, language: movesLanguage(file) ?? plan.language });
              byKey.set(key, revision);
              pr.files.set(
                key,
                plan.readable
                  ? { family, state: 'waiting' }
                  : { family, state: 'failed', reason: plan.reason === 'off' ? 'Language off' : 'No patch' }
              );
            }
        }
        pr.at = now();
        if (pr.skipped) continue;
        for (const [key, entry] of pr.files) {
          const plan = pr.planned.get(key);
          if (!wanting(entry) || !plan) continue;
          const sides = text(plan.snapshot, plan.file);
          const input = movesInput(plan.file, sides?.after, sides?.before);
          if (input === null) fail(pr, key, 'Not text');
          else if (input) fingerprint(pr, key, input);
          else waiting.push({ snapshot: plan.snapshot, file: plan.file });
        }
        recheck(pr);
      }
      // PRs no view holds make room, the least recently used first.
      while (prs.size > MOVES_PR_ENTRIES) {
        let oldest: PrState | undefined;
        for (const state of prs.values())
          if (!held(state.revision) && (!oldest || state.at < oldest.at)) oldest = state;
        if (!oldest || !drop(oldest.revision)) break;
        dropped = true;
      }
      if (dropped) changed();
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        for (const revision of byRevision.keys()) {
          const left = (holds.get(revision) ?? 0) - 1;
          if (left > 0) holds.set(revision, left);
          else holds.delete(revision);
        }
      };
      return { waiting, release };
    },
    /**
     * A file's sides were read (for its scopes, lib/use-syntax-contents.ts): its fingerprints can start. The input
     * comes from the file as the PR lists it, whatever the caller's file says: an Explanation topic's file has only
     * some of the hunks, under the same revision key.
     */
    noteText(snapshot: PrChanges, file: PrChangeFile, after?: PrFileSide, before?: PrFileSide) {
      if (!tracked(snapshot)) return;
      const key = keyOf(snapshot, file);
      const pr = prs.get(byKey.get(key) ?? '');
      const plan = pr?.planned.get(key);
      if (!pr || !plan || !wanting(pr.files.get(key))) return;
      const input = movesInput(plan.file, after, before);
      if (input === null) fail(pr, key, 'Not text');
      else if (input) fingerprint(pr, key, input);
    },
    /** A file's read failed for good: its family is not matched. */
    noteFailure(snapshot: PrChanges, file: PrChangeFile, reason: string) {
      const key = keyOf(snapshot, file);
      const pr = prs.get(byKey.get(key) ?? '');
      if (pr) fail(pr, key, reason);
    },
    /** A read of a file revision (`fileRevisionKey`) was refused or failed for good: its family is not matched. */
    failKey(key: string, failure: { reason: string; recoverable: boolean }) {
      const pr = prs.get(byKey.get(key) ?? '');
      if (pr) fail(pr, key, failure.reason, failure.recoverable);
    },
    /** Whether the store wants a file revision's text: tracked, and not read yet (lib/syntax-scope-client.ts). */
    wants(fileKey: string): boolean {
      const pr = prs.get(byKey.get(fileKey) ?? '');
      return !!pr && wanting(pr.files.get(fileKey));
    },
    /** When each PR was last used, for the inspection caches' idle sweep (#355). */
    uses(into: Map<string, number>) {
      // A PR a view holds is in use now: the idle sweep leaves it, with its queued reads and their budget.
      for (const pr of prs.values()) {
        const at = held(pr.revision) ? now() : pr.at;
        if ((into.get(pr.url) ?? -Infinity) < at) into.set(pr.url, at);
      }
    },
    /** Drops these PRs, or every PR, with the rest of their inspection data: all but those a view holds. */
    forget(urls?: ReadonlySet<string>) {
      let dropped = false;
      for (const [revision, pr] of [...prs])
        if ((!urls || urls.has(pr.url)) && !held(revision) && drop(revision)) dropped = true;
      if (dropped) changed();
    },
    stats() {
      return {
        files: [...prs.values()].reduce((n, pr) => n + pr.files.size, 0),
        marked: [...prs.values()].reduce((n, pr) => n + pr.marks.size, 0),
        prs: [...prs.values()].map((pr) => ({
          url: pr.url,
          skipped: !!pr.skipped,
          families: [...pr.families].map(([family, state]) => ({
            family,
            files: state.files.length,
            done: state.files.filter((key) => pr.files.get(key)?.state === 'done').length,
            failed: state.files.filter((key) => pr.files.get(key)?.state === 'failed').length,
            // Files still on their way, and how far each got.
            pending: state.files.flatMap((key) => {
              const entry = pr.files.get(key);
              return entry?.state === 'waiting' || entry?.state === 'reading'
                ? [{ path: pr.planned.get(key)?.file.path, state: entry.state }]
                : [];
            }),
            state: state.state,
            moves: state.result?.moves.length,
            candidates: state.result?.candidates,
            compared: state.result?.compared,
            capped: state.result?.capped,
            matchMs: state.result && Math.round(state.result.ms * 10) / 10,
          })),
        })),
      };
    },
  };
}
export type MovesStore = ReturnType<typeof createMovesStore>;

/**
 * The store's calls as the app imports them (lib/moved-symbols-store.ts), each bound to the store: one place that
 * forwards every argument, tested with the store itself.
 */
export function movesApi(store: MovesStore) {
  return {
    trackMoves: store.track.bind(store),
    noteMovesText: store.noteText.bind(store),
    noteMovesFailure: store.noteFailure.bind(store),
    failMovesKey: store.failKey.bind(store),
    movesWanted: store.wants.bind(store),
    onMoves: store.onMoves.bind(store),
    movesRevision: store.revision.bind(store),
    peekFileMoves: store.peek.bind(store),
  };
}
