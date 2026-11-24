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
   * The service's name for this file's saved draft (src/conflict-resolution-service.ts `fileRevision`): its conflicts,
   * then its draft, proposals, choices and edits. A save sends it back as `base`.
   */
  revision?: string;
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
  /**
   * You edited the whole file (#503): its draft is your decision, every conflict in it included, while the draft is the
   * text you saved (wholeEdited). Holds the file as it was before your first whole-file edit, which Undo restores. Only
   * the service writes it, from its own copy of the draft; the renderer never sends it.
   */
  wholeEdit?: WholeFileEdit;
}
/** A file before your first whole-file edit (ConflictFile.wholeEdit): what Undo puts back. */
export interface WholeFileEdit {
  result: string;
  resolved: boolean;
  source: ConflictFile['source'];
  explanation?: string;
  resolverText?: string;
  picks?: ConflictFile['picks'];
  edits?: ConflictFile['edits'];
  /** The file changed again after the first whole-file edit: Undo discards that too, so the view asks first. */
  later?: boolean;
  /**
   * The conflicts whose proposal your edit left in place and that you chose to keep as edited (`accept-edit-file`), in
   * a draft that can't be split into its conflicts (#533). Only for the draft you chose it on: any change to the draft
   * drops it, and they are in Check again until you choose.
   */
  accepted?: number[];
}
/** The file as it is now, for Undo of a whole-file edit (ConflictFile.wholeEdit). */
export function wholeEditSnapshot(file: ConflictFile): WholeFileEdit {
  return {
    result: file.result,
    resolved: file.resolved,
    source: file.source,
    ...(file.explanation !== undefined ? { explanation: file.explanation } : {}),
    ...(file.resolverText !== undefined ? { resolverText: file.resolverText } : {}),
    ...(file.picks ? { picks: file.picks } : {}),
    ...(file.edits ? { edits: file.edits } : {}),
  };
}
/** Undo of a whole-file edit: puts `before` back into `file`, and ends the edit. */
export function restoreWholeEdit(file: ConflictFile, before: WholeFileEdit) {
  delete file.wholeEdit;
  delete file.explanation;
  delete file.resolverText;
  delete file.picks;
  delete file.edits;
  const { explanation, resolverText, picks, edits } = before;
  Object.assign(
    file,
    { result: before.result, resolved: before.resolved && !hasConflictMarkers(before.result), source: before.source },
    explanation !== undefined ? { explanation } : {},
    resolverText !== undefined ? { resolverText } : {},
    picks ? { picks } : {},
    edits ? { edits } : {}
  );
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
  source: 'rerere' | 'mergiraf' | 'union' | 'same' | 'layout' | 'moved' | 'model';
  text: string;
  /**
   * A 'moved' proposal: what moved and who edited it, such as "The PR moved orderTotal, and main edited it." A 'model'
   * proposal: how the model says its replacement keeps both sides.
   */
  note?: string;
  /** A 'model' proposal (lib/conflict-model.ts): the provider that wrote it, such as "Claude". */
  by?: string;
  /**
   * A 'layout' proposal that took the place of structural merge's (lib/conflict-union.ts withUnions): that proposal's
   * text, offered again when the checks don't Merge this one (src/conflict-checks.ts withoutUnconfirmed).
   */
  instead?: string;
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
       * The file's `revision` your edit started from. A draft that another writer moved on since `version` still takes
       * the save while this file is the same; when the file changed too, the save is refused (`SAVE_REFUSALS`).
       */
      base?: string;
      /**
       * You chose Reset file or Start from Git's conflict (#533): a whole-file edit ends, when `contents` is that draft.
       * Without it, no draft ends the edit, whatever its text.
       */
      reset?: boolean;
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
  /**
   * Edit whole file (#503): `contents` becomes the draft and the whole file your decision, every conflict in it too. The
   * service keeps the file as it was before your first whole-file edit, for `undo-edit-file`.
   */
  | { kind: 'edit-file'; id: string; version: number; path: string; contents: string; base?: string }
  /**
   * Accept my edit (#533): the proposals your whole-file edit left in place, in a draft that can't be split into its
   * conflicts, become your decision as they are. Only your explicit choice does that; the draft doesn't change.
   */
  | { kind: 'accept-edit-file'; id: string; version: number; path: string; base?: string }
  /** Undo of Edit whole file: the file as it was before your first whole-file edit, your Keeps and edits included. */
  | {
      kind: 'undo-edit-file';
      id: string;
      version: number;
      path: string;
      base?: string;
      /** You chose Undo again after it said it discards a later edit too (`WholeFileEdit.later`). */
      confirmed?: boolean;
    }
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
/** A request made from an earlier version of the draft, refused. */
/** Undo of a whole-file edit that changed again after the first edit, not confirmed yet: nothing is undone. */
export const UNDO_LATER =
  'Undo also discards what you changed after your first whole-file edit. Select Undo again to go on.';
export const STALE_DRAFT = 'The saved resolution changed. Reopen the workspace before continuing.';
/**
 * Saved data can't reach the disk (src/app-data-store.ts): its worker stopped, or it is still closed after a quit that
 * couldn't save. What you just changed was not saved, and only a restart opens saved data again.
 */
export const SAVED_WORK_UNAVAILABLE = 'Saved work isn’t available. Restart Gnosis.';
/** Saved data could not open again after a quit that couldn't save (src/app-data-store.ts `reopen`). */
export const SAVED_WORK_NO_DISK = 'Saved work isn’t available. Free some disk space, then restart Gnosis.';
/** A saved draft the service can't use (`draftProblem`). Start over prepares the merge again. */
export const UNREADABLE_DRAFT = 'This saved draft couldn’t be read.';
/**
 * The first field of a saved draft that can't be used, or undefined. Only the fields every step reads are checked:
 * fields from a newer build are left alone. `resolved` must be a boolean, so nothing reads as reviewed by mistake.
 */
export function draftProblem(value: unknown, account: string, id: string): string | undefined {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!record(value)) return 'draft';
  if (value.account !== account) return 'account';
  if (value.id !== id) return 'id';
  if (value.status !== 'editing' && value.status !== 'published') return 'status';
  if (!Number.isSafeInteger(value.version)) return 'version';
  for (const field of ['url', 'headRepo', 'baseRepo', 'headBranch', 'baseBranch', 'headSha', 'baseSha'])
    if (typeof value[field] !== 'string') return field;
  if (!Array.isArray(value.files)) return 'files';
  for (const [index, file] of value.files.entries()) {
    if (!record(file)) return `files[${index}]`;
    for (const field of ['path', 'original', 'result', 'base', 'ours', 'theirs'])
      if (typeof file[field] !== 'string') return `files[${index}].${field}`;
    if (typeof file.resolved !== 'boolean') return `files[${index}].resolved`;
    // Undo of a whole-file edit (#503) restores it: it needs the draft and review flag it puts back.
    if (
      file.wholeEdit !== undefined &&
      !(
        record(file.wholeEdit) &&
        typeof file.wholeEdit.result === 'string' &&
        typeof file.wholeEdit.resolved === 'boolean' &&
        (file.wholeEdit.accepted === undefined ||
          (Array.isArray(file.wholeEdit.accepted) &&
            file.wholeEdit.accepted.every((index) => Number.isSafeInteger(index) && Number(index) >= 0)))
      )
    )
      return `files[${index}].wholeEdit`;
  }
  return undefined;
}
/**
 * Why the service refused a save made from an earlier version of the draft (`refusedSave`). The renderer matches the
 * message to say what happened and offer what can still be done.
 */
