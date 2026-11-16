import { slowestInteractions, type InteractionScript, type LongFrame, type SlowInteraction } from './interaction-latency';

/** What the renderer adds to a diagnostics export. */
export interface RendererDiagnostics {
  interactions: SlowInteraction[];
  monitor: { supported: boolean; frameTiming: boolean; threshold: number };
  window: { width: number; height: number; devicePixelRatio: number };
  memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
  /** Recent long animation frames, 100 ms or more, with the scripts that ran in them. */
  longFrames?: LongFrame[];
  /** The window's own startup: milliseconds from navigation start, and how long the window has been open. */
  startup?: Record<string, number>;
}

/** The sections main and the renderer add to the diagnostics file, beside sync health (#345). */
export interface DiagnosticsSections {
  system: { platform: string; arch: string; release: string; cpus: number; memoryBytes: number; packaged: boolean };
  versions: Record<string, string | undefined>;
  /** Main-process startup marks, when GNOSIS_PERF_TRACE was set. */
  startup: Record<string, number>;
  /** The exporting window: its slow interactions, newest last, and the ten slowest. */
  renderer: RendererDiagnostics & { slowest: SlowInteraction[] };
}

const MAX_INTERACTIONS = 500;

/** Keeps only the fields a report needs from untrusted renderer input. */
export function sanitizeRendererDiagnostics(input: unknown): RendererDiagnostics {
  const value = (input && typeof input === 'object' ? input : {}) as Partial<RendererDiagnostics>;
  const number = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
  const text = (s: unknown, max = 200) => (typeof s === 'string' ? s.slice(0, max) : '');
  const scripts = (list: unknown): InteractionScript[] =>
    (Array.isArray(list) ? (list as Partial<InteractionScript>[]) : []).slice(0, 10).map((s) => ({
      invokerType: text(s.invokerType, 40),
      invoker: text(s.invoker, 120),
      source: text(s.source),
      ...(s.sourceURL ? { sourceURL: text(s.sourceURL) } : {}),
      ...(s.sourceFunctionName ? { sourceFunctionName: text(s.sourceFunctionName, 120) } : {}),
      ...(typeof s.sourceCharPosition === 'number' ? { sourceCharPosition: number(s.sourceCharPosition) } : {}),
      ...(typeof s.start === 'number' ? { start: number(s.start) } : {}),
      duration: number(s.duration),
      forcedLayout: number(s.forcedLayout),
    }));
  const interactions = (Array.isArray(value.interactions) ? value.interactions : []).slice(-MAX_INTERACTIONS).map(
    (entry: Partial<SlowInteraction>): SlowInteraction => ({
      at: number(entry.at),
      type: text(entry.type, 40),
      ...(entry.key ? { key: text(entry.key, 20) } : {}),
      target: text(entry.target),
      duration: number(entry.duration),
      inputDelay: number(entry.inputDelay),
      processing: number(entry.processing),
      presentation: number(entry.presentation),
      ...(entry.frames && typeof entry.frames === 'object'
        ? {
            frames: {
              count: number(entry.frames.count),
              blocking: number(entry.frames.blocking),
              script: number(entry.frames.script),
              styleAndLayout: number(entry.frames.styleAndLayout),
              render: number(entry.frames.render),
            },
          }
        : {}),
      ...(entry.longTasks !== undefined ? { longTasks: number(entry.longTasks) } : {}),
      scripts: scripts(entry.scripts),
      ...(entry.delay && typeof entry.delay === 'object'
        ? {
            delay: {
              frames: number(entry.delay.frames),
              longTasks: number(entry.delay.longTasks),
              startedBefore: number(entry.delay.startedBefore),
              blocking: number(entry.delay.blocking),
              scripts: scripts(entry.delay.scripts),
            },
          }
        : {}),
    })
  );
  const longFrames = (Array.isArray(value.longFrames) ? value.longFrames : []).slice(-200).map((frame: Partial<LongFrame>) => ({
    at: number(frame.at),
    duration: number(frame.duration),
    blocking: number(frame.blocking),
    scripts: scripts(frame.scripts),
  }));
  const startup = value.startup && typeof value.startup === 'object'
    ? Object.fromEntries(Object.entries(value.startup).slice(0, 40).map(([key, n]) => [text(key, 60), number(n)]))
    : undefined;
  const monitor = (value.monitor ?? {}) as Partial<RendererDiagnostics['monitor']>;
  const win = (value.window ?? {}) as Partial<RendererDiagnostics['window']>;
  return {
    interactions,
    monitor: { supported: !!monitor.supported, frameTiming: !!monitor.frameTiming, threshold: number(monitor.threshold) },
    window: { width: number(win.width), height: number(win.height), devicePixelRatio: number(win.devicePixelRatio) },
    ...(value.memory
      ? { memory: { usedJSHeapSize: number(value.memory.usedJSHeapSize), totalJSHeapSize: number(value.memory.totalJSHeapSize) } }
      : {}),
    ...(longFrames.length ? { longFrames } : {}),
    ...(startup ? { startup } : {}),
  };
}

/** Diagnostics sections from main's context and the renderer's untrusted payload. */
export function diagnosticsSections(
  input: unknown,
  context: Omit<DiagnosticsSections, 'renderer'>
): DiagnosticsSections {
  const renderer = sanitizeRendererDiagnostics(input);
  return { ...context, renderer: { ...renderer, slowest: slowestInteractions(renderer.interactions, 10) } };
}

/** The renderer half of a report: the slow-interaction ring buffer and the window it ran in. */
export async function collectRendererDiagnostics(): Promise<RendererDiagnostics> {
  const { slowInteractions, interactionMonitorState, longFrames } = await import('./interaction-latency');
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
  return {
    interactions: slowInteractions(),
    monitor: interactionMonitorState(),
    window: { width: innerWidth, height: innerHeight, devicePixelRatio },
    ...(memory ? { memory: { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize } } : {}),
    longFrames: longFrames(),
    startup: rendererStartup(),
  };
}

/** Navigation and paint timings of this window, and how long it has been open. Main's own marks need GNOSIS_PERF_TRACE;
 * these are always available. */
function rendererStartup(): Record<string, number> {
  const marks: Record<string, number> = { openForMs: Math.round(performance.now()) };
  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  if (navigation) {
    marks.domContentLoaded = Math.round(navigation.domContentLoadedEventEnd);
    marks.load = Math.round(navigation.loadEventEnd);
  }
  for (const paint of performance.getEntriesByType('paint')) marks[paint.name] = Math.round(paint.startTime);
  for (const mark of performance.getEntriesByType('mark')) if (/^[\w:-]{1,60}$/.test(mark.name)) marks[mark.name] = Math.round(mark.startTime);
  return marks;
}
