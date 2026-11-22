export interface ConflictFile {
  path: string;
  mode: string;
  base: string;
  ours: string;
  theirs: string;
  original: string;
  result: string;
  /** Human review acknowledgement; marker-free proposals alone are not reviewed. */
  resolved: boolean;
  source: 'manual' | 'mergiraf' | 'agent' | 'rerere';
  explanation?: string;
  unsupported?: string;
  /**
   * What preparation resolved on its own, per conflict block of `original` (null: no safe proposal). `result` starts
   * with these applied. The main process checks them (`verdict`) before one counts as Merged.
   */
  proposals?: (ConflictProposal | null)[];
  /**
   * Your Keep choice per block of `original`, saved with the draft, so a Keep whose text equals the proposal still reads
   * as yours, never as Merged, after the view closes or reopens (#445 item 8). `proposal`: you chose Use the proposal
   * after choosing something else, so the push confirmation lists it as yours (#445 item 12).
   */
  picks?: ('ours' | 'theirs' | 'both' | 'proposal' | null)[];
  /**
   * Your in-place edits per block of `original` (#445 item 11), saved with the draft as `picks` are, so an edited
   * conflict keeps its card, Undo and Edit after a reopen. Each holds the text you saved for the conflict, the choice
   * and pick it replaced (Undo restores them) and the resolver's lines you left as they were (`written`).
   */
  edits?: (SavedBlockEdit | null)[];
  /**
   * Structural merge's result for the whole file, when it also changes lines outside Git's conflicts and so cannot be
   * split into per-block proposals. Always Check, never Merged. Accepting it makes it the draft, like a Suggest result.
   */
  wholeFile?: ConflictProposal;
  /**
   * The whole draft a resolver last wrote for this file (#445 item 10): a remembered resolution, structural merge's
   * result, a whole-file proposal you used, or a suggestion. It stays when you then keep or edit parts of the draft, so
   * the lines the resolver wrote that neither side had stay marked, and lines you typed never are.
   */
  resolverText?: string;
  /**
   * Conflicts whose text was a model's proposal before main moved or the merge was prepared again
   * (lib/conflict-carry.ts): they are open again, and their cards say to ask again. By block index of `original`.
   */
  modelStale?: number[];
  /** Why structural merge proposed nothing for this file during preparation, such as a timeout. */
  structuralNote?: string;
  /** Structural merge gave this file a result: proposals, a whole-file proposal, or a note that it couldn't. */
  structuralRan?: boolean;
  /**
   * The checks of `proposals` or `wholeFile`, run by the main process (src/conflict-checks.ts), with the proposals'
   * fingerprint (`proposalKey`). It counts only while that fingerprint matches.
   */
  verdict?: { key: string; verdict: import('./conflict-verify').Verdict };
  /**
   * Each conflict block's bucket when you first opened it, for the local stats in Settings › Diagnostics
   * (lib/conflict-stats.ts), with the block's fingerprint and whether it was counted as undone or re-chosen. A block
   * that is present was counted as shown; null is one not counted yet.
   */
  statsBlocks?: (import('./conflict-stats').StatsBlock | null)[];
  /**
   * New type errors the opt-in type check found in this file (#445 item 24), for the draft it checked (`typeCheckKey`).
   * Every Merged proposal in the file is Check with this note, or only the conflicts in `blocks` when each error was
   * inside a conflict. It stays until a finished run says otherwise, or the check is turned off (`typeErrorOf`).
   */
  typeError?: TypeErrorMark;
}
/**
 * One conflict block resolved during preparation: by your earlier resolution, by structural merge, or where structural
 * merge left it, as both sides' additions or as the PR's version of a change both sides made (lib/conflict-union.ts).
 * A 'moved' proposal is only ever a whole-file proposal (`wholeFile`): one side moved or renamed a function and the
 * other edited it, and the edit is applied at the new place (lib/conflict-moved.ts). It is never Merged. A 'model'
 * proposal is one conflict's replacement from the selected model (lib/conflict-model.ts), checked like the others and
 * never Merged either.
 */
