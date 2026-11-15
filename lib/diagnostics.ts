import { slowestInteractions, type SlowInteraction } from './interaction-latency';

/** What the renderer adds to a diagnostics export. */
export interface RendererDiagnostics {
  interactions: SlowInteraction[];
  monitor: { supported: boolean; frameTiming: boolean; threshold: number };
  window: { width: number; height: number; devicePixelRatio: number };
  memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
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
      scripts: (Array.isArray(entry.scripts) ? (entry.scripts as Partial<SlowInteraction['scripts'][number]>[]) : []).slice(0, 10).map((s) => ({
        invokerType: text(s.invokerType, 40),
        invoker: text(s.invoker, 120),
        source: text(s.source),
        duration: number(s.duration),
        forcedLayout: number(s.forcedLayout),
      })),
    })
  );
  const monitor = (value.monitor ?? {}) as Partial<RendererDiagnostics['monitor']>;
  const win = (value.window ?? {}) as Partial<RendererDiagnostics['window']>;
  return {
    interactions,
    monitor: { supported: !!monitor.supported, frameTiming: !!monitor.frameTiming, threshold: number(monitor.threshold) },
    window: { width: number(win.width), height: number(win.height), devicePixelRatio: number(win.devicePixelRatio) },
    ...(value.memory
      ? { memory: { usedJSHeapSize: number(value.memory.usedJSHeapSize), totalJSHeapSize: number(value.memory.totalJSHeapSize) } }
      : {}),
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
  const { slowInteractions, interactionMonitorState } = await import('./interaction-latency');
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
  return {
    interactions: slowInteractions(),
    monitor: interactionMonitorState(),
    window: { width: innerWidth, height: innerHeight, devicePixelRatio },
    ...(memory ? { memory: { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize } } : {}),
  };
}
