import type { WorkspaceTab } from './navigation-history';
import type { Prediction, PredictMember } from './navigation-predictor';

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
  /** Failing and running checks, from the check list. */
  attention: number;
  running: number;
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
    tab('checks', input.attention > 0 ? 0.5 : input.running > 0 ? 0.3 : 0.1),
    tab('feedback', input.responseNeeded || input.unresolved > 0 ? 0.5 : 0.1),
    tab('explanation', input.explanationReady ? 0.5 : 0),
    tab('commits', 0.15),
  ];
}
