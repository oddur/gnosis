import { Session } from 'node:inspector';
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';

/**
 * Main-process event-loop blocking (#345). Input reaches a window through the main process, so a busy main process
 * shows in the renderer as input delay with no renderer work to blame: the user's second export had 1.9-2.3 s delays
 * with an idle renderer. This module measures the main event loop two ways and names what ran:
 *
 * - a lag detector: a 25 ms interval that records every gap of 50 ms or more as a long task;
 * - Node's event-loop delay histogram, for the distribution;
 * - spans of known work (IPC handlers by channel, their replies, sends to windows by channel, and wrapped operations),
 *   kept when they take 10 ms or more, so each long task lists the spans inside it;
 * - a sparse CPU sampler, so a long task that no span names still lists the functions that ran.
 *
 * Sleep is not blocking: while the system is suspended or the screen is locked neither the detector nor the histogram
 * records, and the first turn after waking is skipped.
 *
 * Everything stays in memory in bounded buffers and goes into the diagnostics export.
 */
export interface MainSpan {
  name: string;
  /** Epoch milliseconds. */
  start: number;
  end: number;
}
export interface MainLongTask {
  /** Epoch milliseconds when the loop stopped turning, as far as the detector can tell. */
  at: number;
  duration: number;
  /** Spans inside the long task, longest first. */
  spans: { name: string; duration: number }[];
  /**
   * All named work in the task, including pieces under 10 ms, summed by name: many small cache parses or
   * garbage-collection pauses add up to a long task no single span explains.
   */
  work?: { name: string; ms: number; count: number }[];
  /** The startup phase the task ran in: the last startup mark before it, and how long after it. */
  phase?: { after: string; ms: number };
  /**
   * CPU samples inside a task of 100 ms or more, by function, most first: `self` ran in the function itself, `total`
   * includes what it called. Names come from the running build; packaged builds are minified, so the location
   * (`file:line:column`) maps them back with the release's source map. Present when the sampler runs.
   */
  profile?: { samples: number; self: { name: string; ms: number }[]; total: { name: string; ms: number }[] };
}
export interface MainLoopReport {
  /** Since `samplesFor` ms ago: the histogram starts again after each sleep or screen lock (`sleeps`). */
  eventLoopDelay: { mean: number; p50: number; p90: number; p99: number; max: number; samplesFor: number; sleeps?: number };
  longTasks: MainLongTask[];
}

const SPAN_MIN_MS = 10;
const SPAN_KEEP_MS = 120_000;
const MAX_SPANS = 500;
const LAG_INTERVAL_MS = 25;
const LONG_TASK_MS = 50;
const MAX_LONG_TASKS = 200;
/** A gap this long with no suspend event is the machine sleeping or the app napping, not work. */
const SLEEP_GAP_MS = 60_000;
/** The sampler's interval, and the shortest task it describes. 5 ms keeps its cost negligible. */
const SAMPLE_INTERVAL_US = 5_000;
const PROFILE_TASK_MS = 100;
/** The sampler starts a new profile this often, so its buffer stays small and tasks are described soon after. */
const PROFILE_WINDOW_MS = 30_000;

let spans: MainSpan[] = [];
/** Named work since the lag detector last ran, summed by name. */
let totals = new Map<string, { ms: number; count: number }>();
let lastMark: { name: string; at: number } | undefined;
/** Startup marks (src/startup-trace.ts) name the phase a long task ran in, also when tracing is off. */
export function noteMainPhase(name: string) {
  lastMark = { name, at: epoch() };
}
let longTasks: MainLongTask[] = [];
let histogram: ReturnType<typeof monitorEventLoopDelay> | undefined;
let histogramSince = 0;
const epoch = () => performance.timeOrigin + performance.now();

export function recordMainSpan(name: string, start: number, end = epoch()) {
  const total = totals.get(name) ?? { ms: 0, count: 0 };
  total.ms += end - start;
  total.count++;
  totals.set(name, total);
  if (end - start < SPAN_MIN_MS) return;
  spans.push({ name, start, end });
  if (spans.length > MAX_SPANS || spans[0].end < end - SPAN_KEEP_MS) spans = spans.filter((s) => s.end >= end - SPAN_KEEP_MS).slice(-MAX_SPANS);
}

