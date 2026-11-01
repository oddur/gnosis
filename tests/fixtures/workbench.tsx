import { automaticBriefingBlock } from '../../lib/repository-settings';
import { setupViews, setupPreferences, type OnboardingState, type SetupDraft } from '../../lib/onboarding';
import { checksMocks } from './pr-checks';
import { markdownBefore, markdownAfter, markdownFiles } from './markdown-review';
import { prBadgePreview } from '../../lib/pr-badge-preview';
import { fileFilterMocks, filterFixtureFiles } from './file-filters';
import { emptyReadVersions, type PrReadState, type MarkPrReadRequest } from '../../lib/pr-read-state';
import './select-option';
import { matchesPrInactivity, normalizePrInactivityDays } from '../../lib/pr-inactivity';
import { withoutMutedMembers, isMutedReview } from '../../lib/muted-prs';
import { searchHit, queueDocuments, reviewDocuments, searchDocuments, threadDocuments } from '../../lib/command-search';
import { normalizeViews, editViewFilters, applyViewAction, activeViewFilters, type QueueViewAction } from '../../lib/saved-views';
import { matchesQueueFilters } from '../../lib/queue-filters';
import { normalizeQueueFilters, type QueueFilters } from '../../lib/queue-filters';
import type { ActivityTask, ActivityAction } from '../../lib/activity';
import { createRoot } from 'react-dom/client';
import { imageMocks } from './review-images';
import { threadMocks } from './review-threads';
import '../../src/globals.css';
import { groupSubjects, snapshot, memberPrefix, type ReviewMember, type QueueItem } from '../../lib/workbench';
import type { Preferences, ReviewGuide, ReviewHistoryEntry } from '../../lib/types';
import { DEFAULT_CLAUDE_MODEL, DEFAULT_FAST_CLAUDE_MODEL } from '../../lib/models';
import { review as example, slide, explainer } from './explainer';
let fixtureMutes: import('../../lib/muted-prs').MutedPr[] = JSON.parse(sessionStorage.getItem('fixture-mutes') ?? '[]');
const fixtureMutedUrls = () => new Set(fixtureMutes.map(entry => entry.member.url));
let fixtureStars: import('../../lib/starred-prs').StarredPr[] = JSON.parse(sessionStorage.getItem('fixture-stars') ?? '[]');
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
if (new URLSearchParams(location.search).has('navigation-history') && !savedViews.views.length) {
  savedViews = applyViewAction(savedViews, { type: 'create', name: 'History view' }, () => 'history-view');
  savedViews = applyViewAction(savedViews, { type: 'activate', id: null }, () => 'unused');
  saveViews();
}
const onboardingScenario = new URLSearchParams(location.search).has('onboarding') || new URLSearchParams(location.search).has('ftue');
const detectedTools = new Map<string, { installed: boolean; resolvedPath: string | null }>();
let fixtureAuthenticated = new URLSearchParams(location.search).has('ftue') ? sessionStorage.getItem('ftue-auth') === 'true' : !onboardingScenario;
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
if (new URLSearchParams(location.search).has('markdown-explanation')) {
  const path = prefix + 'docs/retry.md';
  review.changedFiles = [{ filename: path, status: 'modified', additions: 2, deletions: 2 }];
  review.slides = [{ ...review.slides[0], title: 'Clarify retry limits', narrative: 'Requests retry five times. The warning now describes when to stop.', affectedFiles: [path],
    fileSummaries: [{ filePath: path, summary: 'Clarifies retry limits and the final warning.' }],
    inlineExplanations: [{ filePath: path, side: 'RIGHT', line: 22, code: 'Retry five times.', text: 'The limit includes the first attempt; it permits four retries.' }],
    diffHunks: [
      { filePath: path, language: 'markdown', renderedHtml: '', hunkHeader: '@@ -10,13 +10,13 @@', content: ' # Retry guide\n \n Saved context near the start.\n \n More saved context.\n \n Keep the request ID.\n \n Unchanged setup.\n \n ## Retry policy\n \n-Retry three times.\n+Retry five times.' },
      { filePath: path, language: 'markdown', renderedHtml: '', hunkHeader: '@@ -80,1 +82,1 @@', content: '-Old warning.\n+Stop after the final attempt.' },
    ], reviewChecks: [], explainer: undefined, explainerIdea: undefined, mermaidDiagram: undefined, d2Diagram: undefined,
  }];
}
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
        headBranch: i === 0 && new URLSearchParams(location.search).has('entity-badges') ? 'feature/streaming-worker-command-queue/cancellation-aware-backpressure' : `fix-${i}`,
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

