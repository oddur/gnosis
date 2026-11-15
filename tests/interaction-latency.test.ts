import test from 'node:test';
import assert from 'node:assert/strict';
import { RingBuffer, attributeFrames, attributeInputDelay, slowestInteractions, splitDuration, type SlowInteraction } from '../lib/interaction-latency';
import { diagnosticsSections, sanitizeRendererDiagnostics } from '../lib/diagnostics';

void test('the ring buffer keeps the newest entries, oldest first', () => {
  const buffer = new RingBuffer<number>(3);
  for (let i = 1; i <= 5; i++) buffer.push(i);
  assert.deepEqual(buffer.toArray(), [3, 4, 5]);
  assert.equal(buffer.size, 3);
  buffer.clear();
  buffer.push(9);
  assert.deepEqual(buffer.toArray(), [9]);
});

void test('an event splits into input delay, handlers and presentation', () => {
  assert.deepEqual(splitDuration({ startTime: 100, processingStart: 112, processingEnd: 190, duration: 136 }), {
    duration: 136,
    inputDelay: 12,
    processing: 78,
    presentation: 46,
  });
  // Event Timing rounds duration to 8 ms; the presentation share never goes negative.
  assert.equal(splitDuration({ startTime: 0, processingStart: 2, processingEnd: 105, duration: 104 }).presentation, 0);
});

void test('long animation frames that overlap an interaction name its slowest scripts', () => {
  const frames = [
    { startTime: 0, duration: 50, scripts: [{ duration: 40, invoker: 'unrelated', sourceURL: '', sourceFunctionName: 'before' }] },
    {
      startTime: 90,
      duration: 160,
      blockingDuration: 110,
      renderStart: 220,
      styleAndLayoutStart: 230,
      scripts: [
        { duration: 30, invoker: 'DIV#root.onclick', invokerType: 'event-listener', sourceURL: 'http://localhost/lib/a.ts?t=1', sourceFunctionName: 'small' },
        { duration: 95, invoker: 'DIV#root.onmousedown', invokerType: 'event-listener', sourceURL: 'http://localhost/components/Big.tsx', sourceFunctionName: 'render', forcedStyleAndLayoutDuration: 12.4 },
      ],
    },
  ];
  const result = attributeFrames(frames, 100, 240);
  assert.ok(result);
  assert.deepEqual(result.frames, { count: 1, blocking: 110, script: 125, styleAndLayout: 20, render: 30 });
  assert.deepEqual(result.scripts[0], {
    invokerType: 'event-listener',
    invoker: 'DIV#root.onmousedown',
    source: 'Big.tsx render',
    sourceURL: 'components/Big.tsx',
    sourceFunctionName: 'render',
    duration: 95,
    forcedLayout: 12,
  });
  assert.equal(attributeFrames(frames, 400, 500), undefined);
});

void test('input delay names the work that was already running when the input arrived', () => {
  // A 400 ms store flush started at 1,000; the click arrived at 1,300 and its handlers ran at 1,400.
  const frames = [
    {
      startTime: 1000,
      duration: 420,
      blockingDuration: 370,
      scripts: [
        { startTime: 1000, duration: 395, invoker: 'TimerHandler:setTimeout', invokerType: 'user-callback', sourceURL: 'app://gnosis/assets/index-abc.js?v=1', sourceFunctionName: 'flush', sourceCharPosition: 6040 },
        // The click's own handler started after the delay; it belongs to the interaction, not the delay.
        { startTime: 1401, duration: 12, invoker: 'DIV#root.onclick', invokerType: 'event-listener', sourceURL: 'app://gnosis/assets/index-abc.js', sourceFunctionName: 'dispatchDiscreteEvent' },
      ],
    },
  ];
  const delay = attributeInputDelay(frames, [], 1300, 1400);
  assert.ok(delay);
  assert.equal(delay.startedBefore, 300);
  assert.equal(delay.blocking, 370);
  assert.equal(delay.scripts.length, 1);
  assert.deepEqual(delay.scripts[0], {
    invokerType: 'user-callback',
    invoker: 'TimerHandler:setTimeout',
    source: 'index-abc.js flush',
    sourceURL: 'assets/index-abc.js',
    sourceFunctionName: 'flush',
    sourceCharPosition: 6040,
    start: -300,
    duration: 395,
    forcedLayout: 0,
  });
  // Work the browser reports only as a long task, such as an IPC message or garbage collection, still counts.
  const tasks = attributeInputDelay([], [{ startTime: 1200, duration: 250 }], 1300, 1400);
  assert.deepEqual(tasks, { frames: 0, longTasks: 1, startedBefore: 100, blocking: 200, scripts: [] });
  assert.equal(attributeInputDelay(frames, [], 1300, 1310), undefined, 'Short delays are not attributed');
  assert.equal(attributeInputDelay(frames, [], 2000, 2100), undefined, 'Nothing overlapped the delay');
});

