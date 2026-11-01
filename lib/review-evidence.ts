import { checkCounts, orderedChecks, type PrChecks } from './pr-checks';
import type { QueueSignals } from './queue-signals';
import { GITHUB_SYNC_FRESHNESS_MS } from './github-sync';
import type { GitHubReviewThreads } from './review-threads';
import type { ReviewMember } from './workbench';

export interface EvidenceUpdateIssue {
  message: string;
  retryAt?: number;
}
export interface EvidenceRow {
  kind: 'checks' | 'review' | 'discussion';
  /** Availability is separate from observation time and freshness. */
  hasEvidence: boolean;
  label: string;
  labelParts?: { text: string; tone: EvidenceRow['tone'] }[];
  detail: string;
  tone: 'success' | 'warning' | 'danger' | 'muted';
  freshness: 'current' | 'saved' | 'delayed' | 'unknown';
  checkedAt?: number;
  headSha?: string;
  submittedAt?: string;
  action: string;
  checkId?: string;
  href?: string;
  allHref?: string;
  issue?: EvidenceUpdateIssue;
}
export interface MemberEvidence {
  member: ReviewMember;
  rows: EvidenceRow[];
}
const fresh = (kind: EvidenceRow['kind'], checkedAt: number | undefined, now: number) =>
  checkedAt !== undefined &&
  Number.isFinite(checkedAt) &&
  checkedAt - now <= 30_000 &&
  now - checkedAt < GITHUB_SYNC_FRESHNESS_MS[kind === 'review' ? 'signals' : kind];