\`\`\`mermaid
flowchart LR
  A[Queued messages] --> B[Outbox]
  B --> C[New transport]
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
if (new URLSearchParams(location.search).has('target-branch')) {
  items[0].subject.members[0].baseBranch = 'release/1.2';
  items[1].subject.members[0].baseBranch = 'release/2.1';
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
  items[0].briefing = { key: 'paused', status: 'paused', pauseDetail: 'Daily briefing attempt limit reached. Resets at midnight.', updatedAt: date };
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
if (new URLSearchParams(location.search).has('inactivity')) {
  const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString();
  items[0].subject.members[0].updatedAt = daysAgo(150);
  items[0].subject.members[1].updatedAt = daysAgo(2);
  items[0].subject.members[2].updatedAt = daysAgo(150);
  items[1].subject.members[0].updatedAt = daysAgo(90);
  for (const item of items.slice(2)) for (const member of item.subject.members) member.updatedAt = daysAgo(2);
}
let prefs: Preferences = {
  prInactivityDays: JSON.parse(sessionStorage.getItem('fixture-inactivity-days') ?? '30'),
  instructions: '',
  provider: 'claude',
  model: DEFAULT_CLAUDE_MODEL,
  thinking: true,
  smartImports: true,
  reviewSuggestions: true,
  enableTools: false,
  enableWebResearch: false,
  proactiveMode: false,
  autoBriefings: !onboardingScenario,
  briefingDailyLimit: 10,
  watchedRepos: new URLSearchParams(location.search).has('ftue') ? [] : ['klang/engine'],
  codeTheme: 'github-light',
  diffHighlighter: (sessionStorage.getItem('fixture-diff-highlighter') || undefined) as Preferences['diffHighlighter'],
  codeFont: 'jetbrains-mono',
  claudePath: '',
  codexPath: '',
  notifications: false,
  diffLayout: 'unified',
  stackChangesMode: new URLSearchParams(location.search).has('stack-changes') ? undefined : 'by-pr', // Legacy suites explicitly inspect each PR's changes.
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
  guestMode: onboardingScenario && sessionStorage.getItem('fixture-guest-mode') === 'true',
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
let navigateReview: ((event: Event) => void) | undefined;
const unreadScenario = new URLSearchParams(location.search).has('unread');
const fixtureReads: Record<string, PrReadState> = unreadScenario ? JSON.parse(sessionStorage.getItem('fixture-read-state') ?? 'null') ?? Object.fromEntries(items.flatMap(item => item.subject.members).map(member => {
  const versions = emptyReadVersions();
  const unread = member.number === 121 || member.number === 152 ? ['commits' as const] : [];
  if (unread.length) versions.commits = 1;
  return [member.url, { url: member.url, headSha: member.headSha, versions, unread }];
})) : {};
const updateFixtureUnread = () => {
  for (const item of items) item.unreadUrls = item.subject.members.filter(member => fixtureReads[member.url]?.unread.length).map(member => member.url);
};
updateFixtureUnread();
window.addEventListener('fixture-new-commit', () => {
  const state = fixtureReads['https://github.com/klang/engine/pull/152'];
  if (!state) return;
  state.versions.commits++;
  state.headSha = 'head-new';
  state.unread = [...new Set([...state.unread, 'commits' as const])];
  for (const item of items) for (const member of item.subject.members) if (member.number === 152) member.headSha = state.headSha;
  updateFixtureUnread();
  window.dispatchEvent(new Event('fixture-pr-read-change'));
});
const mocks = {
  getPrBadgePreview: (url:string) => {
    const item=items.find(item=>item.subject.members.some(member=>member.url===url));
    const member=item?.subject.members.find(member=>member.url===url);
    if(!member)return Promise.resolve(null);
    return Promise.resolve({...prBadgePreview(member,item?.subject,item?.briefing),signals:{url,headSha:member.headSha,checkedAt:Date.now(),comments:4,
      checks:{state:'success' as const,passed:129,skipped:1,total:130},readiness:{state:'OPEN',isDraft:false,mergeable:'MERGEABLE',mergeState:'CLEAN',reviewDecision:'APPROVED',baseBranch:member.baseBranch,baseSha:member.baseSha,behindBy:0,mergeQueue:false,queueState:null}}});
  },
  ...fileFilterMocks,
  onReviewNavigate: (callback: (id: string) => void) => {
    navigateReview = event => callback((event as CustomEvent<string>).detail);
    window.addEventListener('fixture-review-navigate', navigateReview);
  },
  offReviewNavigate: () => { if (navigateReview) window.removeEventListener('fixture-review-navigate', navigateReview); },
  renderMarkdownReview: (request: import('../../lib/markdown-review').MarkdownReviewRequest) => (window as unknown as { markdownFixture: (request: import('../../lib/markdown-review').MarkdownReviewRequest) => Promise<import('../../lib/markdown-review').MarkdownReview> }).markdownFixture(request),
  getPreparedInventories: () => Promise.resolve({ changes: [], commits: [] }),
  getPrChanges: (url: string) => {
    const member=items.flatMap(i=>i.subject.members).find(m=>m.url===url)??members[0];
    return Promise.resolve({version:1 as const,url,metadata:member,comparisonBase:member.baseSha,fetchedAt:Date.now(),files: new URLSearchParams(location.search).has('markdown-review') ? markdownFiles : new URLSearchParams(location.search).has('file-filters') ? filterFixtureFiles(url) : [
      {path:'src/worker.ts',status:'modified' as const,additions:1,deletions:1,changeId:'worker-v1',patch:'@@ -33,7 +33,7 @@\n const value32 = 32;\n const value33 = 33;\n const value34 = 34;\n-const value35 = 35;\n+const value35 = 36;\n const value36 = 36;\n const value37 = 37;\n const value38 = 38;'},
      {path:'src/new.ts',status:'added' as const,additions:2,deletions:0,changeId:'new-v1'},
      {path:'src/old.ts',status:'deleted' as const,additions:0,deletions:2,changeId:'old-v1'},
      {path:'assets/flow.svg',status:'modified' as const,additions:1,deletions:1,changeId:'image-v1'},
      {path:'pnpm-lock.yaml',status:'modified' as const,additions:1,deletions:1,changeId:'lock-v1'},
    ]});
  },
  getPrCommits: async (url: string) => {
    const snapshot = await mocks.getPrChanges(url);
    const shared = {sha:'a'.repeat(40), message:'Introduce the queue boundary\n\nKeep pending commands ordered.', author:{name:'Maya',login:'maya'}, authoredAt:date, committedAt:date, committer:'Maya',parents:['0'.repeat(40)],url:'https://github.com/klang/engine/commit/'+ 'a'.repeat(40),verified:true};
    const unique = (url.endsWith('/120') ? 'b' : url.endsWith('/121') ? 'c' : 'd').repeat(40);
    return {version:1 as const,url,metadata:snapshot.metadata,fetchedAt:Date.now(),commits:[shared,{...shared,sha:unique,message:'Keep retry boundaries intact\n\nRetain pending work after transient failures.',author:{name:'Sam',login:'sam'},parents:[shared.sha]}, {...shared,sha:'e'.repeat(39)+url.slice(-1),message:'Merge worker scheduling updates',parents:[unique,'f'.repeat(40)]}]};
  },
  getCommitComparison: async (selection: import('../../lib/pr-commits').CommitSelection) => {
    const snapshot = await mocks.getPrChanges(selection.url), list = await mocks.getPrCommits(selection.url);
    const parent = selection.parentSha ?? list.commits.find(c=>c.sha===selection.firstSha)!.parents[0];
    return {...snapshot, comparison:selection,comparisonBase:parent,metadata:{...snapshot.metadata,baseSha:parent,headSha:selection.lastSha}};
  },
  getPrChangeFile: (request: import('../../lib/pr-changes').PrFileRequest) => {
    if (new URLSearchParams(location.search).has('markdown-review')) return Promise.resolve({ before: request.path.endsWith('/new.md') ? { kind: 'absent' as const } : { kind: 'text' as const, content: markdownBefore }, after: request.path.endsWith('/removed.md') ? { kind: 'absent' as const } : { kind: 'text' as const, content: markdownAfter } });
    if(request.path.endsWith('.svg')) {const image={kind:'image' as const,dataUrl:'data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="140"><rect width="300" height="140" fill="#5076b8"/><text x="30" y="75" fill="white">Queue flow</text></svg>')};return Promise.resolve({before:image,after:image});}
    const before=Array.from({length:90},(_,i)=>`const value${i} = ${i};`).join('\n');
    return Promise.resolve({before:request.path.endsWith('/new.ts')?{kind:'absent' as const}:{kind:'text' as const,content:before},after:request.path.endsWith('/old.ts')?{kind:'absent' as const}:{kind:'text' as const,content:before.replace('value35 = 35','value35 = 36')}});
  },
  checkPrChanges: (url:string) => {const member=items.flatMap(i=>i.subject.members).find(m=>m.url===url)??members[0];return Promise.resolve({headSha:member.headSha,baseSha:member.baseSha});},
  onFileChatProgress: () => () => {},
  askPrFile: () => Promise.resolve('The worker now advances to the next queued item. This changes the retry boundary.'),
  getGitHubProfile: (login:string) => Promise.resolve({login,name:'Morgan Developer',bio:'Building reliable command queues.',company:'Klang',location:'Berlin',type:'User'}),
  getQueueSignals: (requests: import('../../lib/queue-signals').QueueSignalRequest[]): Promise<import('../../lib/queue-signals').QueueSignals[]> => Promise.resolve(requests.map((request, i) => ({ ...request, checkedAt: Date.now(), readiness: {state:'OPEN',isDraft:false,mergeable:'MERGEABLE',mergeState:'CLEAN',reviewDecision:'APPROVED',baseBranch:items.flatMap(i=>i.subject.members).find(m=>m.url===request.url)?.baseBranch ?? 'main',baseSha:'base',behindBy:0,mergeQueue:false,queueState:null}, comments: i % 2 ? 0 : 4, checks: { state: 'success' as const, passed: 129, skipped: 1, total: 130 } }))),
  commandSearch: async (query:string, includeBots=false, recentIds:string[]=[]) => {
    const queue=await mocks.workbenchQueue();
    const docs=[...queueDocuments(queue),...reviewDocuments(review,history[0],queue)];
    docs.push(...threadDocuments(review.prUrl,await mocks.getReviewThreads(),docs));
    const hits=query?searchDocuments(docs,query,includeBots):docs.filter(d=>['pr','stack','view','repository'].includes(d.kind)||recentIds.includes(d.id)).sort((a,b)=>(recentIds.indexOf(a.id)<0?999:recentIds.indexOf(a.id))-(recentIds.indexOf(b.id)<0?999:recentIds.indexOf(b.id))).map(document=>searchHit(document));
    return {account:'oddur',hits,total:hits.length,ignoreBots:true,warnings:[]};
  },
  commandGitHubSearch: () => Promise.resolve([{number:999,title:'Remote queue improvement',url:'https://github.com/klang/engine/pull/999',repoOwner:'klang',repoName:'engine',author:'sam',updatedAt:date,isDraft:false,role:'watched' as const}]),
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
  searchRepos: (query: string) => Promise.resolve([{ fullName: 'klang/engine', description: 'Game engine' }, { fullName: 'klang/tools', description: 'Developer tools' }].filter(repo => repo.fullName.includes(query))),
  getAuthState: () =>
    Promise.resolve({ authenticated: fixtureAuthenticated, login: fixtureAuthenticated ? 'oddur' : null }),
  githubAuthOptions: () => Promise.resolve({ web: onboardingScenario }),
  beginGitHubSignIn: () => Promise.resolve({ id: 'fixture-auth', userCode: 'TEST-CODE', verificationUri: 'https://github.com/login/device', expiresAt: Date.now()+900000 }),
  completeGitHubSignIn: () => { fixtureAuthenticated = true; return Promise.resolve('oddur'); },
  cancelGitHubSignIn: () => Promise.resolve(),
  cancelOAuth: () => Promise.resolve(),
  signOut: () => { fixtureAuthenticated = false; return Promise.resolve(); },
  startOAuth: () => {
    fixtureAuthenticated = true;
    sessionStorage.setItem('ftue-auth', 'true');
    return Promise.resolve();
  },
  startReview: () => {
    fixtureStarted = true;
    return Promise.resolve({ reviewId: 'workbench-review', prUrl: review.prUrl, prTitle: review.prTitle, author: review.author });
  },
  getPrMetadata: (url: string) => Promise.resolve(items.flatMap((item) => item.subject.members).find((member) => member.url === url) ?? { ...members[0], url, title: 'A PR outside the queue' }),
  loadOnboarding: () => Promise.resolve(JSON.parse(sessionStorage.getItem('fixture-onboarding') ?? '{}') as OnboardingState),
  saveOnboarding: (state: OnboardingState) => { sessionStorage.setItem('fixture-onboarding', JSON.stringify(state)); return Promise.resolve(); },
  applyOnboarding: (draft: SetupDraft) => {
    if (new URLSearchParams(location.search).has('ftue-fail') && !sessionStorage.getItem('ftue-retry')) return Promise.reject(new Error('Disk full. Try again.'));
    const views = setupViews(draft);
    if (!draft.local) { savedViews = applyViewAction(savedViews, { type: 'setup', views, activeId: `setup:${draft.start}` }, () => 'unused'); saveViews(); }
    prefs = setupPreferences(prefs, draft);
    sessionStorage.setItem('fixture-first-run-seen', 'true');
    sessionStorage.setItem('fixture-guest-mode', String(draft.local));
    sessionStorage.setItem('fixture-onboarding', JSON.stringify({ draft, completed: true, paused: false }));
    return Promise.resolve(prefs);
  },
  loadHarnessEnvironment: async () => ({ claude: [], codex: [] }),
  saveHarnessEnvironment: async () => {},
  onPreferencesChanged: () => () => {},
  onWorkbenchChanged: () => () => {},
  getLocalClones: async () => [],
  connectLocalClone: () => Promise.resolve([]),
  disconnectLocalClone: () => Promise.resolve([]),
  loadPreferences: () => Promise.resolve(prefs),
  savePreferences: (next: Preferences) => {
    prefs = next;
    if (next.diffHighlighter) sessionStorage.setItem('fixture-diff-highlighter', next.diffHighlighter);
    sessionStorage.setItem('fixture-inactivity-days', JSON.stringify(next.prInactivityDays ?? 30));
    if (onboardingScenario) {
      sessionStorage.setItem('fixture-first-run-seen', String(next.firstRunSeen));
      sessionStorage.setItem('fixture-guest-mode', String(next.guestMode));
    }
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
  workbenchSnapshot: () => mocks.workbenchQueue(),
  workbenchRenameStack: async (id: string, name: string) => {
    const queue = await mocks.workbenchQueue();
    const item = queue.items.find(i => i.subject.id === id);
    if (!item) throw Error('Stack unavailable');
    item.subject.name = name.trim() || undefined;
    item.subject.title = item.subject.name ?? item.subject.members[0].title;
    return queue;
  },
  onPrReadStateChanged: (callback: () => void) => {
    window.addEventListener('fixture-pr-read-change', callback);
    return () => window.removeEventListener('fixture-pr-read-change', callback);
  },
  workbenchMarkPrRead: (request: MarkPrReadRequest) => {
    for (const receipt of request.receipts) {
      const current = fixtureReads[receipt.url];
      if (!current) continue;
      if (!request.read) { current.versions.manual++; current.unread = [...new Set([...current.unread, 'manual' as const])]; }
      else current.unread = current.unread.filter(reason => current.versions[reason] > receipt.versions[reason] || ((reason === 'commits' || reason === 'new') && current.headSha !== receipt.headSha));
    }
    sessionStorage.setItem('fixture-read-state', JSON.stringify(fixtureReads));
    updateFixtureUnread();
    return mocks.workbenchQueue();
  },
  workbenchMutePrs: (request: import('../../lib/muted-prs').MutePrRequest) => {
    const entries = new Map(fixtureMutes.map(entry => [entry.member.url, entry]));
    for (const member of request.members) {
      if (request.muted) entries.set(member.url, { member, mutedAt: new Date().toISOString() });
      else entries.delete(member.url);
    }
    fixtureMutes = [...entries.values()]; sessionStorage.setItem('fixture-mutes', JSON.stringify(fixtureMutes));
    return mocks.workbenchQueue();
  },
  workbenchStarPrs: (request: import('../../lib/starred-prs').StarPrRequest) => {
    const entries = new Map(fixtureStars.map(entry => [entry.member.url, entry]));
    for (const member of request.members) {
      if (request.starred) entries.set(member.url, {member, starredAt:new Date().toISOString()});
      else entries.delete(member.url);
    }
    fixtureStars=[...entries.values()];sessionStorage.setItem('fixture-stars',JSON.stringify(fixtureStars));
    for (const item of items) { item.starredUrls=item.subject.members.filter(m=>entries.has(m.url)).map(m=>m.url);item.starred=!!item.starredUrls.length; }
    return mocks.workbenchQueue();
  },
  workbenchQueue: () =>
    Promise.resolve({
      readStates: unreadScenario ? structuredClone(fixtureReads) : undefined,
      mutedPrs: fixtureMutes,
      starredPrs: fixtureStars.filter(entry => !fixtureMutedUrls().has(entry.member.url)),
      starredItems: visibleFixtureItems().filter(item=>item.starred),
      filters: queueFilters,
      savedViews: { ...savedViews, counts: Object.fromEntries(savedViews.views.map(view => [view.id, items.filter(item => matchesQueueFilters(item, view.filters, Date.now(), 'oddur')).length])) },
      items: onboardingScenario && !fixtureStarted && !JSON.parse(sessionStorage.getItem('fixture-onboarding') ?? '{}').completed ? [] : visibleFixtureItems(),
      warnings: [],
      remaining: polishScenario ? 0 : 7,
    }),
  onHistoryNavigate: (callback: (direction: -1 | 1) => void) => {
    const handler = (event: Event) => callback((event as CustomEvent<-1 | 1>).detail);
    window.addEventListener('fixture-history-navigate', handler);
    return () => window.removeEventListener('fixture-history-navigate', handler);
  },
  listReviews: () => Promise.resolve(onboardingScenario && !fixtureStarted ? [] : [
    ...history.filter(entry => !isMutedReview(entry, fixtureMutedUrls())),
    ...(new URLSearchParams(location.search).has('navigation-history') ? [{ ...history[0], id: 'local-history-review', prUrl: 'local:/fixture/repo', prTitle: 'Local history fixture', snapshot: undefined }] : []),
  ]),
  loadReview: (id: string) => Promise.resolve(id === 'local-history-review' ? { ...review, reviewId: id, prUrl: 'local:/fixture/repo', prTitle: 'Local history fixture', snapshot: undefined } : review),
  reRenderHunks: (r: ReviewGuide) => Promise.resolve(r),
  getReviewThreads: () => Promise.resolve({ headSha: 'fixture-head', baseSha: 'fixture-base', threads: [] }),
  getPrStatus: async (url: string) =>
    statusFailures-- > 0
      ? Promise.reject(new Error('API rate limit exceeded. Request ID fixture-request. Retry after the limit resets.'))
      : Promise.resolve({
          signals: (await mocks.getQueueSignals([{url, headSha: items.flatMap(i=>i.subject.members).find(m=>m.url===url)?.headSha ?? ''}]))[0],
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
  checkCliInstalled: (provider: 'claude' | 'codex' = 'claude', refresh = false) => {
    const cached = detectedTools.get(provider);
    if (onboardingScenario && cached && !refresh) return Promise.resolve(cached);
    const tools = JSON.parse(sessionStorage.getItem('ftue-tools') ?? '{}') as Record<string, string>;
    if (tools[provider] === 'error') return Promise.reject(new Error('Could not inspect tool'));
    const installed = tools[provider] === 'found' || !onboardingScenario;
    const result = { installed, resolvedPath: installed ? `/fixture/${provider}` : null };
    detectedTools.set(provider, result);
    return Promise.resolve(result);
  },
  platform: 'darwin',
  isPackaged: false,
};
for (const item of items) { item.starredUrls=item.subject.members.filter(m=>fixtureStars.some(e=>e.member.url===m.url)).map(m=>m.url);item.starred=!!item.starredUrls.length; }
if (new URLSearchParams(location.search).has('threads')) Object.assign(mocks, threadMocks());
if (new URLSearchParams(location.search).has('images')) Object.assign(mocks, imageMocks(review));
if (new URLSearchParams(location.search).has('shell-startup-failure')) {
  const load = mocks.loadPreferences;
  mocks.loadPreferences = () => sessionStorage.getItem('fixture-startup-recovered')
    ? load() : Promise.reject(new Error('Settings temporarily unavailable.'));
  const read = Storage.prototype.getItem, write = Storage.prototype.setItem;
  Storage.prototype.getItem = function(key) {
    if (key === 'gnosis-queue-selection') throw new Error('Storage unavailable');
    return read.call(this, key);
  };
  Storage.prototype.setItem = function(key, value) {
    if (key === 'gnosis-queue-selection') throw new Error('Storage full');
    return write.call(this, key, value);
  };
}
if (new URLSearchParams(location.search).has('checks')) {
  Object.assign(mocks, checksMocks());
  const readSignals = mocks.getQueueSignals;
  mocks.getQueueSignals = async requests => (await readSignals(requests)).map(value => ({ ...value,
    checks: { state: 'failure', passed: 1, skipped: 1, failed: 3, running: 1, total: 6 },
    readiness: value.readiness ? { ...value.readiness, mergeState: 'BLOCKED' } : undefined,
  }));
}
if (new URLSearchParams(location.search).has('github-sync')) {
  const { installSyncFixture } = await import('./github-sync');
  installSyncFixture(mocks, items);
}
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
const { initializeDiffHighlighter } = await import('../../lib/diff-highlighter');
initializeDiffHighlighter(prefs);
const { App } = await import('../../src/App');
const root = document.getElementById('root');
if (root) {
  if (new URLSearchParams(location.search).has('hardening')) {
    const { HardeningFixture } = await import('./hardening');
    createRoot(root).render(<HardeningFixture />);
  } else createRoot(root).render(<App />);
}

function visibleFixtureItems() {
  return items.flatMap(item => {
    if (polishScenario && item.briefing?.status === 'paused') {
      item = { ...item, briefing: { ...item.briefing, pauseDetail: automaticBriefingBlock(item.subject, prefs, prefs.briefingDailyLimit ?? 10, {}) } };
    }
    const subject = withoutMutedMembers(item.subject, fixtureMutedUrls());
    if (!subject || !matchesPrInactivity(subject, normalizePrInactivityDays(prefs.prInactivityDays), Date.now(), new Set(fixtureStars.map(entry => entry.member.url)))) return [];
    if (subject === item.subject) return [item];
    return [{ ...item, subject, briefing: undefined, review: item.review && !isMutedReview(item.review, fixtureMutedUrls()) ? item.review : undefined, starred: subject.members.some(m => fixtureStars.some(e => e.member.url === m.url)) }];
  });
}