/** Runs `work` and records its synchronous part under `name`. A returned promise's later work is not included. */
export function mainSpan<T>(name: string, work: () => T): T {
  const start = epoch();
  try {
    return work();
  } finally {
    recordMainSpan(name, start);
  }
}

function spansIn(start: number, end: number) {
  return spans
    .filter((s) => s.start < end && s.end > start)
    .map((s) => ({ name: s.name, duration: Math.round(s.end - s.start) }))
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 8);
}

// ── Sleep ──
/** Why measuring is paused: `suspend` and `lock-screen` until their matching event. */
const pausedFor = new Set<string>();
let sleeps = 0;
/** The detector's previous turn, and the wall clock then: a wall clock that ran ahead means the machine slept. */
let lastTurn = 0;
let lastWall = 0;
/** Starts the histogram again, so a sleep is never its maximum. */
function restartHistogram() {
  sleeps++;
  histogram?.disable();
  // A disabled histogram that is enabled again records the whole gap since its last sample; a reset forgets it.
  histogram?.reset();
  if (!pausedFor.size) histogram?.enable();
  histogramSince = Date.now();
}
/**
 * The system is going to sleep or the screen locked (`reason`). Nothing is measured until `noteSystemWake` with the
 * same reason: a suspended process does not turn its event loop, and a locked Mac can defer timers for seconds.
 */
export function noteSystemSleep(reason = 'suspend') {
  if (pausedFor.has(reason)) return;
  pausedFor.add(reason);
  histogram?.disable();
}
export function noteSystemWake(reason = 'suspend') {
  if (!pausedFor.delete(reason) || pausedFor.size) return;
  restartHistogram();
  // The detector's first turn after waking measures the sleep. Start it from now.
  lastTurn = performance.now();
  lastWall = Date.now();
  totals = new Map();
}
/** Follows Electron's `powerMonitor`: suspend and resume, and the screen lock where the platform reports it. */
export function watchSystemSleep(power: { on(event: string, listener: () => void): unknown }) {
  power.on('suspend', () => noteSystemSleep('suspend'));
  power.on('resume', () => noteSystemWake('suspend'));
  power.on('lock-screen', () => noteSystemSleep('lock-screen'));
  power.on('unlock-screen', () => noteSystemWake('lock-screen'));
}

// ── Sampler ──
type Profile = { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number }; children?: number[] }[]; startTime: number; endTime: number; samples?: number[]; timeDeltas?: number[] };
let sampler: { session: Session; since: number } | undefined;
function frameName(frame: Profile['nodes'][number]['callFrame']) {
  const file = frame.url.split(/[\\/]/).at(-1);
  return `${frame.functionName || '(anonymous)'}${file ? ` ${file}:${frame.lineNumber + 1}:${frame.columnNumber + 1}` : ''}`;
}
const PLUMBING = new Set(['(root)', '(program)', '(idle)']);
/** Names what the samples inside each long task of 100 ms or more ran, by function. */
function describeTasks(profile: Profile, since: number, stoppedAt: number) {
  const tasks = longTasks.filter((task) => !task.profile && task.duration >= PROFILE_TASK_MS && task.at + task.duration >= since - LAG_INTERVAL_MS);
  if (!tasks.length || !profile.samples?.length || !profile.timeDeltas) return;
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  // Profile times are microseconds on V8's clock; its end is now.
  const offset = stoppedAt - profile.endTime / 1000;
  const times: number[] = [];
  let at = profile.startTime;
  for (const delta of profile.timeDeltas) times.push((at += delta) / 1000 + offset);
  for (const task of tasks) {
    const self = new Map<string, number>(), total = new Map<string, number>();
    let samples = 0;
    for (let i = 0; i < profile.samples.length; i++) {
      if (times[i] < task.at - LAG_INTERVAL_MS || times[i] > task.at + task.duration + LAG_INTERVAL_MS) continue;
      const leaf = nodes.get(profile.samples[i]);
      if (!leaf || PLUMBING.has(leaf.callFrame.functionName)) continue;
      // Each sample stands for the time until the next one.
      const ms = Math.min(50, ((times[i + 1] ?? times[i]) - times[i]) || SAMPLE_INTERVAL_US / 1000);
      samples++;
      const name = frameName(leaf.callFrame);
      self.set(name, (self.get(name) ?? 0) + ms);
      const seen = new Set<string>();
      for (let id: number | undefined = leaf.id; id !== undefined; id = parents.get(id)) {
        const node = nodes.get(id);
        if (!node || PLUMBING.has(node.callFrame.functionName)) continue;
        const frame = frameName(node.callFrame);
        if (seen.has(frame)) continue;
        seen.add(frame);
        total.set(frame, (total.get(frame) ?? 0) + ms);
      }
    }
    const top = (values: Map<string, number>) =>
      [...values].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, ms]) => ({ name, ms: Math.round(ms) }));
    if (samples) task.profile = { samples, self: top(self), total: top(total) };
  }
}
/** Ends the current sample window, describes its long tasks, and starts the next. */
function rotateSampler() {
  const current = sampler;
  if (!current) return;
  try {
    let profile: Profile | undefined;
    current.session.post('Profiler.stop', (error, result) => {
      if (!error) profile = (result as { profile: Profile }).profile;
    });
    if (profile) describeTasks(profile, current.since, epoch());
    current.session.post('Profiler.start');
    current.since = epoch();
  } catch {
    stopSampler();
  }
}
function startSampler() {
  try {
    const session = new Session();
    session.connect();
    session.post('Profiler.enable');
    session.post('Profiler.setSamplingInterval', { interval: SAMPLE_INTERVAL_US });
    session.post('Profiler.start');
    sampler = { session, since: epoch() };
  } catch {
    sampler = undefined;
  }
}
function stopSampler() {
  const current = sampler;
  sampler = undefined;
  try {
    current?.session.post('Profiler.stop');
    current?.session.disconnect();
  } catch {
    /* Already stopped. */
  }
}

