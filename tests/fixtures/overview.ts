/**
 * `?overview` (#390): a synthetic day of work across three repositories for the Overview suite. Every PR, status
 * and write is local; nothing reaches GitHub. `window.fixtureOverview` lets the suite change GitHub's side (a new
 * failing PR, a renamed PR) and read the writes the app sent.
 */
import { groupSubjects, type QueueItem, type ReviewMember, type WorkbenchQueue } from '../../lib/workbench';
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
};
function signalsFor(member: ReviewMember, status: Status): QueueSignals {
  const opinions = (status.opinions ?? []).map((opinion, i) => ({
    url: `${member.url}#pullrequestreview-${i + 1}`,
    author: opinion.author,
    state: opinion.state,
    submittedAt: at(opinion.ago),
    headSha: member.headSha,
  }));
  return {
    url: member.url,
    headSha: member.headSha,
    checkedAt: Date.now(),
    comments: status.comments?.length ?? 0,
    opinions,
    latestReview: opinions.at(-1) ?? null,
    activity: {
      recent: (status.comments ?? []).map((comment, i) => ({ kind: 'comment' as const, id: `c-${member.number}-${i}`, at: at(comment.ago), author: comment.author, automated: false })),
    },
    checks: {
      state: status.checks ?? 'success',
      passed: status.checks === 'failure' ? 8 : 10,
      failed: status.checks === 'failure' ? 2 : 0,
      running: status.checks === 'pending' ? 3 : 0,
      total: 10,
    },
    readiness: {
      state: 'OPEN',
      isDraft: false,
      mergeable: status.mergeable ?? 'MERGEABLE',
      mergeState: status.mergeState ?? 'BLOCKED',
      reviewDecision: status.decision === undefined ? 'REVIEW_REQUIRED' : status.decision,
      baseBranch: member.baseBranch,
      baseSha: member.baseSha,
      behindBy: 0,
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
  // Merge: your PRs GitHub reports ready.
  const merge1 = add(pr({ number: 301, repo: 'klang/engine', title: 'Cache resolved module paths between builds', created: 4 * DAY, updated: 2 * DAY, additions: 128, deletions: 34, files: 6 }), { ...ready, opinions: [{ author: 'lena', state: 'APPROVED', ago: 2 * DAY }] });
  const merge2 = add(pr({ number: 302, repo: 'klang/cli', title: 'Retry flaky uploads with jitter', created: 2 * DAY, updated: 5 * HOUR, additions: 22, deletions: 4, files: 2 }), { ...ready, opinions: [{ author: 'sam', state: 'APPROVED', ago: 5 * HOUR }] });
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
  const waiting1 = add(pr({ number: 341, repo: 'klang/cli', title: 'Print a summary after install', created: 2 * DAY, requested: ['lena'], additions: 33, deletions: 2, files: 2 }), { checks: 'success' });
  const waiting2 = add(pr({ number: 342, repo: 'klang/engine', title: 'Profile cold starts in CI', created: 6 * HOUR, additions: 18, deletions: 0, files: 1 }), { checks: 'pending', decision: 'APPROVED' });
  const explained = reviews[0];
  const review: ReviewHistoryEntry = { id: 'overview-explanation', prUrl: explained.url, prTitle: explained.title, status: 'completed', unread: false } as ReviewHistoryEntry;

  const single = (member: ReviewMember, extra: Partial<QueueItem> = {}): QueueItem => ({ subject: groupSubjects([member])[0], attention: 'requested', ...extra });
  const next: QueueItem[] = [
    single(merge1),
    single(merge2),
    single(answer1),
    single(answer2, { responses: { [answer2.url]: { changesRequested: false, unresolvedThreads: 2, awaitingReply: 2, complete: true } } }),
    ...reviews.map((member, i) => single(member, i === 0 ? { review } : i === 3 ? { attention: 'updated' } : {})),
    { subject: groupSubjects([fixBase, fixChild])[0], attention: 'other' },
    single(fixLone),
    single(waiting1),
    single(waiting2),
  ];
  items.splice(0, items.length, ...next);
  const members = () => items.flatMap((item) => item.subject.members);
  const find = (url: string) => members().find((member) => member.url === url);

  // One PR has unread activity, so the row menu can mark it read.
  const reads: Partial<Record<string, PrReadState>> = {
    [answer2.url]: { url: answer2.url, headSha: answer2.headSha, versions: { ...emptyReadVersions(), comments: 1 }, unread: ['comments'] },
  };
  const writes: { kind: string; url: string }[] = [];
  const reruns: CheckSelection[] = [];
  const changed = () => window.dispatchEvent(new Event('fixture-workbench-change'));

  const queue = mocks.workbenchQueue as () => Promise<WorkbenchQueue>;
  Object.assign(mocks, {
    workbenchQueue: async () => {
      const value = await queue();
      return {
        ...value,
        readStates: structuredClone(reads),
        items: value.items.map((item) => ({ ...item, unreadUrls: item.subject.members.filter((member) => reads[member.url]?.unread.length).map((member) => member.url) })),
        sync: { status: 'idle' as const, checkedAt: Date.now() - 2 * 60_000 },
      };
    },
    workbenchMarkPrRead: (request: MarkPrReadRequest) => {
      for (const receipt of request.receipts) { const state = reads[receipt.url]; if (state) state.unread = request.read ? [] : ["manual"]; }
      writes.push({ kind: request.read ? 'mark-read' : 'mark-unread', url: request.receipts.map((receipt) => receipt.url).join(',') });
      return (mocks.workbenchQueue as () => Promise<WorkbenchQueue>)();
    },
    getQueueSignals: (requests: QueueSignalRequest[]) =>
      Promise.resolve(
        requests.flatMap((request) => {
          const member = find(request.url);
          return member && member.headSha === request.headSha ? [signalsFor(member, status.get(member.url) ?? { checks: 'success' })] : [];
        })
      ),
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
      writes.push({ kind: request.kind, url: request.url });
      const member = find(request.url);
      if (request.kind === 'merge' && member) {
        member.merged = true;
        member.state = 'closed';
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
    rerunChecks: (target: CheckSelection & { mode: 'failed' | 'all' }) => {
      reruns.push(target);
      writes.push({ kind: `rerun-${target.mode}`, url: target.url });
      return Promise.resolve();
    },
  });

  Object.assign(window, {
    fixtureOverview: {
      writes,
      reruns,
      /** GitHub reports a new failing PR of yours: it joins Fix. */
      addFailing: (number = 334, title = 'Bundle the shell completions') => {
        const member = add(pr({ number, repo: 'klang/cli', title, created: 2 * HOUR, updated: 30 * 60_000 }), { checks: 'failure' });
        items.push(single(member));
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
    },
  });
}
