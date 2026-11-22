/**
 * Undo this update (#445 item 25): after a conflict resolution is pushed, push the PR's previous head back with a lease
 * on the merge commit. Off unless a repository allows it in Repository settings, since it force-pushes a shared branch.
 */

/** The manual steps, for repositories that don't allow the force push. */
export const UNDO_DOCS_URL = 'https://github.com/oddur/gnosis/blob/main/docs/conflict-resolution.md#undo-an-update';

// The service's refusals. Each says that nothing changed: an undo that is refused never pushes.
export const UNDO_OFF =
  'Undoing a conflict update is off for this repository. Nothing was changed. Turn it on in Repository settings, or revert the merge commit.';
export const UNDO_UNAVAILABLE = 'This update can no longer be undone from Gnosis. Nothing was changed.';
export const UNDO_RESTACKED =
  'Dependent PRs were restacked onto this merge commit, so Gnosis can’t undo it. Nothing was changed.';
export const UNDO_CLOSED = 'This PR is merged or closed, so Gnosis can’t undo the update. Nothing was changed.';
export const UNDO_MOVED = 'New commits are on the PR branch after the merge commit.';
/**
 * An interrupted undo Gnosis could not settle: it says which check failed, only what it knows. Nothing is pushed from
 * here; you start over from the current head with your resolutions, or discard the draft.
 */
export function unsettledUndoCopy(reason: 'unread' | 'elsewhere' | undefined, branch: string) {
  const why =
    reason === 'unread'
      ? `Gnosis couldn’t read ${branch} to see whether the last undo reached GitHub.`
      : reason === 'elsewhere'
        ? `${branch} is at another commit, neither the merge commit nor the commit before it, so Gnosis can’t tell whether the last undo reached GitHub.`
        : 'Gnosis couldn’t tell whether the last undo reached GitHub.';
  return `${why} Your draft is kept, and nothing more is pushed. Start over from the branch as it is now, with your resolutions, or discard the draft.`;
}

/** A pushed update while its merge commit is the PR head (the service's `pushed`): what Undo this update needs. */
export interface PushedUpdate {
  id: string;
  version: number;
  url: string;
  headRepo: string;
  baseRepo: string;
  headBranch: string;
  baseBranch: string;
  /** The PR head before the update: the commit Undo pushes back. */
  headSha: string;
  commitSha: string;
}

/**
 * The one rule for whether a draft's push can be undone, in the PR header (the service's `pushed`), the workspace and
 * the service: a published draft with its merge commit, no undo in flight, and no restack plan of any state, since a
 * prepared or published restack builds on the merge commit.
 */
export function undoTarget(session: {
  id: string;
  version: number;
  url: string;
  status: string;
  headRepo: string;
  baseRepo: string;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  commitSha?: string;
  undoing?: boolean;
  restack?: unknown;
}): PushedUpdate | undefined {
  if (session.status !== 'published' || !session.commitSha || session.undoing || session.restack) return undefined;
  const { id, version, url, headRepo, baseRepo, headBranch, baseBranch, headSha, commitSha } = session;
  return { id, version, url, headRepo, baseRepo, headBranch, baseBranch, headSha, commitSha };
}

/** Whether a repository allows Undo this update. Unset is off: the setting fails closed. */
export function undoAllowed(settings: { allowConflictUndo?: boolean } | undefined) {
  return settings?.allowConflictUndo === true;
}

export interface UndoErrorCopy {
  title: string;
  body?: string;
  details?: string;
  /** The revert, to copy, where a revert is the way left (revertCommands). */
  commands?: string;
}

const strip = (text: string) => text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').trim();

/** GitHub's own words from a refused push: its `remote:` lines, without the `error:` prefixes. */
export function remoteMessage(raw: string) {
  return raw
    .split(/\r?\n/)
    .map((line) => /(?:^|\s)remote:\s*(?:error:\s*)?(.*)$/i.exec(line.trim())?.[1]?.trim() ?? '')
    .filter((line) => line && !/^-+$/.test(line))
    .join(' ');
}

/** Plain copy for a failed undo. A failed push is never resent; the dialog only closes. */
export function describeUndoError(error: string, branch: string, commands?: string): UndoErrorCopy {
  const raw = strip(error);
  const git = /^Git could not complete this operation\./.test(raw);
  // A revert keeps the history and needs no force push: the way left when the undo is refused.
  const revert = commands
    ? 'Revert the merge commit instead: run these commands in your clone.'
    : 'Revert the merge commit instead.';
  if (raw.startsWith(UNDO_MOVED) || /\bstale info\b|\(fetch first\)/i.test(raw))
    return {
      title: `${branch} has new commits after the merge commit.`,
      body: `Someone pushed, or a check added a commit, after your update. Nothing was changed. ${revert}`,
      details: git ? raw : undefined,
      commands,
    };
  if (
    /protected branch|GH006|GH013|pre-receive hook declined|hook declined|denying non-fast-forward|Cannot force-push/i.test(
      raw
    )
  ) {
    const github = remoteMessage(raw);
    return {
      title: `GitHub refused to rewrite ${branch}.`,
      body: `${github ? `GitHub says: “${github}” ` : ''}Nothing was changed. ${revert}`,
      details: raw,
      commands,
    };
  }
  // A merged or closed PR has no branch to revert on; the other refusals leave a revert.
  if (raw === UNDO_CLOSED) return { title: raw };
  if ([UNDO_OFF, UNDO_UNAVAILABLE, UNDO_RESTACKED].includes(raw))
    return { title: raw, ...(commands ? { body: revert, commands } : {}) };
  if (
    /Could not resolve host|unable to access|timed? ?out|ETIMEDOUT|ECONNRESET|ENOTFOUND|network|Connection (?:refused|reset|closed)/i.test(
      raw
    )
  )
    return {
      title: 'Gnosis lost the connection to GitHub during the undo.',
      body: 'Open the PR to see whether the undo reached GitHub before you try again. Gnosis never resends it on its own.',
      details: raw,
    };
  if (git)
    return {
      title: 'Gnosis couldn’t undo this update.',
      body: 'Open the PR to see where the branch is before you try again.',
      details: raw,
    };
  return { title: raw };
}