export const SAVE_REFUSALS = {
  /** Another view saved this file: the same conflicts, another draft. Keep my edit may replace it. */
  changed: 'This file’s saved draft changed in another view while you edited it, so your edit wasn’t saved.',
  /** The file's conflicts are new (Start over, new base commits): the edit no longer fits them. */
  conflicts: 'This file’s conflicts changed in another view while you edited it, so your edit wasn’t saved.',
  /** The file is no longer in the merge. */
  left: 'This file is no longer in the merge, so your edit wasn’t saved.',
  /** Another view pushed the resolution. */
  pushed: 'This PR’s resolution was pushed from another view.',
} as const;
export type SaveRefusal = keyof typeof SAVE_REFUSALS;
/** The refusal an error carries, or undefined. */
export function refusedSave(error: unknown): SaveRefusal | undefined {
  const message = error instanceof Error ? error.message : String(error);
  return (Object.keys(SAVE_REFUSALS) as SaveRefusal[]).find((reason) => message.includes(SAVE_REFUSALS[reason]));
}
/** The part of a file's `revision` that names its conflicts (Git's conflict text and the path). */
export const revisionConflicts = (revision: string | undefined) => revision?.split('.')[0];
/** The paths whose saved file is another one in `after` than in `before`, by `revision`; `except` left out. */
export function changedFiles(before: ConflictSession, after: ConflictSession, except?: string) {
  const known = new Map(before.files.map((f) => [f.path, f.revision]));
  return after.files.filter((f) => f.path !== except && known.get(f.path) !== f.revision).map((f) => f.path);
}
/** A line Git writes around a conflict. A lone `=======` counts in every text; a draft goes through markersLeft. */
const markerLines = (marks: string) => new RegExp(`^(?:${marks})(?:\\s|$)`, 'm');
/** The marks Git opens and closes a conflict with, and puts before the common ancestor: never a heading underline. */
const OPEN_CLOSE_MARKS = '<{7,}|>{7,}|\\|{7,}';
const MARKER_LINES = markerLines(`${OPEN_CLOSE_MARKS}|={7,}`);
/** A `<<<<<<<`, `|||||||` or `>>>>>>>` line: every marker but the separator (lib/conflict-carry.ts `markersLeft`). */
export const OPEN_CLOSE_LINES = markerLines(OPEN_CLOSE_MARKS);
/** Any conflict marker line left in a text, such as a proposal's. A file's draft goes through markersLeft. */
export function hasConflictMarkers(text: string) {
  return MARKER_LINES.test(text);
}