export interface ConflictProposal {
  source: 'rerere' | 'mergiraf' | 'union' | 'same' | 'moved' | 'model';
  text: string;
  /**
   * A 'moved' proposal: what moved and who edited it, such as "The PR moved orderTotal, and main edited it." A 'model'
   * proposal: how the model says its replacement keeps both sides.
   */
  note?: string;
  /** A 'model' proposal (lib/conflict-model.ts): the provider that wrote it, such as "Claude". */
  by?: string;
  /** A 'model' proposal: what the model says each side meant. The model's words, never checked. */
  intents?: { pr: string; main: string };
}
export interface ConflictSession {
  id: string;
  account: string;
  url: string;
  title: string;
  headRepo: string;
  baseRepo: string;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  baseSha: string;
  tree: string;
  files: ConflictFile[];
  version: number;
  status: 'editing' | 'published';
  preparation?: 'conflicts' | 'clean-merge' | 'up-to-date';
  commitSha?: string;
  stale?: boolean;
  /** Why a draft is stale: someone pushed to the PR, or the PR targets another base branch. */
  staleReason?: 'head-moved' | 'retargeted';
  dependents?: string[];
  /**
   * Prepared in the background (src/conflict-precompute.ts) at this time (epoch ms), and not opened since. Such a draft
   * is replaced when the PR moves, and evicted by count and age. Opening it makes it yours.
   */
  background?: number;
  restack?: RestackPlan;
  /**
   * Reopened after a push from an earlier session, and GitHub reports no conflicts now. The workspace says there is
   * nothing to resolve and keeps that push (`lastPush`) as history. Never saved.
   */
  reopened?: boolean;
  /**
   * The push from an earlier session that this fresh preparation follows, while it is still the PR head (or while
   * dependent PRs still wait for a restack): its merge commit, the head to reset to for undo, and the dependent PRs it
   * left to restack.
   */
  lastPush?: { commitSha: string; headSha: string; unrestacked?: string[] };
  /**
   * Undo this update (#445 item 25) pushed the previous head back, or is pushing it. Saved before the push, so a reopen
   * finishes an undo whose reply or status write was lost.
   */
  undoing?: boolean;
  /**
   * Why a pending undo could not be settled when the workspace opened: the branch couldn't be read, or it is at
   * another commit. Never saved.
   */
  undoUnsettled?: 'unread' | 'elsewhere';
}
export interface RestackPlan {
  token: string;
  status: 'prepared' | 'blocked' | 'published';
  rootSha: string;
  expected: { url: string; headSha: string; baseSha: string; headBranch: string; baseBranch: string }[];
  branches: {
    url: string;
    title: string;
    repo: string;
    branch: string;
    baseBranch: string;
    baseRepo: string;
    oldSha: string;
    newSha: string;
    baseSha: string;
    commits: number;
    reused: number;
    /** Conflicts the replay resolved with the main merge's pipeline and that passed every check (#445 item 21). */
    merged?: number;
    /** Conflicts resolved by you: decided in a pause, or your earlier choice carried over to the same conflict. */
    yours?: number;
    /** Merge commits the replay recreated. A clean recreation can still lose what the original merge added. */
    merges?: number;
    /**
     * The update needs its Reviewed tick. False only when the replay recreated no merge commit and had no conflict, or
     * every conflict was Merged by the checks: nothing you decided, carried or remembered. Missing (a plan from an
     * earlier version) counts as true.
     */
    review?: boolean;
    patch: string;
    files: import('@pierre/diffs').FileDiffMetadata[];
  }[];
  blocked?: {
    url: string;
    title: string;
    reason: string;
    paths: string[];
    files: ConflictFile[];
    reused: number;
    /** What the paused PR's replay settled before this pause: Merged by the checks, and yours (carried). */
    merged?: number;
    yours?: number;
    /** The new Check or Decide conflicts this pause stops on (#445 item 22). */
    open?: number;
    /**
     * Where the replay paused: the commit being replayed (REBASE_HEAD) and the worktree's HEAD. Continue writes the
     * paused files only while the worktree is still there, on these conflicted paths; a pause without them is stale.
     */
    commit?: string;
    head?: string;
  };
}
export type ConflictRequest =
  /** `restart` prepares a fresh merge. With `keep`, resolutions whose conflicts are unchanged carry over. */
  | { kind: 'open'; url: string; restart?: boolean; keep?: boolean }
  | {
      kind: 'save';
      id: string;
      version: number;
      path: string;
      contents: string;
      resolved: boolean;
      /** Your Keep choices per block (`ConflictFile.picks`); absent leaves the saved ones. */
      picks?: ('ours' | 'theirs' | 'both' | 'proposal' | null)[];
      /** Your in-place edits per block (`ConflictFile.edits`); absent leaves the saved ones. */
      edits?: (SavedBlockEdit | null)[];
      /**
       * The file as your edit started from it (`fileDraftKey`). A draft that another writer moved on since `version`
       * still takes the save while this file is the same; when the file changed too, the save is refused.
       */
      base?: string;
    }
  | {
      kind: 'resolve';
      id: string;
      version: number;
      /** `whole-file`: the file's whole-file proposal (`wholeFile`) as it is, whoever made it. Nothing runs again. */
      engine: 'mergiraf' | 'agent' | 'whole-file';
      path: string;
      instructions?: string;
    }
  /**
   * Puts the model's proposal for conflict `index` (askModel in src/conflict-resolution-service.ts) into the draft and
   * checks it. Only the conflict's own span changes, and only while it is still open.
   */
  | { kind: 'model'; id: string; version: number; path: string; index: number }
  | { kind: 'preview'; id: string; version: number }
  | { kind: 'publish'; id: string; version: number; previewToken: string; message: string }
  | { kind: 'discard'; id: string; version: number }
  /** Undo this update: push the previous head back with a lease on the merge commit. The draft returns to editing. */
  | { kind: 'undo-publish'; id: string; version: number }
  | { kind: 'restack-prepare'; id: string; version: number }
  | { kind: 'restack-continue'; id: string; version: number }
  | {
      kind: 'restack-save';
      id: string;
      version: number;
      path: string;
      contents: string;
      resolved: boolean;
      /** Your Keep choices per block, as for `save`. */
      picks?: ('ours' | 'theirs' | 'both' | 'proposal' | null)[];
      /** Your in-place edits per block, as for `save`. */
      edits?: (SavedBlockEdit | null)[];
    }
  | { kind: 'restack-publish'; id: string; version: number; previewToken: string; reviewed: string[] };
