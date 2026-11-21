import type { BaseMove, ConflictFile, ConflictFileStage } from './conflict-resolution';
import { githubWriteError, WORKFLOW_PERMISSION_LABEL, WORKFLOW_PUSH_WARNING } from './github-access';

/**
 * The one next action for the selected file. Each state has exactly one primary action, so the
 * footer never offers competing equal-weight buttons.
 */
export type ConflictFileAction = 'next-conflict' | 'review-result' | 'mark-reviewed' | 'next-file' | 'confirm' | 'none';
export function conflictFileAction(state: {
  stage: ConflictFileStage | undefined;
  /** The current result has been shown next to the PR version. */
  resultShown: boolean;
  /** Another file still needs resolving or review. */
  otherFilesPending: boolean;
  unsupported?: boolean;
  /** Every conflict is Merged: its results are on screen, so Mark reviewed needs no separate Review result. */
  merged?: boolean;
}): ConflictFileAction {
  if (!state.stage) return 'none';
  if (state.unsupported) return state.otherFilesPending ? 'next-file' : 'none';
  if (state.stage === 'conflicted') return 'next-conflict';
  if (state.stage === 'resolved') return state.resultShown || state.merged ? 'mark-reviewed' : 'review-result';
  return state.otherFilesPending ? 'next-file' : 'confirm';
}

export const STRUCTURAL_UNAVAILABLE = 'Structural merge isn’t available in this build.';
/**
 * "Try structural merge again": where structural merge timed out or couldn't combine the sides, or an earlier resolution
 * stands in for it. Only on the draft as prepared (`unchanged`), so it never replaces your choices or edits, and never
 * where this build has no Mergiraf or a whole-file proposal already holds its result.
 */
export function canRetryStructural(
  file: Pick<ConflictFile, 'wholeFile' | 'structuralNote' | 'source' | 'proposals' | 'unsupported'>,
  unchanged: boolean
) {
  if (!unchanged || file.unsupported || file.wholeFile || file.structuralNote === STRUCTURAL_UNAVAILABLE) return false;
  // Structural merge already ran and left these conflicts open: running it again would throw the unions away.
  if (file.proposals?.some((p) => p?.source === 'union')) return false;
  return !!file.structuralNote || file.source === 'rerere' || !!file.proposals?.some((p) => p?.source === 'rerere');
}

/** A ref name that is safe to show in a shell command, even quoted: no spaces, quotes, `$`, backticks or `;`. */
const SAFE_REF = /^[A-Za-z0-9._/-]+$/;
/** One shell word: single quotes, with an embedded `'` closed, escaped and reopened. */
export const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
/**
 * The commands that start a local merge of the base branch into the PR branch, for a conflict Gnosis can't write as
 * text. Branch and repository names come from the PR's author, so every one is quoted, and a name with any character
 * outside letters, digits, `.`, `_`, `/` and `-` gets no commands at all (undefined): pasting it must never run code.
 */
export function localMergeCommands(session: {
  headRepo: string;
  baseRepo: string;
  headBranch: string;
  baseBranch: string;
}): string | undefined {
  const { headRepo, baseRepo, headBranch, baseBranch } = session;
  if (![headRepo, baseRepo, headBranch, baseBranch].every((name) => SAFE_REF.test(name))) return undefined;
  // A fork's clone has no remote for the base repository: fetch the base branch by URL.
  const base =
    headRepo === baseRepo
      ? [`git fetch origin ${shellQuote(baseBranch)}`, `git merge ${shellQuote(`origin/${baseBranch}`)}`]
      : [
          `git fetch ${shellQuote(`https://github.com/${baseRepo}.git`)} ${shellQuote(baseBranch)}`,
          'git merge FETCH_HEAD',
        ];
  return [`git switch ${shellQuote(headBranch)}`, 'git pull', ...base].join('\n');
}

export type ConflictRecovery = 'load-latest' | 'check-again' | 'retry' | 'sign-in';
export interface ConflictErrorCopy {
  /** One plain sentence: what happened. */
  title: string;
  /** What it means for the user's work and what to do next. */
  body: string;
  recovery?: ConflictRecovery;
  /** The raw Git or service output, shown only under Details. */
  details?: string;
}

const strip = (text: string) => text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').trim();

/**
 * Plain copy for conflict errors. Pushing is never retried automatically: after a failed push the
 * only recovery is to read the branch again, which also reconciles a push whose reply was lost.
 */