/**
 * Starts the detector and the histogram, and with `sampler` a CPU sampler every 5 ms that names the functions inside
 * long tasks no span explains. Returns a function that stops them.
 */
export function startMainLoopMonitor(options: { sampler?: boolean } = {}): () => void {
  histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  histogramSince = Date.now();
  sleeps = 0;
  pausedFor.clear();
  lastTurn = performance.now();
  lastWall = Date.now();
  if (options.sampler) startSampler();
  const rotation = options.sampler ? setInterval(rotateSampler, PROFILE_WINDOW_MS) : undefined;
  rotation?.unref();
  const timer = setInterval(() => {
    const now = performance.now();
    const wall = Date.now();
    const lag = now - lastTurn - LAG_INTERVAL_MS;
    // The wall clock runs on while the machine sleeps; the monotonic clock may not. Either gap is sleep, not work.
    const slept = wall - lastWall - (now - lastTurn) > 5_000 || lag >= SLEEP_GAP_MS;
    if (pausedFor.size) {
      // Asleep or locked: nothing to record.
    } else if (slept) {
      restartHistogram();
    } else if (lag >= LONG_TASK_MS) {
      const end = performance.timeOrigin + now;
      const start = end - lag;
      const work = [...totals]
        .filter(([, t]) => t.ms >= 1)
        .sort((a, b) => b[1].ms - a[1].ms)
        .slice(0, 8)
        .map(([name, t]) => ({ name, ms: Math.round(t.ms), count: t.count }));
      longTasks.push({
        at: Math.round(start),
        duration: Math.round(lag),
        spans: spansIn(start, end),
        ...(work.length ? { work } : {}),
        ...(lastMark ? { phase: { after: lastMark.name, ms: Math.round(start - lastMark.at) } } : {}),
      });
      if (longTasks.length > MAX_LONG_TASKS) longTasks = longTasks.slice(-MAX_LONG_TASKS);
    }
    totals = new Map();
    lastTurn = now;
    lastWall = wall;
  }, LAG_INTERVAL_MS);
  timer.unref();
  // Garbage-collection pauses, by kind, as named work: a large heap pauses main with no script to blame.
  let gc: PerformanceObserver | undefined;
  try {
    gc = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const kind = (entry as { detail?: { kind?: number } }).detail?.kind;
        const name = kind === 1 ? 'gc minor' : kind === 2 ? 'gc major' : kind === 4 ? 'gc incremental' : kind === 8 ? 'gc weak' : 'gc';
        recordMainSpan(name, performance.timeOrigin + entry.startTime, performance.timeOrigin + entry.startTime + entry.duration);
      }
    });
    gc.observe({ entryTypes: ['gc'] });
  } catch {
    gc = undefined;
  }
  return () => {
    clearInterval(timer);
    if (rotation) clearInterval(rotation);
    stopSampler();
    gc?.disconnect();
    histogram?.disable();
  };
}

