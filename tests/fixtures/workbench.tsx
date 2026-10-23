import { normalizeViews, editViewFilters, applyViewAction, activeViewFilters, type QueueViewAction } from '../../lib/saved-views';
import { matchesQueueFilters } from '../../lib/queue-filters';
import { normalizeQueueFilters, type QueueFilters } from '../../lib/queue-filters';
import type { ActivityTask, ActivityAction } from '../../lib/activity';
import { createRoot } from 'react-dom/client';
import { threadMocks } from './review-threads';
import '../../src/globals.css';
import { groupSubjects, snapshot, memberPrefix, type ReviewMember, type QueueItem } from '../../lib/workbench';
import type { Preferences, ReviewGuide, ReviewHistoryEntry } from '../../lib/types';
import { DEFAULT_CLAUDE_MODEL, DEFAULT_FAST_CLAUDE_MODEL } from '../../lib/models';
import { review as example, slide, explainer } from './explainer';
const filterStorageKey = 'fixture-queue-filters' + location.search;
let queueFilters = normalizeQueueFilters(JSON.parse(sessionStorage.getItem(filterStorageKey) ?? 'null'));
const viewsStorageKey = 'fixture-views' + location.search;
let savedViews = normalizeViews(JSON.parse(sessionStorage.getItem(viewsStorageKey) ?? 'null'), queueFilters);
queueFilters = activeViewFilters(savedViews);
const saveViews = () => {
  sessionStorage.setItem(viewsStorageKey, JSON.stringify(savedViews));
  queueFilters = activeViewFilters(savedViews);
  sessionStorage.setItem(filterStorageKey, JSON.stringify(queueFilters));
};
const onboardingScenario = new URLSearchParams(location.search).has('onboarding');
let fixtureAuthenticated = !onboardingScenario;
let fixtureStarted = false;
const polishScenario = new URLSearchParams(location.search).has('polish');
let statusFailures = polishScenario ? 3 : 0;
const date = '2026-10-22T15:30:00Z';
const titles = [
  'Introduce a bounded command queue',
  'Route worker commands through the queue',
  'Enable adaptive batching for worker dispatch',
];
const members: ReviewMember[] = titles.map((title, i) => ({
  number: 120 + i,
  repo: 'klang/engine',
  headRepo: 'klang/engine',
  baseRepo: 'klang/engine',
  url: `https://github.com/klang/engine/pull/${120 + i}`,
  title,
  description: 'Keep command processing responsive under load.',
  author: 'maya',
  role: 'review-requested',
  baseBranch: i ? `queue-${i - 1}` : 'main',
  headBranch: `queue-${i}`,
  baseSha: `base-${i}`,
  headSha: `head-${i}`,
  merged: false,
  state: 'open',
  createdAt: date,
  updatedAt: date,
  labels: [],
  mergeable: true,
  isDraft: false,
  commitCount: 3,
  requestedReviewers: ['oddur'],
  requestedTeams: [],
  mergeableState: 'clean',
  autoMerge: null,
  milestone: null,
}));
const subject = groupSubjects(members)[0];
const prefix = memberPrefix(members[1]);
const review: ReviewGuide = {
  ...example,
  reviewId: 'workbench-review',
  snapshot: snapshot(subject),
  prTitle: 'Keep command processing responsive under load',
  summary:
    'This stack introduces a bounded command queue, moves worker dispatch onto it, and adapts batch sizes to current load. Together, these changes prevent a busy producer from monopolizing the worker while preserving command order.',
  riskLevel: 'medium',
  riskRationale:
    'Review the backpressure path and command ordering across worker handoffs. Cancellation must release the queue slot even when a batch is only partially processed.',
  changedFiles: [{ filename: prefix + 'src/command-queue.ts', status: 'modified', additions: 6, deletions: 1 }],
  totalFilesChanged: 12,
  totalLinesChanged: 386,
  slides: [
    {
      ...slide,
      title: 'Bound work before it reaches the worker',
      narrative:
        'The queue puts an explicit limit on pending commands. Producers wait when the queue is full, so a traffic spike cannot grow memory without bound.\n\n**Ordering remains local to each worker.** The dispatcher drains a batch before accepting the next one. Cancellation releases pending slots and lets the next producer continue.',
      diffHunks: slide.diffHunks.map((h) => ({
        ...h,
        filePath: prefix + 'src/command-queue.ts',
        hunkHeader: '@@ -1,3 +1,8 @@',
        content:
          ' export async function dispatch(command) {\n-  return worker.run(command);\n+  const slot = await queue.acquire();\n+  try {\n+    return await worker.run(command);\n+  } finally {\n+    slot.release();\n+  }\n }',
      })),
      affectedFiles: [prefix + 'src/command-queue.ts'],
      fileSummaries: [
        {
          filePath: prefix + 'src/command-queue.ts',
          summary: 'Limits pending commands and releases queue slots when work finishes or fails.',
        },
      ],
      inlineExplanations: [
        {
          filePath: prefix + 'src/command-queue.ts',
          line: 4,
          side: 'RIGHT',
          code: 'return await worker.run(command);',
          text: 'Awaiting dispatch inside `try` keeps the slot occupied until work finishes. Returning the promise directly would run `finally` before that work completes.',
        },
      ],
      explainer: { ...explainer },
      reviewChecks: [{ text: 'Does cancellation release the slot before the next producer waits?' }],
    },
    {
      ...slide,
      id: 'slide-2',
      slideNumber: 2,
      title: 'Adapt batches without changing order',
      narrative: 'The scheduler adjusts batch size using the previous dispatch latency.',
    },
    {
      ...slide,
      id: 'slide-3',
      slideNumber: 3,
      title: 'Verify cancellation and recovery',
      slideType: 'test',
      narrative: 'Tests cover queue capacity, worker failures, and cancellation.',
    },
  ],
};
const history: ReviewHistoryEntry[] = [
  {
    id: 'workbench-review',
    prTitle: review.prTitle,
    prUrl: subject.members[0].url,
    author: 'maya',
    savedAt: date,
    riskLevel: 'medium',
    status: 'completed',
    snapshot: review.snapshot,
    summary: review.summary,
  },
];
const otherTitles = [
  'Fix reconnect handling after transport shutdown',
  'Reduce allocations in snapshot serialization',
  'Add trace context to scheduled jobs',
  'Document worker lifecycle guarantees',
  'Handle empty batches in the scheduler',
  'Remove obsolete feature flags',
];
const items: QueueItem[] = [
  {
    subject,
    attention: 'requested',
    review: history[0],
    briefing: {
      key: 'fixture',
      status: 'ready',
      summary: review.summary,
      systems: ['Command dispatch', 'Worker lifecycle', 'Backpressure'],
      priorities: [
        'Cancellation must release queue capacity.',
        'Commands must preserve order within each worker.',
        'Batch size must stay within latency and capacity limits.',
      ],
      updatedAt: date,
    },
  },
  ...otherTitles.map((title, i) => ({
    subject: groupSubjects([
      {
        ...members[0],
        number: 150 + i,
        url: `https://github.com/klang/engine/pull/${150 + i}`,
        title,
        headBranch: `fix-${i}`,
        author: ['lena', 'sam', 'owen'][i % 3],
      },
    ])[0],
    attention: i < 2 ? ('updated' as const) : i < 4 ? ('requested' as const) : ('other' as const),
    briefing: {
      key: `other-${i}`,
      status: 'ready' as const,
      summary: [
        'Preserve pending messages when the transport reconnects.',
        'Reuse scratch buffers across serialization passes.',
        'Carry trace context across asynchronous job boundaries.',
      ][i % 3],
      updatedAt: date,
    },
  })),
];
if (new URLSearchParams(location.search).has('stacks')) {
  for (const [index, attention] of [
    [1, 'updated'],
    [2, 'other'],
  ] as const) {
    const parent = items[index].subject.members[0];
    items[index].subject = groupSubjects([
      parent,
      {
        ...parent,
        number: parent.number + 100,
        url: parent.url + '0',
        headBranch: parent.headBranch + '-child',
        baseBranch: parent.headBranch,
      },
    ])[0];
    items[index].attention = attention;
  }
}
if (new URLSearchParams(location.search).has('pr-summary')) {
  const pr = items[1].subject.members[0];
  pr.description = `## Preserve queued messages across reconnects

Messages waiting for a connection now stay in the **outbox** until the replacement transport is ready. The old transport can close without losing work.

![Reconnect flow](${location.origin}/tests/fixtures/pr-description.svg)

### Verification

- [x] Disconnect while messages are queued
- [ ] Exercise a slow reconnect

| Before | After |
| --- | --- |
| Pending messages are dropped | Pending messages are replayed in order |

\`\`\`ts
await transport.reconnect();
await outbox.flush();
\`\`\`

<details><summary>Implementation notes</summary>

The outbox owns the pending messages, so replacing the socket does not clear them.

<img src="${location.origin}/tests/fixtures/pr-description.svg" width="360" alt="HTML reconnect screenshot" onerror="window.unsafeDescription = true">

</details>

[Source](src/outbox.ts) · ![Relative image](docs/reconnect.png)

![Private attachment](https://github.com/user-attachments/assets/01234567-89ab-cdef-0123-456789abcdef)

<script>window.unsafeDescription = true</script><iframe src="https://example.com"></iframe>
<a href="javascript:alert(1)">Unsafe link</a>
`;
  pr.assignees = ['lena'];
  pr.labels = ['bug'];
  pr.labelDetails = [{ name: 'bug', color: 'd73a4a' }];
  items[1].briefing = undefined;
  items[2].subject.members[0].description = '';
}
if (new URLSearchParams(location.search).has('labels')) {
  const stack = items[0].subject.members;
  stack[0].labels = ['bug', 'needs-review'];
  stack[0].labelDetails = [{ name: 'bug', color: 'd73a4a', description: 'Something is not working' }, { name: 'needs-review', color: 'fbca04' }];
  stack[1].labels = ['bug', 'performance', 'documentation'];
  stack[1].labelDetails = [{ name: 'bug', color: 'd73a4a' }, { name: 'performance', color: '0052cc' }, { name: 'documentation', color: '0075ca' }];
  stack[2].labels = ['legacy-label'];
  items[1].subject.members[0].labels = ['old-cache-label'];
  items[2].subject.members[0].labels = ['a-very-long-label-name-for-layout-validation'];
  items[2].subject.members[0].labelDetails = [{ name: 'a-very-long-label-name-for-layout-validation', color: 'ffffff' }];
  items[3].subject.members[0].labels = ['critical'];
  items[3].subject.members[0].labelDetails = [{ name: 'critical', color: '000000' }];
}
if (new URLSearchParams(location.search).has('mine')) {
  for (const item of items.slice(1)) {
    item.subject.members[0].role = 'watched';
    item.subject.members[0].requestedReviewers = [];
  }
  items[1].subject.members[0].assignees = ['oddur'];
  items[2].subject.members[0].author = 'oddur';
}
if (new URLSearchParams(location.search).has('filters')) {
  items[1].subject.members[0].isDraft = true;
  items[1].subject.members[0].labels = ['bug'];
  items[1].subject.members[0].createdAt = '2020-01-01T00:00:00Z';
  for (const item of items)
    for (const member of item.subject.members) {
      member.updatedAt = new Date().toISOString();
      if (member.createdAt !== '2020-01-01T00:00:00Z') member.createdAt = new Date().toISOString();
    }
}
if (polishScenario) {
  items[0].briefing = { key: 'paused', status: 'paused', updatedAt: date };
  // A long file followed by a different stack member exercises sticky attribution.
  const first = review.slides[0].diffHunks[0];
  first.content =
    ' // Preserve producer order.\n' +
    first.content +
    '\n' +
    Array.from({ length: 70 }, (_, i) => ` // Dispatch context ${i + 1}`).join('\n');
  review.slides[0].diffHunks.push({ ...first, filePath: memberPrefix(members[2]) + 'src/batch-scheduler.ts' });
  review.slides[1].title =
    'Adapt batches without changing order or allowing a busy producer to monopolize the worker during cancellation';
}
let prefs: Preferences = {
  instructions: '',
  provider: 'claude',
  model: DEFAULT_CLAUDE_MODEL,
  thinking: true,
  smartImports: true,
  reviewSuggestions: true,
  enableTools: false,
  enableWebResearch: false,
  proactiveMode: false,
  autoBriefings: true,
  briefingDailyLimit: 10,
  watchedRepos: ['klang/engine'],
  codeTheme: 'github-light',
  codeFont: 'jetbrains-mono',
  claudePath: '',
  codexPath: '',
  notifications: false,
  diffLayout: 'unified',
  includeAllFiles: true,
  reviewSignature: false,
  firstRunSeen: onboardingScenario ? sessionStorage.getItem('fixture-first-run-seen') === 'true' : true,
  theme: 'light',
  trayEnabled: false,
  maxPrsPerRepo: 10,
  parallelReview: true,
  analytics: false,
  proactiveReviewOverrides: true,
  proactiveProvider: 'claude',
  proactiveModel: DEFAULT_FAST_CLAUDE_MODEL,
  proactiveThinking: false,
  educationMode: true,
  claudeContext: false,
  guestMode: false,
};
let activities: ActivityTask[] = [
  {
    id: 'exploration:ready',
    kind: 'exploration',
    title: 'Queue capacity, illustrated',
    detail: 'Bound work before it reaches the worker',
    reviewId: 'workbench-review',
    slideId: 'slide-1',
    model: 'gpt-6-astra',
    status: 'completed',
    updatedAt: date,
    canCancel: false,
    canRetry: false,
  },
  {
    id: 'review:running',
    kind: 'review',
    title: 'Improve worker recovery',
    detail: 'Writing sections',
    model: 'gpt-6-astra',
    status: 'running',
    progress: { completed: 4, total: 15 },
    updatedAt: date,
    canCancel: true,
    canRetry: false,
  },
  {
    id: 'exploration:running',
    kind: 'exploration',
    title: 'Explain cancellation',
    detail: 'Generating an interactive explanation',
    model: 'gpt-6-astra',
    status: 'running',
    updatedAt: date,
    canCancel: true,
    canRetry: false,
  },
  {
    id: 'briefing:queued',
    kind: 'briefing',
    title: 'Inspect scheduler changes',
    detail: 'Waiting to start',
    model: 'gpt-6-astra',
    status: 'queued',
    updatedAt: date,
    canCancel: true,
    canRetry: false,
  },
  {
    id: 'review:failed',
    kind: 'review',
    title: 'Review transport shutdown',
    detail: 'Provider rate limit. Retry when capacity is available.',
    model: 'gpt-6-astra',
    status: 'failed',
    updatedAt: date,
    canCancel: false,
    canRetry: true,
  },
  {
    id: 'review:ready',
    kind: 'review',
    title: review.prTitle,
    detail: 'Review ready',
    reviewId: 'workbench-review',
    model: 'gpt-6-astra',
    status: 'completed',
    updatedAt: date,
    canCancel: false,
    canRetry: false,
  },
];
if (onboardingScenario) activities = [];
const mocks = {
  listActivity: () => Promise.resolve(activities),
  activityAction: (id: string, action: ActivityAction) => {
    if (action === 'dismiss') activities = activities.filter((t) => t.id !== id);
    else
      activities = activities.map((t) =>
        t.id !== id
          ? t
          : {
              ...t,
              status: action === 'cancel' ? 'cancelled' : 'running',
              detail: action === 'cancel' ? 'Cancelled' : 'Preparing review',
              canCancel: action === 'retry',
              canRetry: action === 'cancel',
              progress: undefined,
            }
      );
    return Promise.resolve();
  },
  detectBinaryPath: (name: string) => Promise.resolve('/fixture/' + name),
  getAuthState: () =>
    Promise.resolve({ authenticated: fixtureAuthenticated, login: fixtureAuthenticated ? 'oddur' : null }),
  startOAuth: () => {
    fixtureAuthenticated = true;
    return Promise.resolve();
  },
  startReview: () => {
    fixtureStarted = true;
    return Promise.resolve({ reviewId: 'workbench-review', prUrl: review.prUrl, prTitle: review.prTitle, author: review.author });
  },
  getPrMetadata: (url: string) => Promise.resolve(items.flatMap((item) => item.subject.members).find((member) => member.url === url) ?? { ...members[0], url, title: 'A PR outside the queue' }),
  loadPreferences: () => Promise.resolve(prefs),
  savePreferences: (next: Preferences) => {
    prefs = next;
    if (onboardingScenario) sessionStorage.setItem('fixture-first-run-seen', String(next.firstRunSeen));
    return Promise.resolve();
  },
  workbenchViewAction: (action: QueueViewAction) => {
    savedViews = applyViewAction(savedViews, action, () => crypto.randomUUID());
    saveViews();
    return Promise.resolve(mocks.workbenchQueue());
  },
  workbenchSetFilters: (filters: QueueFilters) => {
    savedViews = editViewFilters(savedViews, filters);
    saveViews();
    queueFilters = normalizeQueueFilters(filters);
    sessionStorage.setItem(filterStorageKey, JSON.stringify(queueFilters));
    return Promise.resolve(mocks.workbenchQueue());
  },
  workbenchQueue: () =>
    Promise.resolve({
      filters: queueFilters,
      savedViews: { ...savedViews, counts: Object.fromEntries(savedViews.views.map(view => [view.id, items.filter(item => matchesQueueFilters(item, view.filters, Date.now(), 'oddur')).length])) },
      items: onboardingScenario && !fixtureStarted ? [] : items,
      warnings: [],
      remaining: polishScenario ? 0 : 7,
    }),
  listReviews: () => Promise.resolve(onboardingScenario && !fixtureStarted ? [] : history),
  loadReview: () => Promise.resolve(review),
  reRenderHunks: (r: ReviewGuide) => Promise.resolve(r),
  getReviewThreads: () => Promise.resolve({ headSha: 'fixture-head', baseSha: 'fixture-base', threads: [] }),
  getPrStatus: () =>
    statusFailures-- > 0
      ? Promise.reject(new Error('API rate limit exceeded. Request ID fixture-request. Retry after the limit resets.'))
      : Promise.resolve({
          labels: [],
          mergeable: true,
          isDraft: false,
          ciChecks: [],
          ciConclusion: 'success',
          reviewSummary: { approved: 1, changesRequested: 0, commented: 0 },
          baseBranch: 'main',
          commitCount: 3,
          requestedReviewers: [],
          requestedTeams: [],
          mergeableState: 'clean',
          autoMerge: null,
          milestone: null,
        }),
  workbenchFreshness: () =>
    Promise.resolve(
      polishScenario
        ? { status: 'unknown', reason: 'API rate limit exceeded. ' + 'Technical diagnostic details. '.repeat(30) }
        : { status: 'current' }
    ),
  getPendingUpdateReady: () => Promise.resolve(null),
  generateExplainer: () => {
    document.body.dataset.explainerCalls = String(Number(document.body.dataset.explainerCalls ?? 0) + 1);
    return Promise.resolve(explainer);
  },
  checkCliInstalled: () =>
    Promise.resolve({ installed: !onboardingScenario, resolvedPath: onboardingScenario ? null : '/fixture/claude' }),
  platform: 'darwin',
  isPackaged: false,
};
if (new URLSearchParams(location.search).has('threads')) Object.assign(mocks, threadMocks());
Object.defineProperty(window, 'electronAPI', {
  value: new Proxy(mocks, {
    get: (target, key) => (key in target ? target[key as keyof typeof target] : () => Promise.resolve()),
  }),
});
if (!new URLSearchParams(location.search).has('keep-progress')) localStorage.clear();
const { renderDiffHunk } = await import('../../lib/highlight');
for (const topic of review.slides)
  for (const hunk of topic.diffHunks)
    hunk.renderedHtml = await renderDiffHunk(
      hunk.content,
      hunk.language,
      polishScenario ? 'aurora-x' : 'github-dark',
      hunk.hunkHeader
    );
const { App } = await import('../../src/App');
const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
