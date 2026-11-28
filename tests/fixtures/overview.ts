/**
 * `?overview` (#390): a synthetic day of work across three repositories for the Overview suite. Every PR, status
 * and write is local; nothing reaches GitHub. `window.fixtureOverview` lets the suite change GitHub's side (a new
 * failing PR, a renamed PR) and read the writes the app sent.
 */
import { groupSubjects, type QueueItem, type ReviewMember, type WorkbenchQueue, type WorkbenchSync } from '../../lib/workbench';
import type { QueueSignalRequest, QueueSignals } from '../../lib/queue-signals';
import type { PrActionRequest, PrActionState } from '../../lib/pr-actions';
import type { PrChecks, CheckSelection } from '../../lib/pr-checks';
import type { MarkPrReadRequest, PrReadState } from '../../lib/pr-read-state';
import type { ReviewHistoryEntry } from '../../lib/types';
import { emptyReadVersions } from '../../lib/pr-read-state';

const LOGIN = 'oddur';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.now();
const at = (ago: number) => new Date(now - ago).toISOString();

interface Spec {
  number: number;
  repo: string;
  title: string;
  author?: string;
  created: number;
  updated?: number;
  requested?: string[];
  additions?: number;
  deletions?: number;
  files?: number;
  baseBranch?: string;
  headBranch?: string;
}
function pr(spec: Spec): ReviewMember {
  return {
    number: spec.number,
    repo: spec.repo,
    headRepo: spec.repo,
    baseRepo: spec.repo,
    url: `https://github.com/${spec.repo}/pull/${spec.number}`,
    title: spec.title,
    description: '',
    author: spec.author ?? LOGIN,
    role: spec.author && spec.author !== LOGIN ? 'review-requested' : 'author',
    baseBranch: spec.baseBranch ?? 'main',
    headBranch: spec.headBranch ?? `branch-${spec.number}`,
    baseSha: `base-${spec.number}`,
    headSha: `head-${spec.number}`,
    merged: false,
    state: 'open',
    createdAt: at(spec.created),
    updatedAt: at(spec.updated ?? spec.created),
    labels: [],
    mergeable: true,
    isDraft: false,
    commitCount: 2,
    requestedReviewers: spec.requested ?? [],
    requestedTeams: [],
    mergeableState: 'clean',
    autoMerge: null,
    milestone: null,
    additions: spec.additions ?? 40,
    deletions: spec.deletions ?? 12,
    changedFileCount: spec.files ?? 3,
  };
}
type Status = {
  checks?: QueueSignals['checks']['state'];
  decision?: string | null;
  mergeState?: string;
  mergeable?: string;
  opinions?: { author: string; state: string; ago: number }[];
  comments?: { author: string; ago: number }[];
  /** The comment count GitHub reports (inline review comments included), when it is not the quoted comments. */
  commentCount?: number;
  /** Checks reported: 0 for a PR with no checks at all. */
  total?: number;
  behindBy?: number;
  /** Your latest review was on this commit, not the head: the PR changed since. */
  reviewedSha?: string;
};
function signalsFor(member: ReviewMember, status: Status): QueueSignals {
  const opinions = (status.opinions ?? []).map((opinion, i) => ({
    url: `${member.url}#pullrequestreview-${i + 1}`,
    author: opinion.author,
    state: opinion.state,
    submittedAt: at(opinion.ago),
    headSha: member.headSha,
  }));
  if (status.reviewedSha) opinions.push({ url: `${member.url}#pullrequestreview-mine`, author: LOGIN, state: 'APPROVED', submittedAt: at(3 * DAY), headSha: status.reviewedSha });
  return {
    url: member.url,
    headSha: member.headSha,
    checkedAt: Date.now(),
    comments: status.commentCount ?? status.comments?.length ?? 0,
    opinions,
    latestReview: opinions.at(-1) ?? null,
    activity: {
      recent: (status.comments ?? []).map((comment, i) => ({ kind: 'comment' as const, id: `c-${member.number}-${i}`, at: at(comment.ago), author: comment.author, automated: false })),
    },
    checks: {
      state: status.checks ?? 'success',
      passed: status.total === 0 ? 0 : status.checks === 'failure' ? 8 : 10,
      failed: status.checks === 'failure' ? 2 : 0,
      running: status.checks === 'pending' ? 3 : 0,
      total: status.total ?? 10,
    },
    readiness: {
      state: 'OPEN',
      isDraft: false,
      mergeable: status.mergeable ?? 'MERGEABLE',
      mergeState: status.mergeState ?? 'BLOCKED',
      reviewDecision: status.decision === undefined ? 'REVIEW_REQUIRED' : status.decision,
      baseBranch: member.baseBranch,
      baseSha: member.baseSha,
      behindBy: status.behindBy ?? 0,
      mergeQueue: false,
      queueState: null,
    },
  };
}

