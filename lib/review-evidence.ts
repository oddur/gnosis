import { checkCounts, orderedChecks, type PrChecks } from './pr-checks';
import { QUEUE_SIGNALS_TTL, type QueueSignals } from './queue-signals';
import type { GitHubReviewThreads } from './review-threads';
import type { ReviewMember } from './workbench';

export interface EvidenceRow {
  kind: 'checks' | 'review' | 'discussion';
  /** Availability is separate from observation time and freshness. */
  hasEvidence: boolean;
  label: string;
  detail: string;
  tone: 'success' | 'warning' | 'danger' | 'muted';
  checkedAt?: number;
  headSha?: string;
  action: string;
  checkId?: string;
  href?: string;
}
export interface MemberEvidence {
  member: ReviewMember;
  rows: EvidenceRow[];
}
const fresh = (checkedAt: number | undefined, now: number) =>
  checkedAt !== undefined &&
  Number.isFinite(checkedAt) &&
  checkedAt - now <= 30_000 &&
  now - checkedAt < QUEUE_SIGNALS_TTL;
const plural = (n: number, singular: string, multiple = `${singular}s`) => `${n} ${n === 1 ? singular : multiple}`;
const reviewLabel = (state: string) =>
  ({ APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', COMMENTED: 'Commented', DISMISSED: 'Dismissed' })[
    state
  ] ?? 'Review submitted';

/** Evidence describes observations, never infers merge eligibility, test coverage, or a successful reproduction. */
export function reviewEvidence(
  member: ReviewMember,
  input: {
    signals?: QueueSignals;
    checks?: PrChecks;
    checkError?: string;
    discussion?: GitHubReviewThreads;
    discussionError?: string;
    now: number;
  }
): MemberEvidence {
  const { now } = input;
  const signal =
    input.signals?.url === member.url && input.signals.headSha === member.headSha ? input.signals : undefined;
  const checks = input.checks?.url === member.url && input.checks.headSha === member.headSha ? input.checks : undefined;
  // A rollup may already reflect a rerun while the named check list still contains the previous attempt.
  const useChecks = checks && (!signal || checks.checkedAt >= signal.checkedAt);
  const counts = useChecks
    ? checkCounts(checks.checks)
    : signal
      ? {
          passed: signal.checks.passed,
          attention: signal.checks.failed,
          running: signal.checks.running,
          skipped: signal.checks.skipped,
        }
      : undefined;
  const checkTime = useChecks ? checks.checkedAt : signal?.checkedAt;
  const complete = useChecks
    ? !checks.warning
    : counts?.attention !== undefined && counts.running !== undefined && counts.skipped !== undefined;
  const total = useChecks ? checks.checks.length : signal?.checks.total;
  const currentChecks = fresh(checkTime, now) && !input.checkError;
  const checkRow: EvidenceRow = {
    kind: 'checks',
    hasEvidence: false,
    label: 'Checks not available',
    detail: 'No check results are available for this commit.',
    tone: 'muted',
    action: 'Open checks',
    headSha: member.headSha,
  };
  if (counts) {
    checkRow.hasEvidence = complete;
    const parts = [
      counts.attention ? `${plural(counts.attention, 'check')} need${counts.attention === 1 ? 's' : ''} attention` : '',
      counts.running ? `${counts.running} running` : '',
      counts.passed ? `${counts.passed} passed` : '',
      counts.skipped ? `${counts.skipped} skipped or neutral` : '',
    ].filter(Boolean);
    checkRow.label = total === 0 ? 'No checks reported' : parts.join(' · ') || 'Check results incomplete';
    checkRow.detail = !complete
      ? 'Some check results are missing. Open Checks for details.'
      : total === 0
        ? 'GitHub reports no checks for this commit. This is not a test pass.'
        : 'Results for the displayed commit.';
    checkRow.tone =
      currentChecks && complete
        ? counts.attention
          ? 'danger'
          : counts.running
            ? 'warning'
            : counts.passed
              ? 'success'
              : 'muted'
        : 'muted';
    checkRow.checkedAt = checkTime;
    if (!currentChecks) checkRow.label = `Saved: ${checkRow.label}`;
    if (!currentChecks)
      checkRow.detail = `${input.checkError ? 'Updates delayed. ' : 'Saved results; refresh before relying on them. '}${checkRow.detail}`;
    if (counts.attention) {
      checkRow.action = 'Inspect checks';
      if (useChecks) checkRow.checkId = orderedChecks(checks.checks, 'attention')[0]?.id;
    }
  } else if (input.checkError)
    checkRow.detail = 'Check results could not be loaded. Open Checks to see the error and retry.';
  else if (input.checks)
    checkRow.detail = 'Saved checks belong to another commit. They do not verify the displayed code.';

  const latest = signal?.latestReview;
  const decision = signal?.readiness?.reviewDecision;
  const decisionText = decision
    ? `GitHub’s review decision: ${decision === 'REVIEW_REQUIRED' ? 'Review required' : reviewLabel(decision)}. `
    : '';
  const reviewRow: EvidenceRow = {
    kind: 'review',
    hasEvidence: false,
    label: 'Reviewed commit unknown',
    detail: `${decisionText}No revision-linked review evidence is available.`,
    tone: 'muted',
    action: 'View reviews on GitHub',
    href: `${member.url}#pullrequestreview`,
    checkedAt: signal?.checkedAt,
  };
  if (latest === null) {
    reviewRow.hasEvidence = true;
    reviewRow.label = 'No submitted reviews';
    reviewRow.detail = `${decisionText}GitHub returned no submitted review for this PR.`;
  } else if (latest) {
    reviewRow.hasEvidence = !!latest.headSha;
    const same = !!latest.headSha && latest.headSha === member.headSha;
    reviewRow.label = latest.headSha
      ? same
        ? `Latest review: ${reviewLabel(latest.state).toLowerCase()}`
        : 'Latest review on another commit'
      : 'Latest review’s commit unknown';
    reviewRow.detail =
      `${reviewLabel(latest.state)} by ${latest.author}. ${same ? 'This review covers the displayed commit.' : latest.headSha ? 'Reviewed a different commit. This does not automatically dismiss the review.' : 'GitHub did not provide the reviewed commit.'} ${decisionText}`.trim();
    reviewRow.headSha = latest.headSha ?? undefined;
    reviewRow.href = latest.url;
    reviewRow.tone = fresh(signal.checkedAt, now)
      ? !same
        ? 'warning'
        : latest.state === 'CHANGES_REQUESTED'
          ? 'danger'
          : latest.state === 'APPROVED'
            ? 'success'
            : 'muted'
      : 'muted';
  }
  if (signal && !fresh(signal.checkedAt, now)) {
    reviewRow.label = `Saved: ${reviewRow.label}`;
    reviewRow.detail = `Saved review status; updates are pending. ${reviewRow.detail}`;
  }

  const discussion = input.discussion;
  const discussionRow: EvidenceRow = {
    kind: 'discussion',
    hasEvidence: false,
    label: 'Discussions not loaded',
    detail: 'Waiting for code discussions from GitHub.',
    tone: 'muted',
    action: 'View discussions on GitHub',
    href: `${member.url}/files`,
  };
  if (discussion) {
    discussionRow.hasEvidence = discussion.headSha === member.headSha && Number.isFinite(discussion.checkedAt);
    const unresolved = discussion.threads.filter((thread) => !thread.isResolved);
    const outdated = unresolved.filter((thread) => thread.isOutdated).length;
    const current = discussion.headSha === member.headSha && fresh(discussion.checkedAt, now) && !input.discussionError;
    discussionRow.label = unresolved.length
      ? plural(unresolved.length, 'unresolved discussion')
      : discussion.threads.length
        ? 'All loaded discussions resolved'
        : 'No code discussions';
    discussionRow.detail = `${outdated ? `${plural(outdated, 'unresolved discussion')} ${outdated === 1 ? 'is' : 'are'} attached to older code. ` : ''}${current ? 'GitHub code discussions; general PR comments are not included.' : 'Saved discussions may have changed. Their resolution status is not confirmed for the displayed commit.'}`;
    if (!current) discussionRow.label = `Saved: ${discussionRow.label}`;
    discussionRow.checkedAt = discussion.checkedAt;
    discussionRow.headSha = discussion.headSha;
    discussionRow.tone = current && unresolved.length ? 'warning' : 'muted';
    discussionRow.href = unresolved[0]?.comments[0]?.url || `${member.url}/files`;
  }
  if (input.discussionError) discussionRow.detail = `Updates delayed. ${input.discussionError}`;
  return { member, rows: [checkRow, reviewRow, discussionRow] };
}
