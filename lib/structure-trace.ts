import { addDiagnosticsSource } from './diagnostics-sources';

/**
 * When each step of a file's structure happened, so an export shows where its breadcrumbs spent their time: near the
 * view, the contents read asked for, started and done, the after side's parse asked for, sent to the worker and
 * answered, and the parsed breadcrumbs rendered. Times are `performance.now()` on the page; the worker adds how long
 * the parse waited in its queue and how long it ran. Keys are file revision keys (`changeFileKey`).
 */
export interface StructureTrace {
  near?: number;
  viewRequest?: number;
  readStart?: number;
  readEnd?: number;
  parseRequest?: number;
  parsePosted?: number;
  parseDone?: number;
  /** In the worker: waiting behind other parses, loading the grammar, parsing and querying. */
  workerWait?: number;
  load?: number;
  parse?: number;
  query?: number;
  /** Prefetched jobs the worker started while this parse waited at its tier (lib/syntax-scope.worker.ts). */
  prefetchAhead?: number;
  /** The parse's priority when it started: 'view', 'near' or 'prefetch'. */
  tier?: string;
  beforeDone?: number;
  shown?: number;
}
const ENTRIES = 600;
const traces = new Map<string, StructureTrace>();

/** Records a step the first time it happens for a file. */
export function traceStructure(key: string, values: Partial<StructureTrace>) {
  let entry = traces.get(key);
  if (!entry) {
    entry = {};
    traces.set(key, entry);
    if (traces.size > ENTRIES) traces.delete(traces.keys().next().value!);
  }
  for (const [name, value] of Object.entries(values) as [keyof StructureTrace, never][])
    if (entry[name] === undefined && value !== undefined) entry[name] = value;
}
export const structureTraces = (): Record<string, StructureTrace> => Object.fromEntries(traces);
export const clearStructureTraces = () => traces.clear();
addDiagnosticsSource('structureTrace', () => [...traces].slice(-60).map(([key, trace]) => ({ key, ...trace })));
