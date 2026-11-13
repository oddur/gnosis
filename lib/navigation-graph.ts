import type { WorkspaceTab } from './navigation-history';
import type { Prediction, PredictMember } from './navigation-predictor';
import type { SearchDestination } from './command-search';

/**
 * Where a reader goes next from each screen, as weights. These are estimates; the predictor's measurements
 * (`[perf] predict nav … predicted=…`) show how well they match real navigation.
 */
export const PREDICTION_THRESHOLD = 0.2;

/** Only GitHub PR revisions can be prepared. Local reviews and incomplete records have nothing to read. */
export const predictableMembers = (members: readonly { url: string; headSha: string; baseSha: string; updatedAt: string }[]): PredictMember[] =>
  members
    .filter((m) => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(m.url) && !!m.headSha && !!m.baseSha)
    .slice(0, 5)
    .map(({ url, headSha, baseSha, updatedAt }) => ({ url, headSha, baseSha, updatedAt }));

/**
 * The open PR's likely next tabs, from what its Summary shows. They stay declared while the PR is open, on any tab,
 * so leaving Summary early does not drop the rest of the warm-up. Leaving the PR clears them.
 */
export function prOpenPredictions(input: {
  subjectId: string;
  members: PredictMember[];
  /** Failing and running checks, and all checks, from the check list. */
  attention: number;
  running: number;
  checks: number;
  /** Review comments on the PR, from its signals. */
  unresolved: number;
  responseNeeded: boolean;
  explanationReady: boolean;
}): Prediction[] {
  if (!input.members.length) return [];
  const tab = (name: WorkspaceTab, weight: number): Prediction => ({
    destination: {
      kind: 'pr-tab',
      tab: name,
      subjectId: input.subjectId,
      members: input.members,
      // A new failing check reads the open PR's threads and check details again. Fresh saved copies send nothing.
      epoch: `a${input.attention}`,
    },
    weight,
    strength: 'committed',
  });
  return [
    tab('changes', 0.6),
    // Checks is the slowest tab to open: its graph needs workflow runs, jobs and definitions. Warm it whenever the
    // PR has checks, most strongly when they fail or run.
    tab('checks', input.attention > 0 ? 0.5 : input.running > 0 ? 0.4 : input.checks > 0 ? 0.35 : 0.1),
    tab('feedback', input.responseNeeded || input.unresolved > 0 ? 0.5 : 0.1),
    tab('explanation', input.explanationReady ? 0.5 : 0),
    tab('commits', 0.15),
  ];
}

/** Resting on an entry point that opens a PR: its status, checks and threads, and its inventory first in the queue. */
export function openIntent(subjectId: string, members: readonly { url: string; headSha: string; baseSha: string; updatedAt: string }[]): Prediction | null {
  const predictable = predictableMembers(members);
  return predictable.length ? { destination: { kind: 'pr-open', subjectId, members: predictable }, weight: 1, strength: 'intent' } : null;
}
/** Resting on a saved review: its document from disk, the review screen's code, and diagram engines it uses. */
export const reviewIntent = (reviewId: string, diagrams?: ('mermaid' | 'd2')[]): Prediction => ({
  destination: { kind: 'review', reviewId, ...(diagrams?.length ? { diagrams } : {}) },
  weight: 1,
  strength: 'intent',
});
/** Resting on a PR tab raises that tab to a committed prediction for the open PR. */
export const tabIntent = (subjectId: string, tab: WorkspaceTab, members: PredictMember[], attention = 0): Prediction | null =>
  members.length ? { destination: { kind: 'pr-tab', tab, subjectId, members, epoch: `a${attention}` }, weight: 1, strength: 'intent' } : null;
/** A search or palette destination as an intent: a PR or stack in the queue, or a saved review. */
export function destinationIntent(destination: SearchDestination): Prediction | null {
  if (destination.kind === 'review') return reviewIntent(destination.reviewId);
  if (destination.kind === 'home' && destination.subject) {
    const subject = destination.subject.subject;
    const focus = destination.focusUrl && subject.members.find((member) => member.url === destination.focusUrl);
    return focus ? openIntent(focus.url, [focus]) : openIntent(subject.id, subject.members);
  }
  return null;
}