/**
 * The base branch moved while the user resolved conflicts, and Gnosis merged its latest commit again. `conflicts`
 * counts the new conflicts the user must resolve; with none, the preview or push went ahead.
 */
export interface BaseMove {
  from: string;
  to: string;
  conflicts: number;
  /** Files with new conflicts. */
  files: string[];
}
/** New type errors in the PR, saved on a conflicted file: `note` for every Merged proposal in it. */
export interface TypeErrorMark {
  key: string;
  note: string;
}
/**
 * The opt-in type check of a prepared merge (#445 item 24): the PR's TypeScript compiler, from your linked clone, run on
 * the merge result in a private worktree. A new error anywhere demotes every conflicted file: `files` lists each, with
 * the fingerprint of the draft it was checked with (`typeCheckKey`). `checked`: every file's key the finished run
 * checked, by path. A result counts only for that draft (`typeCheckFor`).
 */
export type ConflictTypeCheck =
  /** The draft changed: it is checked again once your changes stop. */
  | { state: 'waiting' }
  | { state: 'running' }
  | { state: 'passed'; preExisting: number; checked?: Record<string, string> }
  | {
      state: 'errors';
      checked?: Record<string, string>;
      count: number;
      preExisting: number;
      /** The first new errors, one line each: "path:line TS1234 message". */
      errors: string[];
      files: (TypeErrorMark & { path: string })[];
    }
  | { state: 'skipped'; reason: string }
  /** The compiler ran but did not check types, such as for an options or syntax error. Never passed. */
  | { state: 'unchecked'; reason: string }
  | { state: 'cancelled' };
export interface ConflictReply {
  session: ConflictSession;
  preview?: { patch: string; token: string; validation: string; files: import('@pierre/diffs').FileDiffMetadata[] };
  baseMoved?: BaseMove;
}
/** A conflict you edited in place, as the draft saves it (ConflictFile.edits). */
export interface SavedBlockEdit {
  text: string;
  before: 'ours' | 'theirs' | 'both' | 'proposal' | null;
  pick: 'ours' | 'theirs' | 'both' | 'proposal' | null;
  written?: number[];
}
export const CONFLICT_FILE_LIMIT = 1024 * 1024;
/** A save refused because the file it edits changed underneath it. The renderer matches it to offer the recovery. */
export const FILE_DRAFT_CHANGED = 'This file’s saved draft changed while you edited it, so your edit wasn’t saved.';
/**
 * The parts of a file a save builds on: Git's conflict, the draft, its proposals and your choices and edits. Two
 * 32-bit FNV-1a hashes with the length, over the same JSON in the renderer and the main process. The checks' verdicts
 * and the type check's demotions are not in it: the service checks a save against its own, whatever the renderer saw.
 */