export function describeConflictError(
  error: string,
  context: { stage: 'prepare' | 'push' | 'other'; headBranch?: string; baseBranch?: string }
): ConflictErrorCopy {
  const raw = strip(error);
  const head = context.headBranch ?? 'the PR branch';
  const base = context.baseBranch ?? 'the base branch';
  const git = /^Git could not complete this operation\./.test(raw);
  const details = raw;
  const reload =
    'Nothing was pushed. Your resolutions are saved. Select Load latest changes to merge the new commits; resolutions that still apply are reused.';
  // GitHub refuses a push that changes workflow files from a sign-in without `workflow`. It refused outright, so
  // nothing was pushed, and signing in again is the way forward.
  if (githubWriteError(raw).workflowPermission)
    return {
      title: `${WORKFLOW_PERMISSION_LABEL}.`,
      body: `${WORKFLOW_PUSH_WARNING} Nothing was pushed. Your resolutions are saved.`,
      recovery: 'sign-in',
      details,
    };
  if (
    /\(stale info\)|\bstale info\b|\(fetch first\)|non-fast-forward|failed to push some refs.*lease/i.test(raw) ||
    /^The PR branch has new commits/.test(raw) ||
    // Before Gnosis told a moved PR branch apart from a moved base branch.
    /PR or (?:its )?base branch changed/i.test(raw)
  )
    return { title: `Someone pushed to ${head} after you started.`, body: reload, recovery: 'load-latest', details };
  if (/^The PR now targets a different base branch/.test(raw))
    return {
      title: 'This PR now targets a different base branch.',
      body: 'Nothing was pushed. Your resolutions are saved. Select Load latest changes to merge the new base branch; resolutions that still apply are reused.',
      recovery: 'load-latest',
    };
  if (/^The base branch kept moving/.test(raw))
    return {
      title: `${base} kept changing while Gnosis updated the merge.`,
      body: `Nothing was pushed. Your resolutions are saved. Select ${
        context.stage === 'push' ? 'Push merge commit' : 'Review and push…'
      } again in a moment.`,
    };
  if (
    /protected branch|GH006|pre-receive hook declined|required status check|Changes must be made through a pull request/i.test(
      raw
    )
  )
    return {
      title: `Branch protection blocked the push to ${head}.`,
      body: 'Nothing was pushed. Your resolutions are saved. Ask a repository admin, or resolve the conflicts on GitHub.',
      recovery: 'check-again',
      details,
    };
  if (/cannot update this PR branch|need permission|permission to|Permission denied|403|not allowed to push/i.test(raw))
    return {
      title: `Your GitHub account can’t push to ${head}.`,
      body:
        context.stage === 'push'
          ? 'Nothing was pushed. Your resolutions are saved.'
          : 'Ask the author to allow edits from maintainers, or resolve the conflicts on GitHub.',
      recovery: context.stage === 'push' ? 'check-again' : undefined,
      details: git ? details : undefined,
    };
  if (
    /Could not resolve host|unable to access|timed? ?out|ETIMEDOUT|ECONNRESET|ENOTFOUND|network|Connection (?:refused|reset|closed)/i.test(
      raw
    )
  )
    return context.stage === 'push'
      ? {
          title: 'Gnosis lost the connection to GitHub during the push.',
          body: 'Your resolutions are saved. Check again to see whether the push reached GitHub; Gnosis never resends it on its own.',
          recovery: 'check-again',
          details,
        }
      : {
          title: 'Gnosis couldn’t reach GitHub.',
          body: 'Check your connection, then try again.',
          recovery: 'retry',
          details,
        };
  if (context.stage === 'push')
    return {
      title: `Gnosis couldn’t confirm the push to ${head}.`,
      body: 'Your resolutions are saved. Check again to read the branch; Gnosis never resends the push on its own.',
      recovery: 'check-again',
      details,
    };
  if (context.stage === 'prepare')
    return git
      ? {
          title: 'Gnosis couldn’t prepare this merge.',
          body: 'Git stopped before the conflicts were ready. Nothing was changed. Try again, or resolve the conflicts in a local clone.',
          recovery: 'retry',
          details,
        }
      : { title: 'Gnosis couldn’t prepare this merge.', body: raw, recovery: 'retry' };
  return git
    ? { title: 'Git couldn’t finish this step.', body: 'Your resolutions are saved. Nothing was pushed.', details }
    : { title: raw, body: '' };
}

/**
 * One line after Gnosis merged new base commits again. With no new conflicts the preview or push went ahead; with new
 * conflicts the user resolves only those, and nothing was pushed.
 */
export function describeBaseMove(move: BaseMove, context: { baseBranch: string; stage: 'preview' | 'push' }) {
  const base = context.baseBranch;
  if (!move.conflicts)
    return context.stage === 'push'
      ? `${base} moved while you worked, so the merge commit includes its latest changes. Your resolutions still applied.`
      : `${base} moved while you worked. Gnosis updated the merge; your resolutions still apply.`;
  const conflicts = move.conflicts === 1 ? 'a new conflict' : `${move.conflicts} new conflicts`;
  const where = move.files.length === 1 ? move.files[0] : `${move.files.length} files`;
  return `${base} moved and brought ${conflicts} in ${where}. Nothing was pushed. Your other resolutions are kept.`;
}