const interaction = (duration: number, extra: Partial<SlowInteraction> = {}): SlowInteraction => ({
  at: 1,
  type: 'click',
  target: 'button.queue-row-main',
  duration,
  inputDelay: 1,
  processing: duration - 10,
  presentation: 9,
  scripts: [],
  ...extra,
});

void test('the slowest interactions sort first', () => {
  assert.deepEqual(
    slowestInteractions([interaction(120), interaction(300), interaction(180)], 2).map((e) => e.duration),
    [300, 180]
  );
});

void test('a diagnostics report keeps only known fields from the renderer', () => {
  const renderer = sanitizeRendererDiagnostics({
    interactions: [
      { ...interaction(240, { key: 'j' }), secret: 'PR title', scripts: [{ source: 'x.ts f', duration: 200, invoker: 'i', invokerType: 't', forcedLayout: 0, extra: 1 }] },
      { type: 42, duration: 'slow' },
    ],
    monitor: { supported: true, frameTiming: true, threshold: 100 },
    window: { width: 1280, height: 800, devicePixelRatio: 2 },
  });
  assert.equal(renderer.interactions.length, 2);
  assert.equal('secret' in renderer.interactions[0], false);
  assert.equal(renderer.interactions[0].key, 'j');
  assert.deepEqual(Object.keys(renderer.interactions[0].scripts[0]).sort(), ['duration', 'forcedLayout', 'invoker', 'invokerType', 'source']);
  assert.equal(renderer.interactions[1].type, '');
  assert.equal(renderer.interactions[1].duration, 0);
  const sections = diagnosticsSections(renderer, {
    system: { platform: 'darwin', arch: 'arm64', release: '25', cpus: 10, memoryBytes: 1, packaged: false },
    versions: { electron: '41' },
    startup: {},
  });
  assert.equal(sections.system.platform, 'darwin');
  assert.deepEqual(sections.renderer.slowest.map((e) => e.duration), [240, 0]);
  assert.equal(sanitizeRendererDiagnostics(null).interactions.length, 0);
});

void test('a diagnostics report keeps what an input waited behind, long frames and the window startup', () => {
  const script = { source: 'index.js flush', sourceURL: 'assets/index.js', sourceFunctionName: 'flush', sourceCharPosition: 6040, start: -300, duration: 395, invoker: 'TimerHandler:setTimeout', invokerType: 'user-callback', forcedLayout: 0, extra: 1 };
  const renderer = sanitizeRendererDiagnostics({
    interactions: [{ ...interaction(1344), delay: { frames: 1, longTasks: 1, startedBefore: 300, blocking: 370, scripts: [script], secret: 'x' } }],
    longFrames: [{ at: 5, duration: 420, blocking: 370, scripts: [script], title: 'PR title' }],
    startup: { openForMs: 90_000, 'first-contentful-paint': 410 },
    caches: { domNodes: 5000, inspection: { files: { entries: 12, bytes: 3_000_000 } }, title: 'PR title' },
  });
  assert.deepEqual(renderer.caches, { domNodes: 5000, inspection: { files: { entries: 12, bytes: 3_000_000 } } }, 'Cache sizes keep numbers only');
  const delay = renderer.interactions[0].delay;
  assert.ok(delay);
  assert.equal('secret' in delay, false);
  assert.deepEqual(delay.scripts[0], {
    source: 'index.js flush', sourceURL: 'assets/index.js', sourceFunctionName: 'flush', sourceCharPosition: 6040, start: -300,
    duration: 395, invoker: 'TimerHandler:setTimeout', invokerType: 'user-callback', forcedLayout: 0,
  });
  assert.deepEqual(renderer.longFrames?.map((f) => [f.duration, f.blocking, f.scripts[0].sourceFunctionName, 'title' in f]), [[420, 370, 'flush', false]]);
  assert.deepEqual(renderer.startup, { openForMs: 90_000, 'first-contentful-paint': 410 });
});