export function fileDraftKey(
  file: Pick<ConflictFile, 'path' | 'original' | 'result' | 'proposals' | 'picks' | 'edits'>
) {
  const { path, original, result, proposals, picks, edits } = file;
  const text = JSON.stringify([path, original, result, proposals ?? null, picks ?? null, edits ?? null]);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
    b ^= b >>> 15;
  }
  return `${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}.${text.length.toString(36)}`;
}
/** A line Git writes around a conflict. A lone `=======` counts in every file, a Markdown heading underline too. */
const MARKER_LINE = /^(?:<{7,}|={7,}|>{7,}|\|{7,})(?:\s|$)/;
const MARKER_LINES = new RegExp(MARKER_LINE.source, 'm');
/** Any conflict marker line left in a text: the file status, Mark reviewed and every guard before a push use it. */
export function hasConflictMarkers(text: string) {
  return MARKER_LINES.test(text);
}

export type ConflictFileStage = 'conflicted' | 'resolved' | 'reviewed';
/** Derive the stage from the displayed draft, including edits not saved yet. */
export function conflictFileStage(
  file: Pick<ConflictFile, 'unsupported' | 'result' | 'resolved'>,
  contents = file.result
): ConflictFileStage {
  if (file.unsupported || hasConflictMarkers(contents)) return 'conflicted';
  return file.resolved && contents === file.result ? 'reviewed' : 'resolved';
}

const isPick = (pick: unknown) =>
  pick === null || pick === 'ours' || pick === 'theirs' || pick === 'both' || pick === 'proposal';
/** Saved in-place edits from the renderer: bounded, with nothing but their four fields. */
function validEdits(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 10_000) return false;
  // Every edit's text is part of the draft, so together they fit in one file.
  let total = 0;
  return (value as unknown[]).every((edit) => {
    if (edit === null) return true;
    if (!edit || typeof edit !== 'object') return false;
    const e = edit as Record<string, unknown>;
    return (
      Object.keys(e).every((key) => ['text', 'before', 'pick', 'written'].includes(key)) &&
      typeof e.text === 'string' &&
      (total += e.text.length) <= CONFLICT_FILE_LIMIT &&
      isPick(e.before) &&
      isPick(e.pick) &&
      (e.written === undefined ||
        (Array.isArray(e.written) &&
          e.written.length <= 100_000 &&
          (e.written as unknown[]).every((line) => Number.isSafeInteger(line) && Number(line) >= 0)))
    );
  });
}
/** IPC is an untyped boundary even when renderer callers use TypeScript. */
export function validateConflictRequest(value: unknown): asserts value is ConflictRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid conflict operation.');
  const r = value as Record<string, unknown>;
  const text = (key: string, limit: number) =>
    typeof r[key] === 'string' && r[key].length <= limit && !r[key].includes('\0');
  if (r.kind === 'open') {
    if (
      !text('url', 2048) ||
      !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(r.url as string) ||
      (r.restart !== undefined && typeof r.restart !== 'boolean') ||
      (r.keep !== undefined && typeof r.keep !== 'boolean')
    )
      throw new Error('Choose a valid GitHub PR.');
    return;
  }
  if (
    !text('id', 64) ||
    !/^[a-f0-9]{64}$/.test(r.id as string) ||
    !Number.isSafeInteger(r.version) ||
    Number(r.version) < 1
  )
    throw new Error('Invalid conflict session.');
  if (
    (r.kind === 'save' || r.kind === 'restack-save') &&
    text('path', 4096) &&
    text('contents', CONFLICT_FILE_LIMIT) &&
    typeof r.resolved === 'boolean' &&
    (r.picks === undefined ||
      (Array.isArray(r.picks) && r.picks.length <= 10_000 && (r.picks as unknown[]).every(isPick))) &&
    (r.edits === undefined || validEdits(r.edits)) &&
    (r.base === undefined || (r.kind === 'save' && text('base', 64)))
  )
    return;
  if (
    r.kind === 'resolve' &&
    ['agent', 'mergiraf', 'whole-file'].includes(String(r.engine)) &&
    text('path', 4096) &&
    (r.instructions === undefined || text('instructions', 10000))
  )
    return;
  if (r.kind === 'model' && text('path', 4096) && Number.isSafeInteger(r.index) && Number(r.index) >= 0 && Number(r.index) < 10_000)
    return;
  if (
    r.kind === 'preview' ||
    r.kind === 'discard' ||
    r.kind === 'undo-publish' ||
    r.kind === 'restack-prepare' ||
    r.kind === 'restack-continue'
  )
    return;
  if (
    r.kind === 'restack-publish' &&
    text('previewToken', 64) &&
    Array.isArray(r.reviewed) &&
    r.reviewed.length <= 30 &&
    r.reviewed.every((value) => typeof value === 'string' && value.length <= 2048)
  )
    return;
  if (r.kind === 'publish' && text('previewToken', 64) && text('message', 2000)) return;
  throw new Error('Invalid conflict operation.');
}