/**
 * The file's whole-file proposal by source: structural merge's (`'mergiraf'`), or the move rule's (`'moved'`,
 * lib/conflict-moved.ts). Undefined for none, or one from another source.
 */
export function wholeFileFrom<S extends ConflictProposal['source']>(
  file: Pick<ConflictFile, 'wholeFile'>,
  source: S
): (ConflictProposal & { source: S }) | undefined {
  return file.wholeFile?.source === source ? (file.wholeFile as ConflictProposal & { source: S }) : undefined;
}

export type ConflictFileStage = 'conflicted' | 'resolved' | 'reviewed';
/**
 * The marked lines of an in-place edit that are its own (#509): whole indexes into the edit's lines. One past them
 * would mark a line after the conflict.
 */
export function writtenInEdit(text: string, written: readonly unknown[] | undefined): number[] {
  const lines = text.split(/(?<=\n)/).filter(Boolean).length;
  return (written ?? []).filter((line): line is number => Number.isSafeInteger(line) && Number(line) >= 0 && Number(line) < lines);
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
          writtenInEdit(e.text, e.written as unknown[]).length === e.written.length))
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
    (r.base === undefined || (r.kind === 'save' && text('base', 64))) &&
    (r.reset === undefined || (r.kind === 'save' && typeof r.reset === 'boolean'))
  )
    return;
  // Edit whole file (#503) names the file's revision its editor started from (`base`), as a save does.
  const based = r.base === undefined || text('base', 64);
  if (r.kind === 'edit-file' && text('path', 4096) && text('contents', CONFLICT_FILE_LIMIT) && based) return;
  if (r.kind === 'accept-edit-file' && text('path', 4096) && based) return;
  if (
    r.kind === 'undo-edit-file' &&
    text('path', 4096) &&
    based &&
    (r.confirmed === undefined || typeof r.confirmed === 'boolean')
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
