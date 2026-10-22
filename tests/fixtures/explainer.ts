import type { InteractiveExplainer, ReviewGuide, Slide } from '../../lib/types';

export const explainer: InteractiveExplainer = {
  version: 1,
  title: 'A queue, one item at a time',
  description: 'Change the queue length and step through its work.',
  assumptions: ['Each item takes one modeled step. These timings are illustrative.'],
  sources: [{ filePath: 'queue.ts', explanation: 'The queue removes one item per step.' }],
  html: '<label>Queue length <input id="count" type="range" min="1" max="5" value="3"></label><svg viewBox="0 0 600 200" aria-label="Queue"><text id="state" x="30" y="100"></text></svg>',
  css: 'text { font-size: 24px; }',
  javascript: `let remaining = 3, elapsed = 0;
const count = document.getElementById('count');
const render = () => document.getElementById('state').textContent = remaining + ' items waiting';
const reset = () => { remaining = Number(count.value); elapsed = 0; render(); };
const step = () => { remaining = Math.max(0, remaining - 1); render(); };
count.addEventListener('input', reset);
window.explainer = { reset, step, tick(ms) { elapsed += ms; if (elapsed >= 500) { elapsed = 0; step(); } } };`,
};

export const slide: Slide = {
  id: 'slide-1',
  slideNumber: 1,
  title: 'Process the queue',
  slideType: 'feature',
  narrative: 'Each turn processes one item.',
  reviewFocus: null,
  contextSnippets: [],
  affectedFiles: ['queue.ts'],
  dependsOn: [],
  explainerIdea: {
    title: 'Watch the queue drain',
    description: 'Adjust the queue length to see each processing step.',
  },
  diffHunks: [
    {
      filePath: 'queue.ts',
      hunkHeader: '@@ -1,1 +1,1 @@',
      content: '-runAll();\n+queue.shift();',
      language: 'typescript',
      renderedHtml: '',
    },
  ],
};

export const review: ReviewGuide = {
  reviewId: 'review-1',
  prTitle: 'Process queued work',
  prDescription: 'One item each turn.',
  prUrl: 'https://github.com/oddur/gnosis/pull/1',
  author: 'test',
  summary: 'Queue work.',
  riskLevel: 'low',
  riskRationale: 'Small example.',
  totalFilesChanged: 1,
  totalLinesChanged: 2,
  headSha: 'head-1',
  slides: [slide],
};