export function mainLoopReport(): MainLoopReport {
  // Describe the tasks of the current sample window too.
  rotateSampler();
  const ms = (ns: number) => Math.round(ns / 1e5) / 10;
  const h = histogram;
  return {
    eventLoopDelay: h
      ? {
          mean: ms(h.mean), p50: ms(h.percentile(50)), p90: ms(h.percentile(90)), p99: ms(h.percentile(99)), max: ms(h.max),
          samplesFor: Date.now() - histogramSince,
          ...(sleeps ? { sleeps } : {}),
        }
      : { mean: 0, p50: 0, p90: 0, p99: 0, max: 0, samplesFor: 0 },
    longTasks: [...longTasks],
  };
}

/** Clears the long tasks and the histogram, so a measurement starts fresh. */
export function resetMainLoopReport() {
  longTasks = [];
  histogram?.reset();
  histogramSince = Date.now();
}

/**
 * Electron serializes a handler's result after the handler returns, and an async handler's when its promise settles:
 * a large result costs main time outside the handler's span. Electron replies through the event's reply channel;
 * where it has one, the reply is named `ipc reply <channel>`.
 */
function nameReply(event: unknown, channel: string) {
  const reply = (event as { _replyChannel?: { sendReply?: (value: unknown) => void } } | undefined)?._replyChannel;
  const send = reply?.sendReply;
  if (!reply || typeof send !== 'function') return;
  try {
    reply.sendReply = (value: unknown) => mainSpan(`ipc reply ${channel}`, () => send.call(reply, value));
  } catch {
    /* A reply channel that cannot be wrapped replies unnamed. */
  }
}
interface HandlerRegistry {
  handle: (channel: string, listener: (...args: never[]) => unknown) => void;
  on: (channel: string, listener: (...args: never[]) => void) => unknown;
}
/**
 * Names IPC work: every `ipcMain.handle` and `ipcMain.on` listener registered after this records the synchronous
 * part of each call as `ipc <channel>`. Install before the first registration.
 */
export function instrumentIpc(registry: HandlerRegistry) {
  const handle = registry.handle.bind(registry);
  const on = registry.on.bind(registry);
  registry.handle = (channel, listener) =>
    handle(channel, ((...args: never[]) => {
      nameReply(args[0], channel);
      return mainSpan(`ipc ${channel}`, () => listener(...args));
    }) as typeof listener);
  registry.on = (channel, listener) =>
    on(channel, ((...args: never[]) => mainSpan(`ipc ${channel}`, () => listener(...args))) as typeof listener);
}

/** Names sends to a window: serializing a large payload for `webContents.send` runs on the main thread. */
export function instrumentSends(contents: { send: (channel: string, ...args: unknown[]) => void }) {
  const send = contents.send.bind(contents);
  contents.send = (channel: string, ...args: unknown[]) => mainSpan(`send ${channel}`, () => send(channel, ...args));
}

/**
 * Renderer interactions annotated with the main-process long tasks that overlap their input delay: the input waited
 * in the main process when the renderer itself was idle.
 */
export function correlateInteractions<T extends { at: number; inputDelay: number }>(
  interactions: readonly T[],
  tasks: readonly MainLongTask[]
): (T & { mainBlocked?: MainLongTask[] })[] {
  return interactions.map((interaction) => {
    if (interaction.inputDelay < 50) return interaction;
    const start = interaction.at;
    const end = interaction.at + interaction.inputDelay;
    // The detector stamps a task when the loop turns again, so allow its interval either side.
    const blocked = tasks.filter((t) => t.at < end + LAG_INTERVAL_MS && t.at + t.duration > start - LAG_INTERVAL_MS);
    return blocked.length ? { ...interaction, mainBlocked: blocked } : interaction;
  });
}
