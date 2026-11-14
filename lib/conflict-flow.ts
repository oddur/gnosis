import type { ConflictFileStage } from './conflict-resolution';

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
}): ConflictFileAction {
  if (!state.stage) return 'none';
  if (state.unsupported) return state.otherFilesPending ? 'next-file' : 'none';
  if (state.stage === 'conflicted') return 'next-conflict';
  if (state.stage === 'resolved') return state.resultShown ? 'mark-reviewed' : 'review-result';
  return state.otherFilesPending ? 'next-file' : 'confirm';
}

export type ConflictRecovery = 'load-latest' | 'check-again' | 'retry';
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
  if (/\(stale info\)|\bstale info\b|\(fetch first\)|non-fast-forward|failed to push some refs.*lease/i.test(raw))
    return {
      title: `Someone pushed to ${head} after you started.`,
      body: 'Nothing was pushed. Your resolutions are saved. Load the latest changes to continue; resolutions that still match are reused.',
      recovery: 'load-latest',
      details,
    };
  if (/PR or (?:its )?base branch changed/i.test(raw))
    return {
      title: `${head} or ${base} changed after you started.`,
      body: 'Nothing was pushed. Your resolutions are saved. Load the latest changes to continue; resolutions that still match are reused.',
      recovery: 'load-latest',
      details,
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