const plural = (n: number, singular: string, multiple = `${singular}s`) => `${n} ${n === 1 ? singular : multiple}`;
const reviewLabel = (state: string) =>
  ({ APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', COMMENTED: 'Commented', DISMISSED: 'Dismissed' })[
    state
  ] ?? 'Review submitted';

/** Describe observations; never infer merge eligibility, test coverage, or successful bug reproduction. */
export function reviewEvidence(
  member: ReviewMember,
  input: {
    signals?: QueueSignals;
    checks?: PrChecks;
    checkError?: string;
    discussion?: GitHubReviewThreads;
    discussionError?: EvidenceUpdateIssue;
    now: number;
  }
): MemberEvidence {
  const { now } = input;
  const signal =
    input.signals?.url === member.url && input.signals.headSha === member.headSha ? input.signals : undefined;
  const checks = input.checks?.url === member.url && input.checks.headSha === member.headSha ? input.checks : undefined;
  // A rollup may already reflect a rerun while the named list still contains the previous attempt.
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
  const complete = useChecks
    ? !checks.warning
    : counts?.attention !== undefined && counts.running !== undefined && counts.skipped !== undefined;
  const checkRow: EvidenceRow = {
    kind: 'checks',
    hasEvidence: !!counts && complete,
    label: 'Checks not available',
    detail: 'No check results are available for the displayed commit.',
    tone: 'muted',
    freshness: 'unknown',
    action: 'Open checks',
    headSha: member.headSha,
    checkedAt: useChecks ? checks.checkedAt : signal?.checkedAt,
    issue: input.checkError ? { message: input.checkError } : undefined,
  };
  if (counts) {
    const attention = counts.attention
      ? `${plural(counts.attention, 'check')} need${counts.attention === 1 ? 's' : ''} attention`
      : '';
    const running = counts.running ? `${counts.running} running` : '';
    const total = useChecks ? checks.checks.length : signal?.checks.total;
    checkRow.label =
      total === 0
        ? 'No checks reported'
        : [attention, running].filter(Boolean).join(' · ') ||
          (counts.passed
            ? `${counts.passed} passed`
            : counts.skipped
              ? `${counts.skipped} skipped or neutral`
              : 'Check results incomplete');
    const supporting = [
      counts.passed && (attention || running) ? `${counts.passed} passed` : '',
      counts.skipped ? `${counts.skipped} skipped or neutral` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    checkRow.detail = !complete
      ? 'Some results are missing. Open Checks for details.'
      : total === 0
        ? 'GitHub reports no checks for this commit.'
        : supporting && supporting !== checkRow.label
          ? supporting
          : '';
    if (attention && running)
      checkRow.labelParts = [
        { text: attention, tone: 'danger' },
        { text: running, tone: 'warning' },
      ];
    checkRow.tone = counts.attention
      ? 'danger'
      : counts.running
        ? 'warning'
        : counts.passed && complete
          ? 'success'
          : 'muted';
    if (counts.attention) {
      const first = useChecks ? orderedChecks(checks.checks, 'attention')[0] : undefined;
      checkRow.action = first ? `Inspect ${first.name}` : 'Inspect checks';
      checkRow.checkId = first?.id;
    }
  } else if (input.checks)
    checkRow.detail = 'Saved checks belong to a different commit. Open Checks to inspect the latest results.';

  const latest = signal?.latestReview;
  const decision = signal?.readiness?.reviewDecision;
  const decisionText = decision
    ? `GitHub review decision: ${decision === 'REVIEW_REQUIRED' ? 'Review required' : reviewLabel(decision)}.`
    : '';
  const reviewRow: EvidenceRow = {
    kind: 'review',
    hasEvidence: false,
    label: 'Reviewed commit unknown',
    detail: 'Refresh GitHub information or open the PR to inspect its reviews.',
    tone: 'muted',
    freshness: 'unknown',
    action: 'Open PR reviews',
    href: member.url,
    checkedAt: signal?.checkedAt,
  };
  if (latest === null) {
    reviewRow.hasEvidence = true;
    reviewRow.label = 'No submitted reviews';
    reviewRow.detail = decisionText;
  } else if (latest) {
    const same = !!latest.headSha && latest.headSha === member.headSha;
    reviewRow.hasEvidence = !!latest.headSha;
    const by = `${reviewLabel(latest.state)} by ${latest.author}`;
    reviewRow.label = `${by}${latest.headSha ? (same ? ' · displayed commit' : ' · different commit') : ' · commit unknown'}`;
    reviewRow.detail = same
      ? ''
      : latest.headSha
        ? `Compare the reviewed commit with the code shown here. ${decisionText}`.trim()
        : 'GitHub did not provide the reviewed commit.';
    reviewRow.headSha = latest.headSha ?? undefined;
    reviewRow.submittedAt = Number.isFinite(Date.parse(latest.submittedAt)) ? latest.submittedAt : undefined;
    reviewRow.href = latest.url;
    reviewRow.action = `Open ${latest.author}’s review`;
    reviewRow.tone =
      latest.state === 'CHANGES_REQUESTED'
        ? 'danger'
        : !same
          ? 'warning'
          : latest.state === 'APPROVED'
            ? 'success'
            : 'muted';
  }

  const discussion = input.discussion;
  const discussionRow: EvidenceRow = {
    kind: 'discussion',
    hasEvidence: false,
    label: 'Discussions not loaded',
    detail: 'Loading code discussions from GitHub…',
    tone: 'muted',
    freshness: 'unknown',
    action: 'Open PR discussions',
    href: `${member.url}/files`,
    issue: input.discussionError,
  };
  if (discussion) {
    const unresolved = discussion.threads.filter((thread) => !thread.isResolved);
    const outdated = unresolved.filter((thread) => thread.isOutdated).length;
    discussionRow.hasEvidence = discussion.headSha === member.headSha && Number.isFinite(discussion.checkedAt);
    discussionRow.label = unresolved.length
      ? plural(unresolved.length, 'unresolved discussion')
      : discussion.threads.length
        ? 'All code discussions resolved'
        : 'No code discussions';
    discussionRow.detail = outdated ? `${outdated} ${outdated === 1 ? 'is' : 'are'} attached to older code.` : '';
    if (discussion.headSha !== member.headSha)
      discussionRow.detail =
        'These discussions were fetched for a different commit. Their current status is not confirmed.';
    discussionRow.checkedAt = discussion.checkedAt;
    discussionRow.headSha = discussion.headSha;
    discussionRow.tone = unresolved.length ? 'warning' : 'muted';
    const first = unresolved.find((thread) => thread.comments[0]?.url)?.comments[0]?.url;
    if (first) {
      discussionRow.href = first;
      discussionRow.action = unresolved.length > 1 ? 'Open first unresolved discussion' : 'Open unresolved discussion';
      if (unresolved.length > 1) discussionRow.allHref = `${member.url}/files`;
    }
  }
  const rows = [checkRow, reviewRow, discussionRow];
  for (const row of rows) {
    row.freshness = row.issue
      ? 'delayed'
      : row.checkedAt === undefined
        ? 'unknown'
        : fresh(row.kind, row.checkedAt, now) && (row.kind !== 'discussion' || row.headSha === member.headSha)
          ? 'current'
          : 'saved';
    // Old failures remain visible, but an old pass must never look current.
    if (row.freshness !== 'current' && row.tone === 'success') row.tone = 'muted';
  }
  return { member, rows };
}
