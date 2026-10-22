import { createRoot } from 'react-dom/client';
import '../../src/globals.css';
import { groupSubjects, snapshot, memberPrefix, type ReviewMember, type QueueItem } from '../../lib/workbench';
import type { Preferences, ReviewGuide, ReviewHistoryEntry } from '../../lib/types';
import { DEFAULT_CLAUDE_MODEL, DEFAULT_FAST_CLAUDE_MODEL } from '../../lib/models';
import { review as example, slide, explainer } from './explainer';
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
  firstRunSeen: true,
  theme: 'light',
  trayEnabled: false,
  maxPrsPerRepo: 10,
  parallelReview: true,
  analytics: false,
  proactiveReviewOverrides: false,
  proactiveProvider: 'claude',
  proactiveModel: DEFAULT_FAST_CLAUDE_MODEL,
  proactiveThinking: false,
  educationMode: true,
  claudeContext: false,
  guestMode: false,
};
const mocks = {
  getAuthState: () => Promise.resolve({ authenticated: true, login: 'oddur' }),
  loadPreferences: () => Promise.resolve(prefs),
  savePreferences: (next: Preferences) => {
    prefs = next;
    return Promise.resolve();
  },
  workbenchQueue: () => Promise.resolve({ items, warnings: [], remaining: 7 }),
  listReviews: () => Promise.resolve(history),
  loadReview: () => Promise.resolve(review),
  reRenderHunks: (r: ReviewGuide) => Promise.resolve(r),
  getPrStatus: () =>
    Promise.resolve({
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
  workbenchFreshness: () => Promise.resolve({ status: 'current' }),
  getPendingUpdateReady: () => Promise.resolve(null),
  generateExplainer: () => Promise.resolve(explainer),
  checkCliInstalled: () => Promise.resolve({ installed: true, resolvedPath: '/fixture/claude' }),
  platform: 'darwin',
  isPackaged: false,
};
Object.defineProperty(window, 'electronAPI', {
  value: new Proxy(mocks, {
    get: (target, key) => (key in target ? target[key as keyof typeof target] : () => Promise.resolve()),
  }),
});
localStorage.clear();
const { renderDiffHunk } = await import('../../lib/highlight');
for (const topic of review.slides) for (const hunk of topic.diffHunks) hunk.renderedHtml=await renderDiffHunk(hunk.content,hunk.language,'github-dark',hunk.hunkHeader);
const { App } = await import('../../src/App');
const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
