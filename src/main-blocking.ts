import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

/**
 * Main-process event-loop blocking (#345). Input reaches a window through the main process, so a busy main process
 * shows in the renderer as input delay with no renderer work to blame: the user's second export had 1.9-2.3 s delays
 * with an idle renderer. This module measures the main event loop two ways and names what ran:
 *
 * - a lag detector: a 25 ms interval that records every gap of 50 ms or more as a long task;
 * - Node's event-loop delay histogram, for the distribution;
 * - spans of known work (IPC handlers by channel, sends to windows by channel, and wrapped operations), kept when they
 *   take 10 ms or more, so each long task lists the spans inside it.
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
}
export interface MainLoopReport {
  eventLoopDelay: { mean: number; p50: number; p90: number; p99: number; max: number; samplesFor: number };
  longTasks: MainLongTask[];
}

const SPAN_MIN_MS = 10;
const SPAN_KEEP_MS = 120_000;
const MAX_SPANS = 500;
const LAG_INTERVAL_MS = 25;
const LONG_TASK_MS = 50;
const MAX_LONG_TASKS = 200;

let spans: MainSpan[] = [];
let longTasks: MainLongTask[] = [];
let histogram: ReturnType<typeof monitorEventLoopDelay> | undefined;
let histogramSince = 0;
const epoch = () => performance.timeOrigin + performance.now();

export function recordMainSpan(name: string, start: number, end = epoch()) {
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

/** Starts the detector and the histogram. Returns a function that stops both. */
export function startMainLoopMonitor(): () => void {
  histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  histogramSince = Date.now();
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const lag = now - last - LAG_INTERVAL_MS;
    if (lag >= LONG_TASK_MS) {
      const end = performance.timeOrigin + now;
      const start = end - lag;
      longTasks.push({ at: Math.round(start), duration: Math.round(lag), spans: spansIn(start, end) });
      if (longTasks.length > MAX_LONG_TASKS) longTasks = longTasks.slice(-MAX_LONG_TASKS);
    }
    last = now;
  }, LAG_INTERVAL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    histogram?.disable();
  };
}

export function mainLoopReport(): MainLoopReport {
  const ms = (ns: number) => Math.round(ns / 1e5) / 10;
  const h = histogram;
  return {
    eventLoopDelay: h
      ? { mean: ms(h.mean), p50: ms(h.percentile(50)), p90: ms(h.percentile(90)), p99: ms(h.percentile(99)), max: ms(h.max), samplesFor: Date.now() - histogramSince }
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
    handle(channel, ((...args: never[]) => mainSpan(`ipc ${channel}`, () => listener(...args))) as typeof listener);
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