export function installOverviewFixture(mocks: Record<string, unknown>, items: QueueItem[]) {
  const status = new Map<string, Status>();
  const add = (member: ReviewMember, value: Status) => {
    status.set(member.url, value);
    return member;
  };
  const ready = { checks: 'success' as const, decision: 'APPROVED', mergeState: 'CLEAN' };
  const noReview = { checks: 'success' as const, decision: null, mergeState: 'CLEAN' };
  // Merge, Ready: approved recently, or no review required and recent.
  const merge1 = add(pr({ number: 301, repo: 'klang/engine', title: 'Cache resolved module paths between builds', created: 4 * DAY, updated: 2 * DAY, additions: 128, deletions: 34, files: 6 }), { ...ready, opinions: [{ author: 'lena', state: 'APPROVED', ago: 2 * DAY }] });
  const merge2 = add(pr({ number: 302, repo: 'klang/cli', title: 'Retry flaky uploads with jitter', created: 2 * DAY, updated: 5 * HOUR, additions: 22, deletions: 4, files: 2 }), { ...ready, opinions: [{ author: 'sam', state: 'APPROVED', ago: 5 * HOUR }, { author: 'owen', state: 'APPROVED', ago: 6 * HOUR }] });
  const merge3 = add(pr({ number: 303, repo: 'acme/web', title: 'Drop the unused polyfill bundle', created: 1 * DAY, updated: 20 * HOUR, additions: 4, deletions: 61, files: 3 }), { ...noReview, behindBy: 2 });
  // Merge, Parked: mergeable without review but idle for a week, and approved long ago.
  const parked1 = add(pr({ number: 304, repo: 'klang/cli', title: 'Rename the config loader flags', created: 9 * DAY, updated: 7 * DAY, additions: 18, deletions: 18, files: 2 }), noReview);
  const parked2 = add(pr({ number: 305, repo: 'klang/engine', title: 'Inline the hot path in the resolver', created: 12 * DAY, updated: 8 * DAY, additions: 66, deletions: 30, files: 3 }), { ...ready, opinions: [{ author: 'maya', state: 'APPROVED', ago: 8 * DAY }] });
  // A stack whose base waits on review and whose approved child can merge into it.
  const stackBase = add(pr({ number: 306, repo: 'acme/web', title: 'Extract the billing form state', created: 2 * DAY, updated: 10 * HOUR, headBranch: 'billing-1', requested: ['lena'], additions: 140, deletions: 52, files: 5 }), { checks: 'success' });
  const stackChild = add(pr({ number: 307, repo: 'acme/web', title: 'Validate billing addresses on blur', created: 2 * DAY, updated: 9 * HOUR, baseBranch: 'billing-1', headBranch: 'billing-2', additions: 75, deletions: 9, files: 3 }), { ...ready, opinions: [{ author: 'ivar', state: 'APPROVED', ago: 9 * HOUR }] });
  // Answer: changes requested on your PR, and replies to you.
  const answer1 = add(pr({ number: 311, repo: 'acme/web', title: 'Move session refresh into the auth worker', created: 6 * DAY, updated: 4 * DAY, additions: 310, deletions: 96, files: 11 }), { checks: 'success', decision: 'CHANGES_REQUESTED', opinions: [{ author: 'lena', state: 'CHANGES_REQUESTED', ago: 4 * DAY }] });
  const answer2 = add(pr({ number: 312, repo: 'klang/engine', title: 'Document the plugin loading order', created: 1 * DAY, updated: 3 * HOUR, additions: 58, deletions: 3, files: 1 }), { checks: 'success', comments: [{ author: 'owen', ago: 3 * HOUR }] });
  // Review: seven requests, so the lane shows five and "Show all 7".
  const reviewers = ['maya', 'lena', 'sam', 'owen', 'ivar', 'maya', 'sam'];
  const reviewTitles = [
    'Stream build logs to the dashboard',
    'Add a dry-run flag to the release script',
    'Batch telemetry writes per request',
    'Replace the legacy config parser',
    'Show lockfile drift in CI output',
    'Tighten the retry budget for webhooks',
    'Index workspace symbols lazily',
  ];
  const reviews = reviewTitles.map((title, i) =>
    pr({ number: 321 + i, repo: i % 3 === 2 ? 'acme/web' : i % 3 === 1 ? 'klang/cli' : 'klang/engine', title, author: reviewers[i], created: (5 - i * 0.6) * DAY, updated: (5 - i * 0.6) * DAY, requested: [LOGIN], additions: 20 + i * 37, deletions: 5 + i * 9, files: 1 + i })
  );
  // Fix: a stack with a failing base and a conflicted child, and a lone PR with conflicts.
  const fixBase = add(pr({ number: 331, repo: 'klang/engine', title: 'Split the scheduler into phases', created: 3 * DAY, updated: 20 * HOUR, headBranch: 'phases-1', additions: 205, deletions: 61, files: 7 }), { checks: 'failure' });
  const fixChild = add(pr({ number: 332, repo: 'klang/engine', title: 'Run phases on a worker pool', created: 3 * DAY, updated: 18 * HOUR, baseBranch: 'phases-1', headBranch: 'phases-2', additions: 144, deletions: 20, files: 4 }), { checks: 'success', mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
  const fixLone = add(pr({ number: 333, repo: 'acme/web', title: 'Upgrade the router to v7', created: 1 * DAY, updated: 9 * HOUR, additions: 412, deletions: 380, files: 23 }), { checks: 'success', mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
  // Waiting on others.
  // Waiting on lena's review for four days: past the stale threshold, so it asks whether to nudge.
  const waiting1 = add(pr({ number: 341, repo: 'klang/cli', title: 'Print a summary after install', created: 4 * DAY, requested: ['lena'], additions: 33, deletions: 2, files: 2 }), { checks: 'success' });
  const waiting2 = add(pr({ number: 342, repo: 'klang/engine', title: 'Profile cold starts in CI', created: 6 * HOUR, additions: 18, deletions: 0, files: 1 }), { checks: 'pending', decision: 'APPROVED' });
  const explained = reviews[0];
  const review: ReviewHistoryEntry = { id: 'overview-explanation', prUrl: explained.url, prTitle: explained.title, status: 'completed', unread: false } as ReviewHistoryEntry;

  const single = (member: ReviewMember, extra: Partial<QueueItem> = {}): QueueItem => ({ subject: groupSubjects([member])[0], attention: 'requested', ...extra });
  const next: QueueItem[] = [
    single(merge1),
    single(merge2),
    single(merge3),
    single(parked1),
    single(parked2),
    { subject: groupSubjects([stackBase, stackChild])[0], attention: 'other' },
    single(answer1),
    single(answer2, { responses: { [answer2.url]: { changesRequested: false, unresolvedThreads: 2, awaitingReply: 2, complete: true } } }),
    ...reviews.map((member, i) => single(member, i === 0 ? { review } : i === 3 ? { attention: 'updated' } : {})),
    { subject: groupSubjects([fixBase, fixChild])[0], attention: 'other' },
    single(fixLone),
    single(waiting1),
    single(waiting2),
  ];
  // `?overview&session`: briefings on a few PRs, as the guided session shows them under the title (#596). Also a
  // re-review whose size is known (your review was on an older commit), and an approved stack whose base can merge:
  // Next up is full, so it is one of the session's quick wins, and merging its base brings its next PR into the run.
  const sessionMode = new URLSearchParams(location.search).has('session');
  if (sessionMode) {
    add(reviews[3], { checks: 'success', reviewedSha: 'old-324' });
    const lockBase = add(pr({ number: 308, repo: 'klang/cli', title: 'Parse the lockfile once per run', created: 2 * DAY, updated: 6 * HOUR, headBranch: 'lock-1', additions: 48, deletions: 10, files: 2 }), { ...ready, opinions: [{ author: 'sam', state: 'APPROVED', ago: 6 * HOUR }] });
    const lockChild = add(pr({ number: 309, repo: 'klang/cli', title: 'Reuse the parsed lockfile in the audit', created: 2 * DAY, updated: 5 * HOUR, baseBranch: 'lock-1', headBranch: 'lock-2', additions: 30, deletions: 6, files: 2 }), { ...ready, opinions: [{ author: 'sam', state: 'APPROVED', ago: 5 * HOUR }] });
    next.push({ subject: groupSubjects([lockBase, lockChild])[0], attention: 'other' });
    const briefed: Partial<Record<number, string>> = {
      321: 'Streams each build step’s log lines to the dashboard as they arrive, through a new server-sent events endpoint, instead of loading the whole log when the step ends. Old builds still load their stored log at once.',
      312: 'Documents the order in which plugins load: built-ins first, then workspace plugins by name, then user plugins. It also explains how the new hooks replace the old load order.',
      324: 'Replaces the hand-written config parser with a schema-based one. Unknown keys now warn instead of failing, and the error messages name the file, line and key.',
    };
    for (const item of next) {
      const summary = briefed[item.subject.members[0].number];
      if (summary) item.briefing = { key: `session-${item.subject.members[0].number}`, status: 'ready', summary, updatedAt: new Date().toISOString() };
    }
  }
  items.splice(0, items.length, ...next);
  const members = () => items.flatMap((item) => item.subject.members);
  const find = (url: string) => members().find((member) => member.url === url);

  // One PR has unread activity, so the row menu can mark it read.
  const reads: Partial<Record<string, PrReadState>> = {
    [answer2.url]: { url: answer2.url, headSha: answer2.headSha, versions: { ...emptyReadVersions(), comments: 1 }, unread: ['comments'] },
  };
  const writes: { kind: string; url: string; comment?: string }[] = [];
  const reruns: CheckSelection[] = [];
  const changed = () => window.dispatchEvent(new Event('fixture-workbench-change'));
  // The next Nudge or Close fails, as GitHub may refuse it.
  let failNext = false;
  // Replies waiting on you, by PR: who wrote last and what.
  const replies = new Map<string, { author: string; text: string }>([
    [answer2.url, { author: 'owen', text: 'Could we keep the old loading order behind a flag until every plugin has **migrated** to the new hooks?' }],
  ]);
  // Main's "Since yesterday" log: three merges, two new requests, two replies, checks red on one and green on two.
  const sinceEvents = [
    { type: 'merged', key: 'merged|a', url: 'https://github.com/klang/cli/pull/290', at: now - 10 * HOUR },
    { type: 'merged', key: 'merged|b', url: 'https://github.com/klang/engine/pull/291', at: now - 9 * HOUR },
    { type: 'merged', key: 'merged|c', url: 'https://github.com/acme/web/pull/292', at: now - 8 * HOUR },
    { type: 'review-requested', key: 'rr|a', url: reviews[5].url, at: now - 7 * HOUR },
    { type: 'review-requested', key: 'rr|b', url: reviews[6].url, at: now - 6 * HOUR },
    { type: 'reply', key: 'reply|a', url: answer2.url, actor: 'owen', at: now - 3 * HOUR },
    { type: 'reply', key: 'reply|b', url: answer1.url, actor: 'lena', at: now - 4 * HOUR },
    { type: 'checks-red', key: 'red|a', url: fixBase.url, at: now - 5 * HOUR },
    { type: 'checks-green', key: 'green|a', url: merge2.url, at: now - 5 * HOUR },
    { type: 'checks-green', key: 'green|b', url: merge1.url, at: now - 11 * HOUR },
  ];

  // `?overview&overview-status=held`: GitHub has not answered yet. Saved status is empty, and status reads wait until
  // `answerStatus` answers them, one 25-PR batch at a time, as main does.
  const params = new URLSearchParams(location.search);
  let held = params.get('overview-status') === 'held';
  const heldReads: { requests: QueueSignalRequest[]; resolve: () => void }[] = [];
  const requested = new Set<string>();
  const answer = (requests: QueueSignalRequest[]) =>
    requests.flatMap((request) => {
      const member = find(request.url);
      return member && member.headSha === request.headSha ? [signalsFor(member, status.get(member.url) ?? { checks: 'success' })] : [];
    });
  // How long ago the queue last synced, and the discoveries the app asked for (`workbenchQueue(force)`).
  // A fixed time, as main's `discoveredAt` is: the snapshot's sync changes only when `setSync` changes it.
  let syncAt = Date.now() - (params.has('overview-sync-age') ? Number(params.get('overview-sync-age')) : 2 * 60_000);
  let syncStatus: WorkbenchSync['status'] = 'idle';
  // The change signals answer, and the pass in progress, as main reports them (lib/workbench.ts, `WorkbenchSync`).
  let syncExtra: Partial<WorkbenchSync> = { signals: true };
  const discoveries: boolean[] = [];

  const queue = mocks.workbenchQueue as () => Promise<WorkbenchQueue>;
  Object.assign(mocks, {
    workbenchQueue: async (force?: unknown) => {
      if (typeof force === 'boolean') discoveries.push(force);
      const value = await queue();
      return {
        ...value,
        readStates: structuredClone(reads),
        items: value.items.map((item) => ({ ...item, unreadUrls: item.subject.members.filter((member) => reads[member.url]?.unread.length).map((member) => member.url) })),
        sync: { status: syncStatus, checkedAt: syncAt, ...syncExtra },
      };
    },
    workbenchMarkPrRead: (request: MarkPrReadRequest) => {
      for (const receipt of request.receipts) { const state = reads[receipt.url]; if (state) state.unread = request.read ? [] : ["manual"]; }
      writes.push({ kind: request.read ? 'mark-read' : 'mark-unread', url: request.receipts.map((receipt) => receipt.url).join(',') });
      return (mocks.workbenchQueue as () => Promise<WorkbenchQueue>)();
    },
    getQueueSignals: (requests: QueueSignalRequest[], options?: { cachedOnly?: boolean }) => {
      if (!options?.cachedOnly) for (const request of requests) requested.add(request.url);
      if (!held) return Promise.resolve(answer(requests));
      if (options?.cachedOnly) return Promise.resolve([]);
      return new Promise((resolve) => heldReads.push({ requests, resolve: () => resolve(answer(requests)) }));
    },
    getPrActionState: (url: string): Promise<PrActionState> => {
      const member = find(url);
      if (!member) return Promise.reject(new Error('This PR is not in the fixture.'));
      return Promise.resolve({
        id: `node-${member.number}`,
        account: LOGIN,
        checkedAt: Date.now(),
        url: member.url,
        number: member.number,
        title: member.title,
        headBranch: member.headBranch,
        headSha: member.headSha,
        baseSha: member.baseSha,
        baseBranch: member.baseBranch,
        state: 'OPEN',
        isDraft: false,
        headRepo: member.repo,
        repository: member.repo,
        archived: false,
        canWrite: true,
        mergeable: 'MERGEABLE',
        mergeState: 'CLEAN',
        methods: ['SQUASH', 'MERGE'],
        defaultMethod: 'SQUASH',
        autoMerge: null,
        canEnableAuto: false,
        canDisableAuto: false,
        canUpdateBranch: true,
        canChangeDraft: true,
        mergeQueue: false,
        inMergeQueue: false,
        stack: null,
      });
    },
    performPrAction: (request: PrActionRequest) => {
      writes.push({ kind: request.kind, url: request.url, ...(request.comment ? { comment: request.comment } : {}) });
      const member = find(request.url);
      if (request.kind === 'close') {
        if (failNext) { failNext = false; return Promise.reject(new Error('Error invoking remote method \'perform-pr-action\': Error: GitHub refused the request.')); }
        if (member) member.state = 'closed';
        setTimeout(changed, 50);
        return Promise.resolve({ status: 'completed', message: `Closed #${member?.number ?? ''}. You can reopen it on GitHub.` });
      }
      if (request.kind === 'merge' && member) {
        member.merged = true;
        member.state = 'closed';
        // GitHub moves the PRs above a merged base onto its base branch.
        for (const child of members()) if (child.state === 'open' && child.baseBranch === member.headBranch) child.baseBranch = member.baseBranch;
        setTimeout(changed, 50);
      }
      return Promise.resolve({ status: 'merged', message: `Merged #${member?.number ?? ''} on GitHub.` });
    },
    getPrChecks: (target: { url: string; headSha: string }): Promise<PrChecks | undefined> => {
      const member = find(target.url);
      if (!member) return Promise.resolve(undefined);
      const run = `https://github.com/${member.repo}/actions/runs/7${member.number}`;
      return Promise.resolve({
        url: member.url,
        headSha: member.headSha,
        checkedAt: Date.now(),
        checks: [
          { id: `check-${member.number}-1`, databaseId: 1, kind: 'check', provider: 'github-actions', name: 'build', status: 'completed', conclusion: 'success', url: `${run}/job/1`, required: true, startedAt: at(HOUR), completedAt: at(HOUR - 60_000), workflowRun: { id: 7, workflowId: 1, event: 'pull_request' } },
          { id: `check-${member.number}-2`, databaseId: 2, kind: 'check', provider: 'github-actions', name: 'test (linux)', status: 'completed', conclusion: 'failure', url: `${run}/job/2`, required: true, startedAt: at(HOUR), completedAt: at(HOUR - 120_000), workflowRun: { id: 7, workflowId: 1, event: 'pull_request' } },
        ],
      } as PrChecks);
    },
    // "Since yesterday": what main's log saw overnight.
    getOverviewSince: (since: number) =>
      Promise.resolve(sinceEvents.filter((event) => event.at > since)),
    // The guided session's changed paths, for its facts row and depth rules: `?overview&session` only.
    ...(sessionMode ? {
      getPrFiles: (url: string) => {
        const member = find(url);
        const names = ['src/build/log-stream.ts', 'src/server/events.ts', 'src/dashboard/BuildLog.tsx', 'tests/log-stream.test.ts', 'docs/logs.md'];
        return Promise.resolve(names.slice(0, member?.changedFileCount ?? 3).map((filename) => ({ filename, status: 'modified', additions: 4, deletions: 1, changes: 5 })));
      },
    } : {}),
    // "+N lines since your review": one compare per re-review PR.
    getRereviewLines: (targets: { url: string; from: string; to: string }[]) => {
      writes.push(...targets.map((target) => ({ kind: 'compare', url: target.url })));
      return Promise.resolve(targets.map((target) => ({ ...target, lines: 42, files: 3 })));
    },
    // The thread waiting on your reply, from the saved discussion.
    getCachedReviewThreads: (url: string) => {
      const member = find(url);
      const reply = replies.get(url);
      if (!member || !reply) return Promise.resolve(undefined);
      const comment = (id: string, author: string, body: string, ago: number) => ({ id, body, createdAt: at(ago), url: `${url}#discussion_r${id}`, author: { login: author, avatarUrl: '' } });
      return Promise.resolve({
        headSha: member.headSha,
        baseSha: member.baseSha,
        checkedAt: Date.now(),
        threads: [{ id: `t-${member.number}`, path: 'src/loader.ts', line: 12, startLine: null, diffSide: 'RIGHT', isResolved: false, isOutdated: false, viewerCanResolve: true, viewerCanUnresolve: false,
          comments: [comment(`${member.number}1`, LOGIN, 'Moved the loader up.', 5 * HOUR), comment(`${member.number}2`, reply.author, reply.text, 3 * HOUR)] }],
      });
    },
    // The guided session's replies and approvals (components/GuidedSession.tsx): recorded, never sent.
    reviewThreadAction: (request: { prUrl: string; threadId: string; action: string }) => {
      writes.push({ kind: `thread-${request.action}`, url: request.prUrl });
      if (request.action === 'reply') replies.delete(request.prUrl);
      changed();
      return Promise.resolve({ id: request.threadId, comments: [], isResolved: request.action === 'resolve' });
    },
    submitReview: (request: { prUrl: string; event: string; body: string }) => {
      writes.push({ kind: `review-${request.event.toLowerCase()}`, url: request.prUrl, comment: request.body });
      changed();
      return Promise.resolve({ reviewUrl: `${request.prUrl}#pullrequestreview-1`, droppedCommentCount: 0 });
    },
    feedbackAction: (request: { prUrl: string; action: string; reviewer?: string }) => {
      writes.push({ kind: `${request.action}:${request.reviewer ?? ''}`, url: request.prUrl });
      if (failNext) { failNext = false; return Promise.reject(new Error('Error invoking remote method \'feedback-action\': Error: GitHub refused the request.')); }
      return Promise.resolve();
    },
    rerunChecks: (target: CheckSelection & { mode: 'failed' | 'all' }) => {
      reruns.push(target);
      writes.push({ kind: `rerun-${target.mode}`, url: target.url });
      return Promise.resolve();
    },
  });

  // `?overview&overview-stars=day|many`: starred work for the Starred section's suite (tests/overview-starred-browser.ts).
  // `day` stars a review request, an approved merge, a PR waiting on lena, one PR of the failing stack (so the stack
  // is starred), someone else's quiet PR, your draft and a merged PR, which the Overview leaves out. `many` stars
  // thirteen, past the section's cap.
  const starScenario = params.get('overview-stars');
  if (starScenario) {
    const quiet = add(pr({ number: 351, repo: 'acme/web', title: 'Sketch the new onboarding checklist', author: 'maya', created: 3 * DAY, updated: 2 * HOUR }), { checks: 'success' });
    const draft = add({ ...pr({ number: 352, repo: 'klang/cli', title: 'Try a streaming config parser', created: 2 * DAY, updated: 6 * HOUR }), isDraft: true }, { checks: 'success' });
    const merged: ReviewMember = { ...pr({ number: 350, repo: 'klang/engine', title: 'Pin the toolchain for release builds', created: 5 * DAY, updated: 20 * HOUR }), merged: true, state: 'closed' };
    items.push(single(quiet), single(draft), single(merged));
    const starred = starScenario === 'many'
      ? [...reviews, merge1, merge2, waiting1, quiet, merged, fixChild]
      : [reviews[1], merge1, waiting1, fixChild, quiet, draft, merged];
    void (mocks.workbenchStarPrs as (request: { members: ReviewMember[]; starred: boolean }) => Promise<unknown>)({ members: starred, starred: true });
  }

  Object.assign(window, {
    fixtureOverview: {
      writes,
      reruns,
      /** PR URLs the app asked GitHub's status for (not saved-status reads). */
      requested: () => [...requested],
      /** Status reads waiting for GitHub's answer, in 25-PR batches. */
      heldBatches: () => heldReads.length,
      /** GitHub answers the next `count` waiting batches; with no count, all, and later reads answer at once. */
      answerStatus: (count?: number) => {
        for (const read of heldReads.splice(0, count ?? heldReads.length)) read.resolve();
        if (count === undefined) held = false;
      },
      /** The next Nudge or Close PR fails on GitHub. */
      failNext: () => { failNext = true; },
      /**
       * The user's real shape (#390, morning page): Answer 0, Review 2 (a re-review and a small review with an
       * explanation), Merge 16 (2 ready, 14 parked), Fix 18 and Waiting 5.
       */
      real: () => {
        const repos = ['klang/engine', 'acme/web', 'klang/cli'];
        add(reviews[3], { checks: 'success', reviewedSha: 'old-324' });
        const parked = [
          ...['Move the launcher text into translation keys', 'Only return to in-app paths after the consent page', 'Refuse script URLs as the mobile OAuth redirect',
            'Save only schema-validated fields on profile update', 'Keep subscription ids inside one path segment', 'Read the player language from the launcher',
            'Add the notifications read scope', 'Count a refused output swap as a failure', 'Keep the onboarding quest until chat is reached', 'Bump the CLI to 4.2.1']
            .map((title, i) => single(add(pr({ number: 360 + i, repo: repos[i % 3], title, created: (9 + i) * DAY, updated: (5 + (i % 4)) * DAY, additions: 12 + i * 23, deletions: 2 + i * 5, files: 1 + (i % 5) }), noReview))),
          // Mergeable, never approved, opened over a week ago.
          ...['Retry the asset upload on a 502', 'Drop the legacy telemetry endpoint'].map((title, i) =>
            single(add(pr({ number: 370 + i, repo: repos[i % 3], title, created: (10 + i) * DAY, updated: 4 * DAY, additions: 30, deletions: 8, files: 2 }), { checks: 'success', decision: '', mergeState: 'CLEAN' }))),
        ];
        const fixes = Array.from({ length: 16 }, (_, i) => {
          const age = i === 15 ? 5 * HOUR : (10 + (i % 3)) * DAY;
          const conflicts = i === 4 || i === 9;
          return single(add(pr({ number: 380 + i, repo: repos[(i + 1) % 3], title: `Fix flaky step ${i + 1} in the release pipeline`, created: age + DAY, updated: age, additions: 10 + i * 7, deletions: 1 + i, files: 1 + (i % 4) }),
            conflicts ? { checks: 'success', mergeable: 'CONFLICTING', mergeState: 'DIRTY' } : { checks: 'failure' }));
        });
        const waits = [
          single(add(pr({ number: 398, repo: 'klang/engine', title: 'Keep each sender’s failed command to itself', created: 10 * DAY, requested: ['plucked'], additions: 163, deletions: 10, files: 6 }), { checks: 'success' })),
          single(add(pr({ number: 399, repo: 'acme/web', title: 'Build the translation prompt from the guidance', created: 4 * HOUR, requested: ['sam'], additions: 719, deletions: 340, files: 24 }), { checks: 'pending' })),
          single(add(pr({ number: 400, repo: 'klang/cli', title: 'Explain the retry budget in the CLI help', created: 2 * DAY, requested: ['lena'], additions: 24, deletions: 3, files: 1 }), { checks: 'success' })),
        ];
        items.splice(0, items.length,
          single(merge1), single(merge2), single(parked1), single(parked2), ...parked,
          single(reviews[0], { review }), single(reviews[3], { attention: 'updated' }),
          { subject: groupSubjects([fixBase, fixChild])[0], attention: 'other' }, single(fixLone), ...fixes,
          single(waiting1), single(waiting2), ...waits);
        changed();
      },
      /**
       * The user's real shape, third pass (#390, morning page 3): 17 stacked PRs in 6 stacks, #384 in two
       * repositories, 10 merges that need no review (2 of them large), 2 approved, and 2 review requests (zsolt-klang
       * 14 d, small; ivaremilsson 4 d, large). `seed` is a short name two owners share. Two repositories have an icon
       * or a colour.
       */
      real3: () => {
        const launcher = 'klang/seed-launcher';
        const portal = 'klang/web-seed-portal';
        const seed = 'klang/seed';
        const acmeSeed = 'acme/seed';
        // Stacked PRs above an open base: idle for five days, so they are Parked, and wait only for their base.
        const above = (repo: string, base: number, numbers: number[], titles: string[]) =>
          numbers.map((number, i) =>
            add(pr({ number, repo, title: titles[i] ?? `Part ${i + 2} of #${base}`, created: 9 * DAY, updated: 5 * DAY, baseBranch: `stack-${i === 0 ? base : numbers[i - 1]}`, headBranch: `stack-${number}`, additions: 30 + i * 9, deletions: 4 }), noReview));
        const stackOf = (base: ReviewMember, rest: ReviewMember[], name?: string): QueueItem => {
          const subject = groupSubjects([base, ...rest])[0];
          return { subject: { ...subject, ...(name ? { name } : {}) }, attention: 'other' };
        };
        const i18nBase = add(pr({ number: 380, repo: launcher, title: 'Move the launcher text into translation keys', created: 9 * DAY, updated: 8 * DAY, headBranch: 'stack-380', additions: 120, deletions: 30 }), { checks: 'failure' });
        const i18n = above(launcher, 380, [381, 382, 383, 384], ['Translate the settings page', 'Translate the store page', 'Translate the error dialogs', 'Pick the language from the system']);
        const portalBase = add(pr({ number: 384, repo: portal, title: 'Language picker in the account menu', created: 3 * DAY, updated: 9 * HOUR, headBranch: 'stack-384', additions: 40, deletions: 6 }), { ...ready, opinions: [{ author: 'lena', state: 'APPROVED', ago: 9 * HOUR }] });
        const portalRest = [385, 386, 387].map((number, i) =>
          add(pr({ number, repo: portal, title: ['Remember the chosen language', 'Translate the checkout', 'Right-to-left layout for Arabic'][i], created: 3 * DAY, updated: 8 * HOUR, baseBranch: `stack-${i === 0 ? 384 : 384 + i}`, headBranch: `stack-${number}`, additions: 22, deletions: 3 }), noReview));
        const seedBase = add(pr({ number: 36948, repo: seed, title: 'Keep each sender’s failed command to itself', created: 10 * DAY, requested: ['plucked'], headBranch: 'stack-36948', additions: 163, deletions: 10 }), { checks: 'success' });
        const seedRest = above(seed, 36948, [36949, 36950, 36951], ['Retry a failed command once', 'Report command failures to the sender', 'Drop the shared failure queue']);
        const acmeBase = add(pr({ number: 15917, repo: acmeSeed, title: 'Seed the store catalogue from fixtures', created: 2 * DAY, updated: 3 * HOUR, headBranch: 'stack-15917', additions: 80, deletions: 12 }), { checks: 'pending', decision: 'APPROVED' });
        const acmeRest = above(acmeSeed, 15917, [15918, 15919], ['Seed prices per region', 'Seed the gift cards']);
        const engineBase = add(pr({ number: 376, repo: launcher, title: 'Integrate the patcher with the launcher shell', created: 12 * DAY, updated: 5 * DAY, headBranch: 'stack-376', additions: 90, deletions: 14 }), noReview);
        const engineRest = above(launcher, 376, [377, 378, 379], ['Patch in the background', 'Show patch progress in the tray', 'Resume an interrupted patch']);
        const portalTwo = add(pr({ number: 35392, repo: portal, title: 'Split the portal session store', created: 6 * DAY, requested: ['lena'], headBranch: 'stack-35392', additions: 70, deletions: 20 }), { checks: 'success' });
        const portalTwoRest = above(portal, 35392, [35393, 35394], ['Move session refresh into the worker', 'Expire sessions on password change']);
        // Ten merges that need no review, two of them large; two approved.
        const quick = ['chore: script the Saleor setup for the Epic store channel', 'fix(sync): stop the pull deleting file rows that wait for their blob', 'fix(steam): find abandoned draft orders in the idempotency lookup',
          'feat: build the realtime translation prompt from the translators’ guidance', 'chore: bump the CLI to 4.2.1', 'fix: keep the onboarding quest until chat is reached', 'fix: count a refused output swap as a failure', 'chore: add the notifications read scope']
          .map((title, i) => single(add(pr({ number: 600 + i, repo: [launcher, portal, seed, acmeSeed][i % 4], title, created: (2 + i * 0.3) * DAY, updated: (40 - i * 3) * HOUR, additions: 12 + i * 9, deletions: 3 + i }), noReview)));
        const large = [
          single(add(pr({ number: 610, repo: launcher, title: 'STACK: EPIC', created: 3 * DAY, updated: 2 * DAY, additions: 2410, deletions: 380, files: 61 }), noReview)),
          single(add(pr({ number: 611, repo: seed, title: 'feat(rust): integrate the Rust ECO/Nemo worker workspace into project/workers/rust', created: 2 * DAY, updated: 30 * HOUR, additions: 1630, deletions: 90, files: 48 }), noReview)),
        ];
        const approvedMerge = single(add(pr({ number: 620, repo: portal, title: 'Cache the store catalogue between page loads', created: 2 * DAY, updated: 6 * HOUR, additions: 64, deletions: 12 }), { ...ready, opinions: [{ author: 'sam', state: 'APPROVED', ago: 6 * HOUR }] }));
        // Two review requests: one small and old, one large.
        const zsolt = pr({ number: 36990, repo: seed, title: 'Throttle the chat presence updates', author: 'zsolt-klang', created: 14 * DAY, requested: [LOGIN], additions: 96, deletions: 21, files: 4 });
        const ivar = pr({ number: 391, repo: launcher, title: 'Rewrite the launcher updater', author: 'ivaremilsson', created: 4 * DAY, requested: [LOGIN], additions: 840, deletions: 220, files: 31 });
        const fixes = Array.from({ length: 4 }, (_, i) =>
          single(add(pr({ number: 700 + i, repo: [portal, launcher][i % 2], title: `Fix flaky step ${i + 1} in the release pipeline`, created: 4 * DAY, updated: (2 + i) * DAY, additions: 20, deletions: 4 }), { checks: 'failure' })));
        items.splice(0, items.length,
          approvedMerge, ...quick, ...large,
          stackOf(i18nBase, i18n, 'Launcher i18n'), stackOf(portalBase, portalRest), stackOf(seedBase, seedRest), stackOf(acmeBase, acmeRest), stackOf(engineBase, engineRest), stackOf(portalTwo, portalTwoRest),
          single(zsolt), single(ivar), ...fixes);
        void window.electronAPI.loadPreferences().then((prefs) =>
          window.dispatchEvent(new CustomEvent('gnosis-preferences-changed', { detail: { ...prefs, repositorySettings: { ...prefs.repositorySettings, [launcher]: { icon: 'lucide:rocket', color: 'purple' }, [portal]: { color: 'teal' } } } })));
        changed();
      },
      /**
       * The user's real shape, fourth pass (screenshot 32): 7 review requests (zsolt-klang 1 small, ivaremilsson 6
       * large or stacked), 6 merges nobody reviewed that are all large or stacked (three stacks whose base can merge),
       * 4 PRs that need a decision and also fail or conflict (one is a stack's base), plucked's review, CI, and fixes.
       */
      real4: () => {
        const launcher = 'klang/seed-launcher';
        const seed = 'klang/seed';
        const bridge = 'klang/service-payment-bridge';
        const stale = { created: 14 * DAY };
        const chain = (repo: string, base: ReviewMember, numbers: number[], titles: string[], status: Status = noReview, extra: Partial<Spec> = {}) =>
          numbers.map((number, i) => add(pr({ number, repo, title: titles[i], created: 2 * DAY, updated: 4 * HOUR, baseBranch: `stack-${i ? numbers[i - 1] : base.number}`, headBranch: `stack-${number}`, additions: 120 + i * 20, deletions: 10, ...extra }), status));
        const stackOf = (base: ReviewMember, rest: ReviewMember[], name?: string): QueueItem => {
          const subject = groupSubjects([base, ...rest])[0];
          return { subject: { ...subject, ...(name ? { name } : {}) }, attention: 'other' };
        };
        // Review requests.
        const zsolt = pr({ number: 36990, repo: seed, title: 'feat: throttle the chat presence updates', author: 'zsolt-klang', created: 14 * DAY, requested: [LOGIN], additions: 96, deletions: 21, files: 4 });
        const ivarTitles = ['feat: rewrite the launcher updater', 'feat: one seed-api event pipeline with plugins', 'refactor(app): delete desktop sync code that has no production caller'];
        const ivar = ivarTitles.map((title, i) => pr({ number: 391 + i, repo: seed, title, author: 'ivaremilsson', created: (4 - i * 0.2) * DAY, requested: [LOGIN], additions: 840 + i * 60, deletions: 220, files: 31 }));
        const ivarStack = ['feat: store purchases in one ledger', 'feat: claim each store purchase once', 'feat: provision and refund Epic purchases'].map((title, i) =>
          pr({ number: 394 + i, repo: seed, title, author: 'ivaremilsson', created: 3 * DAY, requested: [LOGIN], baseBranch: i ? `ivar-${393 + i}` : 'main', headBranch: `ivar-${394 + i}`, additions: 240, deletions: 20, files: 8 }));
        // Six merges nobody reviewed: three large, three stacks whose base can merge.
        const large = ['feat(rust): integrate the Rust ECO/Nemo worker workspace into project/workers/rust', 'feat: new launcher shell with a native title bar', 'chore: vendor the Steamworks SDK headers'].map((title, i) =>
          single(add(pr({ number: 611 + i, repo: [seed, launcher, bridge][i], title, created: 2 * DAY, updated: (30 - i * 4) * HOUR, additions: 1630 - i * 200, deletions: 90, files: 48 }), noReview)));
        const epic = add(pr({ number: 376, repo: launcher, title: 'STACK: EPIC', created: 3 * DAY, updated: 6 * HOUR, headBranch: 'stack-376', additions: 2410, deletions: 380, files: 61 }), noReview);
        const epicRest = chain(launcher, epic, [377, 378, 379], ['feat: patch in the background', 'feat: show patch progress in the tray', 'feat: resume an interrupted patch']);
        const steam = add(pr({ number: 383, repo: bridge, title: 'fix: keep Steam and Epic store orders in step', created: 2 * DAY, updated: 4 * HOUR, headBranch: 'stack-383', additions: 310, deletions: 40 }), noReview);
        const steamRest = chain(bridge, steam, [384, 385, 386], ['fix: never commit store orders twice', 'fix: claim each store purchase once', 'feat: provision and refund Epic purchases']);
        const market = add(pr({ number: 35392, repo: seed, title: 'feat: add the market and create its first listings', created: 2 * DAY, updated: 4 * HOUR, headBranch: 'stack-35392', additions: 410, deletions: 60 }), noReview);
        const marketRest = chain(seed, market, [35393, 35394], ['chore: keep the small types of one response together', 'feat: one seed-api event pipeline for listings']);
        // Four decisions that also fail or conflict; the last is the base of Launcher i18n.
        const icon = add(pr({ number: 700, repo: launcher, title: 'feat: new launcher app icon', ...stale, updated: 12 * DAY }), { checks: 'failure' });
        const notify = add(pr({ number: 701, repo: seed, title: 'feat: serve in-game notifications from seed-api', ...stale, updated: 11 * DAY }), { checks: 'success', mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
        const sender = add(pr({ number: 36948, repo: seed, title: 'fix: keep each sender’s failed command to itself, and stop tracking it once it expires', ...stale, updated: 10 * DAY }), { checks: 'failure' });
        const i18n = add(pr({ number: 380, repo: launcher, title: 'feat: move the launcher’s text into translation keys (i18n 1/3)', ...stale, updated: 8 * DAY, headBranch: 'stack-380' }), { checks: 'success', mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
        const i18nRest = chain(launcher, i18n, [381, 382, 383, 384], ['feat: translate the settings page (i18n 2/3)', 'feat: translate the store page (i18n 3/3)', 'feat: translate the error dialogs', 'feat: pick the language from the system'], { checks: 'success' }, { requested: [] });
        // Waiting on plucked, on CI, and fixes that are not stale.
        const plucked = single(add(pr({ number: 36950, repo: seed, title: 'fix: keep a construction’s blocking object when an edit fails', created: 10 * DAY, updated: DAY, requested: ['plucked'] }), { checks: 'success' }));
        const running = single(add(pr({ number: 36960, repo: seed, title: 'feat: spin wallet balance digits with a new NumberFlow label', created: DAY, updated: 2 * HOUR }), { checks: 'pending', decision: 'APPROVED' }));
        const fixes = [
          single(add(pr({ number: 720, repo: seed, title: 'The whole MCP', created: 2 * DAY, updated: DAY }), { checks: 'failure' })),
          single(add(pr({ number: 721, repo: 'klang/bt', title: 'refactor(app): delete desktop sync code that has no production caller', created: DAY, updated: 19 * 60_000 }), { checks: 'failure' })),
          single(add(pr({ number: 722, repo: launcher, title: 'fix: read the player language from the launcher', created: 2 * DAY, updated: DAY }), { checks: 'success', mergeable: 'CONFLICTING', mergeState: 'DIRTY' })),
        ];
        // A restack: its parent merged.
        const merged = pr({ number: 723, repo: seed, title: 'feat: wallet balance API', created: 3 * DAY, updated: DAY, headBranch: 'wallet-1' });
        merged.merged = true;
        merged.state = 'closed';
        const restack = add(pr({ number: 724, repo: seed, title: 'feat: wallet balance in the HUD', created: 2 * DAY, updated: DAY, baseBranch: 'wallet-1' }), noReview);
        items.splice(0, items.length,
          single(zsolt), ...ivar.map((member) => single(member)), { subject: groupSubjects(ivarStack)[0], attention: 'requested' },
          ...large, stackOf(epic, epicRest, 'STACK: EPIC'), stackOf(steam, steamRest), stackOf(market, marketRest),
          single(icon), single(notify), single(sender), stackOf(i18n, i18nRest, 'Launcher i18n'),
          plucked, running, ...fixes, { subject: groupSubjects([merged, restack])[0], attention: 'other' });
        void window.electronAPI.loadPreferences().then((prefs) =>
          window.dispatchEvent(new CustomEvent('gnosis-preferences-changed', { detail: { ...prefs, repositorySettings: { ...prefs.repositorySettings, [launcher]: { icon: 'lucide:rocket', color: 'purple' }, [seed]: { color: 'green' } } } })));
        changed();
      },
      /**
       * Screenshot 34: five stacks waiting on earlier PRs. A 4-PR stack whose base is ready, one waiting on checks, a
       * 6-PR stack waiting on lena's review, one stack of two whose base has conflicts, and a 3-PR stack whose base is
       * ready. Five approved merges fill Next up, so every base is listed in its chain.
       */
      stacks5: () => {
        const launcher = 'klang/seed-launcher';
        const seed = 'klang/seed';
        const bridge = 'klang/service-payment-bridge';
        const chain = (repo: string, base: ReviewMember, numbers: number[], titles: string[]) =>
          numbers.map((number, i) => add(pr({ number, repo, title: titles[i], created: 2 * DAY, updated: (5 - i) * HOUR, baseBranch: `stack-${i ? numbers[i - 1] : base.number}`, headBranch: `stack-${number}`, additions: 60 + i * 15, deletions: 8 }), noReview));
        const stackOf = (base: ReviewMember, rest: ReviewMember[], name?: string): QueueItem => {
          const subject = groupSubjects([base, ...rest])[0];
          return { subject: { ...subject, ...(name ? { name } : {}) }, attention: 'other' };
        };
        const fill = ['Cache resolved module paths between builds', 'Retry flaky uploads with jitter', 'Bump the CLI to 4.2.1', 'Add the notifications read scope', 'Count a refused output swap as a failure'].map((title, i) =>
          single(add(pr({ number: 650 + i, repo: 'klang/cli', title, created: DAY, updated: (6 + i) * HOUR, additions: 20, deletions: 4 }), { ...ready, opinions: [{ author: 'lena', state: 'APPROVED', ago: (6 + i) * HOUR }] })));
        const steam = add(pr({ number: 383, repo: bridge, title: 'fix: keep Steam and Epic store orders in step', created: 2 * DAY, updated: 4 * HOUR, headBranch: 'stack-383' }), noReview);
        const steamRest = chain(bridge, steam, [384, 385, 386], ['fix: never commit store orders twice', 'fix: claim each store purchase once', 'feat: provision and refund Epic purchases']);
        const blocking = add(pr({ number: 36948, repo: seed, title: 'fix: keep a construction’s blocking object when an edit fails', created: 5 * DAY, updated: 60_000, headBranch: 'stack-36948' }), { checks: 'pending', decision: 'APPROVED' });
        const blockingRest = chain(seed, blocking, [36949], ['fix: fail a building edit whose blocking object is gone']);
        const i18n = add(pr({ number: 379, repo: launcher, title: 'feat: move the launcher’s text into translation keys (i18n 1/3)', created: 6 * DAY, updated: 2 * DAY, requested: ['lena'], headBranch: 'stack-379' }), { checks: 'success' });
        const i18nRest = chain(launcher, i18n, [380, 381, 382, 383, 384], ['feat: translate the settings page (i18n 2/3)', 'feat: translate the store page (i18n 3/3)', 'feat: translate the error dialogs', 'feat: translate the patch notes', 'feat: pick the language from the system']);
        const epic = add(pr({ number: 376, repo: launcher, title: 'STACK: EPIC', created: 3 * DAY, updated: 6 * HOUR, headBranch: 'stack-376' }), { checks: 'success', mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
        const epicRest = chain(launcher, epic, [377], ['feat: patch in the background']);
        const market = add(pr({ number: 35392, repo: seed, title: 'feat: add the market and create its first listings', created: 2 * DAY, updated: 4 * HOUR, headBranch: 'stack-35392' }), noReview);
        const marketRest = chain(seed, market, [35393, 35394], ['chore: keep the small types of one response together', 'feat: one seed-api event pipeline with plugins']);
        items.splice(0, items.length, ...fill, stackOf(steam, steamRest), stackOf(blocking, blockingRest), stackOf(i18n, i18nRest, 'Launcher i18n'), stackOf(epic, epicRest, 'STACK: EPIC'), stackOf(market, marketRest));
        changed();
      },
      /**
       * Screenshot 36: a stack whose base you can merge without review, with two more of your PRs and six of
       * ivaremilsson's above it that changed since your review; a lone re-review; STACK: EPIC, whose base can merge;
       * six large merges nobody reviewed; and a small review request. Every review lands in Next up.
       */
      real5: () => {
        const launcher = 'klang/seed-launcher';
        const seed = 'klang/seed';
        const stackOf = (members: ReviewMember[], name: string, attention: QueueItem['attention'] = 'other'): QueueItem => {
          const subject = groupSubjects(members)[0];
          return { subject: { ...subject, name }, attention };
        };
        const linked = (spec: Spec, parent: number) => ({ ...spec, baseBranch: `stack-${parent}`, headBranch: `stack-${spec.number}` });
        const market = add(pr({ number: 35392, repo: seed, title: 'feat: add the market and create_seedling mcp tools to seed-api', created: 2 * DAY, updated: HOUR, headBranch: 'stack-35392', additions: 410, deletions: 60 }), noReview);
        const marketOwn = [
          add(pr(linked({ number: 37378, repo: seed, title: 'chore: keep the small types of one responsibility in one file across seed-api', created: 2 * DAY, updated: HOUR, additions: 90 }, 35392)), noReview),
          add(pr(linked({ number: 37578, repo: seed, title: 'feat: one seed-api event pipeline with pluggable kinds and a my_events pull tool', created: 2 * DAY, updated: HOUR, additions: 180 }, 37378)), noReview),
        ];
        const marketTitles = ['feat: list a seedling on the market', 'feat: buy a listed seedling', 'feat: cancel a listing', 'feat: market fees per region', 'feat: notify the seller on a sale', 'test: market end to end'];
        const marketTheirs = marketTitles.map((title, i) =>
          add(pr(linked({ number: 37601 + i, repo: seed, title, author: 'ivaremilsson', created: 3 * DAY, updated: 5 * HOUR, additions: 60 + i * 10, deletions: 8 }, i ? 37600 + i : 37578)), { checks: 'success', reviewedSha: `old-${37601 + i}` }));
        const lone = add(pr({ number: 377, repo: launcher, title: 'feat: block launches until the player accepts the terms in the launcher', author: 'ivaremilsson', created: 3 * DAY, updated: 5 * HOUR, additions: 70, deletions: 12 }), { checks: 'success', reviewedSha: 'old-377' });
        const epic = add(pr({ number: 376, repo: launcher, title: 'refactor: model the store distribution channel instead of Steam-only flags', created: 3 * DAY, updated: 2 * HOUR, headBranch: 'stack-376', additions: 220, deletions: 40 }), noReview);
        const epicRest = [382, 378, 385].map((number, i) =>
          add(pr(linked({ number, repo: launcher, title: ['fix: quit a store-launched launcher when its last window closes', 'feat: log in with Epic on Epic Games Store launches (L3)', 'feat: import Epic purchases after an Epic login, before play (L3b)'][i], created: 3 * DAY, updated: 2 * HOUR, additions: 80 }, i ? [382, 378][i - 1] : 376)), noReview));
        const large = ['feat(rust): integrate the Rust worker workspace', 'feat: new launcher shell with a native title bar', 'chore: vendor the Steamworks SDK headers', 'feat: store catalogue sync for Epic', 'refactor: split the payment bridge by store', 'feat: seed-api admin tools'].map((title, i) =>
          single(add(pr({ number: 611 + i, repo: [seed, launcher][i % 2], title, created: 2 * DAY, updated: (30 - i * 3) * HOUR, additions: 1630 - i * 100, deletions: 90, files: 40 }), noReview)));
        const zsolt = pr({ number: 36990, repo: seed, title: 'feat: throttle the chat presence updates', author: 'zsolt-klang', created: 6 * DAY, requested: [LOGIN], additions: 96, deletions: 21, files: 4 });
        items.splice(0, items.length,
          stackOf([market, ...marketOwn, ...marketTheirs], 'feat: add the market and create_seedling mcp tools to seed-api', 'updated'),
          single(lone, { attention: 'updated' }), stackOf([epic, ...epicRest], 'STACK: EPIC'), ...large, single(zsolt));
        void window.electronAPI.loadPreferences().then((prefs) =>
          window.dispatchEvent(new CustomEvent('gnosis-preferences-changed', { detail: { ...prefs, repositorySettings: { ...prefs.repositorySettings, [launcher]: { icon: 'lucide:rocket', color: 'purple' }, [seed]: { color: 'green' } } } })));
        changed();
      },
      /**
       * Screenshot 37: two stacks whose base can merge without review (one unblocks three PRs, one unblocks one), a
       * lone re-review, a re-review of six PRs whose base merges after it, and a restack of a draft. STACK: EPIC can
       * merge with no checks at all; Launcher i18n's base needs a decision and has conflicts; a later PR of the
       * payment stack has conflicts too. Six decisions, failing or idle for over a week; fixes under You; plucked's
       * review. Several PRs have comments.
       */
      real6: () => {
        const launcher = 'klang/seed-launcher';
        const seed = 'klang/seed';
        const bridge = 'klang/service-payment-bridge';
        const portal = 'klang/web-seed-portal';
        const stackOf = (members: ReviewMember[], name?: string, attention: QueueItem['attention'] = 'other'): QueueItem => {
          const subject = groupSubjects(members)[0];
          return { subject: { ...subject, ...(name ? { name } : {}) }, attention };
        };
        const linked = (spec: Spec, parent: number) => ({ ...spec, baseBranch: `stack-${parent}`, headBranch: `stack-${spec.number}` });
        const none = { ...noReview, checks: 'neutral' as const, total: 0 };
        // The payment stack: its base merges without review and unblocks three; #385 above it has conflicts.
        const steam = add(pr({ number: 383, repo: bridge, title: 'fix: keep Steam and Epic orders out of Adyen refunds and paid-order effects', created: 2 * DAY, updated: 4 * HOUR, headBranch: 'stack-383', additions: 310, deletions: 40 }), { ...noReview, commentCount: 3 });
        const steamRest = [
          add(pr(linked({ number: 384, repo: bridge, title: 'fix: never commit store orders to AvaTax', created: 2 * DAY, updated: 4 * HOUR }, 383)), noReview),
          add(pr(linked({ number: 385, repo: bridge, title: 'fix: claim each store purchase before creating its order', created: 2 * DAY, updated: 3 * HOUR }, 384)), { checks: 'success', mergeable: 'CONFLICTING', mergeState: 'DIRTY', commentCount: 1 }),
          add(pr(linked({ number: 397, repo: bridge, title: 'feat: provision and refund Epic Games Store purchases (P2)', created: 2 * DAY, updated: 3 * HOUR }, 385)), noReview),
        ];
        // The blocking-objects stack: its base merges without review and unblocks one.
        const blocking = add(pr({ number: 36948, repo: seed, title: 'fix: keep a construction’s blocking objects when their recheck fails', created: 3 * DAY, updated: 5 * HOUR, headBranch: 'stack-36948', additions: 160, deletions: 12 }), noReview);
        const blockingRest = [add(pr(linked({ number: 36962, repo: seed, title: 'fix: fail a building edit whose blocking-objects check fails', created: 3 * DAY, updated: 5 * HOUR }, 36948)), noReview)];
        // STACK: EPIC: no checks at all on any PR; its base can merge without review.
        const epic = add(pr({ number: 376, repo: launcher, title: 'refactor: model the store distribution channel instead of Steam-only checks', created: 3 * DAY, updated: 2 * HOUR, headBranch: 'stack-376', additions: 220, deletions: 40 }), none);
        const epicRest = [382, 378, 386].map((number, i) =>
          add(pr(linked({ number, repo: launcher, title: ['fix: quit a store-launched launcher when its last window closes', 'feat: log in with Epic on Epic Games Store launches (L3)', 'feat: import Epic purchases after an Epic login, before play (L3b)'][i], created: 3 * DAY, updated: 2 * HOUR, additions: 80 }, i ? [382, 378][i - 1] : 376)), none));
        // Launcher i18n: the base is idle for nine days with conflicts, so it needs a decision.
        const i18n = add(pr({ number: 379, repo: launcher, title: 'feat: move the launcher’s text into translation keys (i18n 1/3)', created: 14 * DAY, updated: 9 * DAY, headBranch: 'stack-379' }), { checks: 'success', mergeable: 'CONFLICTING', mergeState: 'DIRTY', commentCount: 6 });
        const i18nRest = [380, 381, 387, 388].map((number, i) =>
          add(pr(linked({ number, repo: launcher, title: ['feat: add German, Spanish and French to the launcher (i18n 2/3)', 'feat: let players pick the launcher’s language and keep it in their account', 'refactor: derive the language in state, send translation keys, and tidy the i18n stack', 'fix: address review findings on the player-facing wording'][i], created: 6 * DAY, updated: 2 * DAY }, i ? [380, 381, 387][i - 1] : 379)), none));
        // A re-review of six PRs above your base: the review first, then merge #35392.
        const market = add(pr({ number: 35392, repo: seed, title: 'feat: add the market and create_seedling mcp tools to seed-api', created: 2 * DAY, updated: HOUR, headBranch: 'stack-35392', additions: 410, deletions: 60 }), noReview);
        const marketTheirs = ['feat: list a seedling on the market', 'feat: buy a listed seedling', 'feat: cancel a listing', 'feat: market fees per region', 'feat: notify the seller on a sale', 'test: market end to end'].map((title, i) =>
          add(pr(linked({ number: 37286 + i, repo: seed, title, author: 'ivaremilsson', created: 3 * DAY, updated: 5 * HOUR, additions: 60 + i * 10, deletions: 8 }, i ? 37285 + i : 35392)), { checks: 'success', reviewedSha: `old-${37286 + i}`, commentCount: i === 0 ? 4 : 0 }));
        const lone = add(pr({ number: 377, repo: launcher, title: 'feat: block launches until the player accepts the terms in the launcher', author: 'ivaremilsson', created: 3 * DAY, updated: 5 * HOUR, additions: 70, deletions: 12 }), { checks: 'success', reviewedSha: 'old-377', commentCount: 12 });
        // A restack of a draft: its parent merged.
        const parent = pr({ number: 35390, repo: seed, title: 'feat: seedling events API', created: 4 * DAY, updated: DAY, headBranch: 'events-1' });
        parent.merged = true;
        parent.state = 'closed';
        const restack = add(pr({ number: 35391, repo: seed, title: 'feat: deliver seedling events to chatgpt through seed-api’s mcp events', created: 3 * DAY, updated: 20 * HOUR, baseBranch: 'events-1' }), noReview);
        restack.isDraft = true;
        // Two more large merges nobody reviewed: counted under Next up.
        const large = ['feat(rust): integrate the Rust worker workspace', 'chore: vendor the Steamworks SDK headers'].map((title, i) =>
          single(add(pr({ number: 640 + i, repo: [seed, launcher][i], title, created: 2 * DAY, updated: (20 + i) * HOUR, additions: 1630, deletions: 90, files: 40 }), noReview)));
        // Decisions: failing or idle for over a week.
        const decisions = [
          single(add(pr({ number: 35316, repo: seed, title: 'perf: keep unity’s terrain heights as 16-bit integers in the polygon navmesh', created: 20 * DAY, updated: 13 * DAY, requested: ['plucked'] }), { checks: 'success', commentCount: 2 })),
          single(add(pr({ number: 371, repo: launcher, title: 'fix: build the Icon Composer app icon on the mac runner', created: 15 * DAY, updated: 13 * DAY }), { checks: 'failure' })),
          single(add(pr({ number: 1959, repo: portal, title: 'feat: let the launcher and game read and save a player’s language', created: 14 * DAY, updated: 12 * DAY }), { checks: 'failure', commentCount: 1 })),
        ];
        // You: failing checks and conflicts that are not a week old.
        const fixes = [
          single(add(pr({ number: 36990, repo: seed, title: 'fix: retry the store webhook once before failing the order', created: 2 * DAY, updated: DAY }), { checks: 'failure', commentCount: 3 })),
          single(add(pr({ number: 722, repo: launcher, title: 'fix: read the player language from the launcher', created: 2 * DAY, updated: DAY }), { checks: 'success', mergeable: 'CONFLICTING', mergeState: 'DIRTY' })),
        ];
        // Waiting on plucked's review for a few days.
        const plucked = single(add(pr({ number: 36950, repo: seed, title: 'fix: keep each sender’s failed command to itself', created: 4 * DAY, updated: DAY, requested: ['plucked'] }), { checks: 'success', commentCount: 1 }));
        items.splice(0, items.length,
          stackOf([steam, ...steamRest]), stackOf([blocking, ...blockingRest]), stackOf([epic, ...epicRest], 'STACK: EPIC'), stackOf([i18n, ...i18nRest]),
          stackOf([market, ...marketTheirs], 'feat: add the market and create_seedling mcp tools to seed-api', 'updated'),
          single(lone, { attention: 'updated' }), { subject: groupSubjects([parent, restack])[0], attention: 'other' },
          ...large, ...decisions, ...fixes, plucked);
        void window.electronAPI.loadPreferences().then((prefs) =>
          window.dispatchEvent(new CustomEvent('gnosis-preferences-changed', { detail: { ...prefs, repositorySettings: { ...prefs.repositorySettings, [launcher]: { icon: 'lucide:rocket', color: 'purple' }, [seed]: { color: 'green' } } } })));
        changed();
      },
      /**
       * Screenshot 39, at its real volume (about 50 rows): 7 re-reviews (#377, and six of ivaremilsson's PRs above
       * your #35392, whose merge waits for them); 10 merges nobody reviewed (four stack bases, #383, #36948, #376 with
       * no checks and #35392, and six large PRs); a restack of a draft; 6 stacks in 4 repositories, with #384 and #385
       * in two repositories each; 13 failing checks and 4 conflicts on your PRs; 7 decisions (the i18n base among
       * them); plucked's review and CI. Comments on several PRs.
       */
      real7: () => {
        const launcher = 'klang/seed-launcher';
        const seed = 'klang/seed';
        const bridge = 'klang/service-payment-bridge';
        const portal = 'klang/web-seed-portal';
        const stackOf = (members: ReviewMember[], name?: string, attention: QueueItem['attention'] = 'other'): QueueItem => {
          const subject = groupSubjects(members)[0];
          return { subject: { ...subject, ...(name ? { name } : {}) }, attention };
        };
        const linked = (spec: Spec, parent: number) => ({ ...spec, baseBranch: `stack-${parent}`, headBranch: `stack-${spec.number}` });
        const none = { ...noReview, checks: 'neutral' as const, total: 0 };
        // The payment stack: its base can merge without review and unblocks three.
        const steam = add(pr({ number: 383, repo: bridge, title: 'fix: keep Steam and Epic orders out of Adyen refunds and paid-order effects', created: 2 * DAY, updated: 18 * HOUR, headBranch: 'stack-383', additions: 310, deletions: 40 }), { ...noReview, commentCount: 2 });
        const steamRest = [384, 385, 397].map((number, i) =>
          add(pr(linked({ number, repo: bridge, title: ['fix: never commit store orders to AvaTax', 'fix: claim each store purchase before creating its order', 'feat: provision and refund Epic Games Store purchases (P2)'][i], created: 2 * DAY, updated: (17 - i) * HOUR }, i ? [384, 385][i - 1] : 383)), { ...noReview, commentCount: 2 }));
        // The blocking-objects stack: its base can merge without review and unblocks one.
        const blocking = add(pr({ number: 36948, repo: seed, title: 'fix: keep a construction’s blocking objects when their recheck fails', created: 3 * DAY, updated: 13 * HOUR, headBranch: 'stack-36948', additions: 160, deletions: 12 }), { ...noReview, commentCount: 3 });
        const blockingRest = [add(pr(linked({ number: 36962, repo: seed, title: 'fix: fail a building edit whose blocking-objects check fails', created: 6 * DAY, updated: 6 * DAY }, 36948)), { ...noReview, commentCount: 4 })];
        // STACK: EPIC: no checks at all; its base can merge without review.
        const epic = add(pr({ number: 376, repo: launcher, title: 'refactor: model the store distribution channel instead of Steam-only checks', created: 3 * DAY, updated: DAY, headBranch: 'stack-376', additions: 220, deletions: 40 }), { ...none, commentCount: 1 });
        const epicRest = [382, 378, 385].map((number, i) =>
          add(pr(linked({ number, repo: launcher, title: ['fix: quit a store-launched launcher when its last window closes', 'feat: log in with Epic on Epic Games Store launches (L3)', 'feat: import Epic purchases after an Epic login, before play (L3b)'][i], created: 3 * DAY, updated: DAY, additions: 80 }, i ? [382, 378][i - 1] : 376)), { ...none, commentCount: i < 2 ? 1 : 0 }));
        // The i18n stack, unnamed: its base is idle for eight days with conflicts, so it needs a decision.
        const i18n = add(pr({ number: 379, repo: launcher, title: 'feat: move the launcher’s text into translation keys (i18n 1/3)', created: 14 * DAY, updated: 8 * DAY, headBranch: 'stack-379' }), { checks: 'neutral', total: 0, mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
        const i18nRest = [380, 381, 384, 386].map((number, i) =>
          add(pr(linked({ number, repo: launcher, title: ['feat: add German, Spanish and French to the launcher (i18n 2/3)', 'feat: let players pick the launcher’s language and keep it in their account', 'refactor: derive the language in state, send translation keys, and tidy the i18n stack', 'fix: address review findings on the player-facing wording'][i], created: 8 * DAY, updated: 8 * DAY }, i ? [380, 381, 384][i - 1] : 379)), none));
        // The portal stack: its base waits on lena's review.
        const portalBase = add(pr({ number: 1960, repo: portal, title: 'feat: show the player’s language in the account menu', created: 4 * DAY, updated: 2 * DAY, requested: ['lena'], headBranch: 'stack-1960' }), { checks: 'success', commentCount: 1 });
        const portalRest = [1961, 1962].map((number, i) =>
          add(pr(linked({ number, repo: portal, title: ['feat: remember the chosen language per account', 'feat: translate the checkout'][i], created: 4 * DAY, updated: 2 * DAY }, i ? 1961 : 1960)), noReview));
        // The wallet stack, named: its base fails checks.
        const wallet = add(pr({ number: 36100, repo: seed, title: 'feat: wallet balance API with per-currency rounding', created: 2 * DAY, updated: 9 * HOUR, headBranch: 'stack-36100' }), { checks: 'failure', commentCount: 2 });
        const walletRest = [add(pr(linked({ number: 36101, repo: seed, title: 'feat: wallet balance in the HUD', created: 2 * DAY, updated: 9 * HOUR }, 36100)), noReview)];
        // The market stack: six of ivaremilsson's PRs above your base changed since your review.
        const market = add(pr({ number: 35392, repo: seed, title: 'feat: add the market and create_seedling mcp tools to seed-api', created: 4 * DAY, updated: 2 * DAY, headBranch: 'stack-35392', additions: 410, deletions: 60 }), noReview);
        const marketTheirs = ['feat: list a seedling on the market', 'feat: buy a listed seedling', 'feat: cancel a listing', 'feat: market fees per region', 'feat: notify the seller on a sale', 'test: market end to end'].map((title, i) =>
          add(pr(linked({ number: 37286 + i, repo: seed, title, author: 'ivaremilsson', created: 5 * DAY, updated: 4 * DAY, additions: 60 + i * 10, deletions: 8 }, i ? 37285 + i : 35392)), { checks: 'success', reviewedSha: `old-${37286 + i}`, commentCount: i === 0 ? 24 : 0 }));
        const lone = add(pr({ number: 377, repo: launcher, title: 'feat: block launches until the player accepts the terms in the launcher', author: 'ivaremilsson', created: 16 * DAY, updated: 15 * DAY, additions: 70, deletions: 12 }), { checks: 'success', reviewedSha: 'old-377' });
        // A restack of a draft: its parent merged.
        const parent = pr({ number: 35390, repo: seed, title: 'feat: seedling events API', created: 4 * DAY, updated: DAY, headBranch: 'events-1' });
        parent.merged = true;
        parent.state = 'closed';
        const restack = add(pr({ number: 35391, repo: seed, title: 'feat: deliver seedling events to chatgpt through seed-api’s mcp events', created: 3 * DAY, updated: DAY, baseBranch: 'events-1' }), { ...noReview, commentCount: 8 });
        restack.isDraft = true;
        // Six large merges nobody reviewed.
        const large = ['feat(rust): integrate the Rust worker workspace', 'chore: vendor the Steamworks SDK headers', 'feat: new launcher shell with a native title bar', 'feat: store catalogue sync for Epic', 'refactor: split the payment bridge by store', 'feat: seed-api admin tools'].map((title, i) =>
          single(add(pr({ number: 640 + i, repo: [seed, launcher, bridge][i % 3], title, created: 2 * DAY, updated: (20 + i) * HOUR, additions: 1630 - i * 100, deletions: 90, files: 40 }), noReview)));
        // Seven decisions: failing, idle or conflicted for over a week.
        const decisions = [
          single(add(pr({ number: 371, repo: launcher, title: 'fix: build the Icon Composer app icon on the mac runner', created: 15 * DAY, updated: 13 * DAY }), { checks: 'failure' })),
          single(add(pr({ number: 1959, repo: portal, title: 'feat: let the launcher and game read and save a player’s language', created: 14 * DAY, updated: 12 * DAY }), { checks: 'failure', commentCount: 1 })),
          single(add(pr({ number: 35432, repo: seed, title: 'feat: serve in-game notifications from seed-api', created: 14 * DAY, updated: 12 * DAY }), { checks: 'success', mergeable: 'CONFLICTING', mergeState: 'DIRTY', commentCount: 7 })),
          single(add(pr({ number: 15914, repo: 'klang/iac-gcloud', title: 'feat: add the seed:notifications:read scope for seed-api', created: 14 * DAY, updated: 12 * DAY }), { checks: 'failure', mergeable: 'CONFLICTING', mergeState: 'DIRTY', commentCount: 4 })),
          single(add(pr({ number: 36138, repo: seed, title: 'fix: don’t count a production whose output swap was refused', created: 13 * DAY, updated: 11 * DAY }), { checks: 'failure', commentCount: 3 })),
          single(add(pr({ number: 36164, repo: seed, title: 'fix: keep an onboarding chat quest until its seedling reaches the chat system', created: 13 * DAY, updated: 11 * DAY }), { checks: 'failure', commentCount: 3 })),
        ];
        // Your PRs: 13 failing checks and 4 conflicts, all under a week old.
        const failingTitles = ['fix: retry the store webhook once before failing the order', 'feat: Epic entitlement cache', 'fix: keep the patch queue across restarts', 'chore: pin the Unity build image', 'fix: round wallet totals per currency',
          'feat: seed-api health endpoint', 'fix: close the launcher log on exit', 'test: cover the refund path', 'fix: drop stale Steam sessions', 'feat: per-region store prices', 'fix: keep chat presence across reconnects', 'chore: bump the CLI to 4.2.1', 'fix: guard the empty inventory'];
        const failing = failingTitles.map((title, i) =>
          single(add(pr({ number: 36990 + i, repo: [seed, launcher, bridge, portal, 'klang/iac-gcloud'][i % 5], title, created: (2 + (i % 4)) * DAY, updated: (1 + (i % 5)) * DAY }), { checks: 'failure', commentCount: i % 3 })));
        const conflictTitles = ['fix: read the player language from the launcher', 'feat: Epic achievements', 'fix: one ledger row per purchase', 'refactor: split the launcher settings'];
        const conflicts = conflictTitles.map((title, i) =>
          single(add(pr({ number: 722 + i, repo: [launcher, launcher, bridge, seed][i], title, created: 3 * DAY, updated: (1 + i) * DAY }), { checks: 'success', mergeable: 'CONFLICTING', mergeState: 'DIRTY' })));
        // Waiting on plucked's review, and on CI.
        const plucked = single(add(pr({ number: 36950, repo: seed, title: 'fix: keep each sender’s failed command to itself', created: 4 * DAY, updated: DAY, requested: ['plucked'] }), { checks: 'success', commentCount: 1 }));
        const running = single(add(pr({ number: 36960, repo: seed, title: 'feat: spin wallet balance digits with a new NumberFlow label', created: DAY, updated: 2 * HOUR }), { checks: 'pending', decision: 'APPROVED' }));
        items.splice(0, items.length,
          stackOf([steam, ...steamRest]), stackOf([blocking, ...blockingRest]), stackOf([epic, ...epicRest], 'STACK: EPIC'), stackOf([i18n, ...i18nRest]),
          stackOf([portalBase, ...portalRest]), stackOf([wallet, ...walletRest], 'Wallet'),
          stackOf([market, ...marketTheirs], undefined, 'updated'),
          single(lone, { attention: 'updated' }), { subject: groupSubjects([parent, restack])[0], attention: 'other' },
          ...large, ...decisions, ...failing, ...conflicts, plucked, running);
        void window.electronAPI.loadPreferences().then((prefs) =>
          window.dispatchEvent(new CustomEvent('gnosis-preferences-changed', { detail: { ...prefs, repositorySettings: { ...prefs.repositorySettings, [launcher]: { icon: 'lucide:rocket', color: 'purple' }, [seed]: { color: 'green' }, [bridge]: { icon: 'lucide:columns-2' } } } })));
        changed();
      },
      /**
       * The queue last synced `ms` ago; `checking` while a discovery runs, with `extra` such as its progress or
       * `requested`. The change signals answer unless `extra.signals` says otherwise. The next snapshot carries it.
       */
      setSync: (ms: number, value: WorkbenchSync['status'] = 'idle', extra: Partial<WorkbenchSync> = {}) => {
        syncAt = Date.now() - ms;
        syncStatus = value;
        syncExtra = { signals: true, ...extra };
        changed();
      },
      discoveries,
      /** GitHub reports a new failing PR of yours: it joins Fix. */
      addFailing: (number = 334, title = 'Bundle the shell completions', repo = 'klang/cli', updated = 30 * 60_000) => {
        const member = add(pr({ number, repo, title, created: updated + 90 * 60_000, updated }), { checks: 'failure' });
        items.push(single(member));
        changed();
      },
      /** Someone asks for your review: a small PR that was not in the queue before, so the next visit sees it as new. */
      requestReview: (number = 36997, title = 'fix: keep the store webhook idempotent', author = 'lena') => {
        items.push(single(pr({ number, repo: 'klang/seed', title, author, created: 20 * 60_000, requested: [LOGIN], additions: 18, deletions: 4, files: 1 })));
        changed();
      },
      /** A PR's title changes on GitHub; its row changes in place. */
      rename: (number: number, title: string) => {
        const member = members().find((candidate) => candidate.number === number);
        if (member) member.title = title;
        for (const item of items) if (item.subject.kind === 'pr' && item.subject.members[0].number === number) item.subject = { ...item.subject, title };
        changed();
      },
      /** Empty the queue, or every action lane, for the empty and all-clear states. */
      only: (numbers: number[]) => {
        items.splice(0, items.length, ...next.filter((item) => item.subject.members.some((member) => numbers.includes(member.number))));
        changed();
      },
      restore: () => {
        items.splice(0, items.length, ...next);
        changed();
      },
      /**
       * The user's real load (#390 critique): sixteen of your PRs GitHub lets you merge, most unapproved and idle for
       * five to eight days. Adds ten parked PRs to the four Ready and two Parked rows. `restore()` takes them away.
       */
      heavy: () => {
        const titles = [
          'Move the launcher text into translation keys',
          'Only return to in-app paths after the consent page',
          'Refuse script URLs as the mobile OAuth redirect',
          'Save only schema-validated fields on profile update',
          'Keep subscription ids inside one path segment',
          'Read the player language from the launcher',
          'Add the notifications read scope',
          'Count a refused output swap as a failure',
          'Keep the onboarding quest until chat is reached',
          'Bump the CLI to 4.2.1',
        ];
        const repos = ['klang/engine', 'acme/web', 'klang/cli'];
        const extra = titles.map((title, i) =>
          single(add(pr({ number: 360 + i, repo: repos[i % 3], title, created: (9 + i) * DAY, updated: (5 + (i % 4)) * DAY, additions: 12 + i * 23, deletions: 2 + i * 5, files: 1 + (i % 5) }), noReview))
        );
        // Fix: sixteen more of your PRs, most failing checks for ten to twelve days, two with conflicts, one fresh.
        const fixes = Array.from({ length: 16 }, (_, i) => {
          const age = i === 15 ? 5 * HOUR : (10 + (i % 3)) * DAY;
          const conflicts = i === 4 || i === 9;
          return single(add(pr({ number: 380 + i, repo: repos[(i + 1) % 3], title: `Fix flaky step ${i + 1} in the release pipeline`, created: age + DAY, updated: age, additions: 10 + i * 7, deletions: 1 + i, files: 1 + (i % 4) }),
            conflicts ? { checks: 'success', mergeable: 'CONFLICTING', mergeState: 'DIRTY' } : { checks: 'failure' }));
        });
        // Waiting: two more on reviewers, one for ten days.
        const waits = [
          single(add(pr({ number: 398, repo: 'klang/engine', title: 'Keep each sender’s failed command to itself', created: 10 * DAY, requested: ['plucked'], additions: 163, deletions: 10, files: 6 }), { checks: 'success' })),
          single(add(pr({ number: 399, repo: 'acme/web', title: 'Build the translation prompt from the guidance', created: 4 * HOUR, requested: ['sam'], additions: 719, deletions: 340, files: 24 }), { checks: 'pending' })),
        ];
        items.splice(0, items.length, ...next, ...extra, ...fixes, ...waits);
        changed();
      },
    },
  });
}
