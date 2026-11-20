import type { PrChangeFile, PrFileContents } from '../../lib/pr-changes';
import { patchOf } from './syntax-scope';

/**
 * `?moved-symbols`: moved and renamed symbols (#398, tests/moved-symbols-browser.ts). The PR:
 * - `src/moves/store.ts` loses `flushQueue` (to queue.ts, one line edited) and `parseHeader` (to headers.ts, renamed
 *   `readHeader`, unchanged), and moves `formatEntry` from its top to its bottom.
 * - `src/moves/queue.ts` gains `flushQueue`; `src/moves/headers.ts` is added with `readHeader`.
 * - `Runtime/Bridge.cs` loses `Drain`, which `Runtime/Pump.cs`, added, has as `DrainAll`.
 * - `src/moves/close-a.ts` and `src/moves/close-b.ts` each lose the same `closeAll`, which `src/moves/base.ts` gains
 *   once: a tie, which must show no move at all.
 *
 * `?moved-symbols-large`: a large PR for the cost check. `LARGE_MOVE_FILES` TypeScript and C# files of 24 functions
 * each, two small edits in every file, and `LARGE_MOVES` functions moved between files (a third renamed, a third
 * edited), plus deleted and added functions that match nothing.
 */
export const MOVE_FILES = {
  store: 'src/moves/store.ts',
  queue: 'src/moves/queue.ts',
  headers: 'src/moves/headers.ts',
  bridge: 'Runtime/Bridge.cs',
  pump: 'Runtime/Pump.cs',
  closeA: 'src/moves/close-a.ts',
  closeB: 'src/moves/close-b.ts',
  base: 'src/moves/base.ts',
} as const;

const filler = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `export const ${prefix}${i} = ${i};`);

const formatEntry = [
  'export function formatEntry(entry: Entry, width: number): string {',
  '  const label = entry.name.padEnd(width, " ");',
  '  const size = String(entry.size).padStart(8, " ");',
  '  const when = new Date(entry.modified).toISOString().slice(0, 10);',
  '  return `${label} ${size} ${when}`;',
  '}',
];
const flushQueue = (factor: string) => [
  'export function flushQueue(queue: Job[], limit: number): number {',
  '  let flushed = 0;',
  '  if (!queue.length || limit <= 0) return flushed;',
  '  for (const job of queue.splice(0, limit)) {',
  '    job.run();',
  `    flushed += job.weight * ${factor};`,
  '  }',
  '  return flushed;',
  '}',
];
const header = (name: string) => [
  `export function ${name}(raw: string): Header {`,
  '  const [key, ...rest] = raw.split(":");',
  '  const value = rest.join(":").trim();',
  '  if (!key) throw new Error(`Empty header: ${raw}`);',
  '  return { key: key.trim().toLowerCase(), value };',
  '}',
];
const closeAll = [
  '  closeAll(): void {',
  '    for (const listener of this.listeners) listener.close();',
  '    this.listeners.length = 0;',
  '    this.timers.forEach((timer) => clearTimeout(timer));',
  '    this.timers.clear();',
  '  }',
];
const drain = (name: string) => [
  `        public int ${name}(Queue<Job> jobs, int limit)`,
  '        {',
  '            var drained = 0;',
  '            while (jobs.Count > 0 && drained < limit)',
  '            {',
  '                jobs.Dequeue().Run();',
  '                drained++;',
  '            }',
  '            return drained;',
  '        }',
];

const storeBefore = [
  "import type { Entry, Header, Job } from './types';",
  '',
  ...formatEntry,
  '',
  ...filler('store', 24),
  '',
  ...flushQueue('2'),
  '',
  ...filler('mid', 16),
  '',
  ...header('parseHeader'),
  '',
  'export class Store {',
  '  size = 0;',
  '}',
];
const storeAfter = [
  "import type { Entry, Header, Job } from './types';",
  '',
  ...filler('store', 24),
  '',
  ...filler('mid', 16),
  '',
  'export class Store {',
  '  size = 0;',
  '}',
  '',
  ...formatEntry,
];
const queueBefore = ["import type { Job } from './types';", '', ...filler('queue', 12)];
const queueAfter = [...queueBefore, '', ...flushQueue('3')];
const headersAfter = [
  "import type { Header } from './types';",
  '',
  ...header('readHeader'),
  '',
  ...filler('headers', 4),
];
const bridgeBefore = [
  'namespace Gnosis.Runtime',
  '{',
  '    public class Bridge',
  '    {',
  '        public int Size;',
  '',
  ...drain('Drain'),
  '    }',
  '}',
];
const bridgeAfter = [
  'namespace Gnosis.Runtime',
  '{',
  '    public class Bridge',
  '    {',
  '        public int Size;',
  '    }',
  '}',
];
const pumpAfter = [
  'namespace Gnosis.Runtime',
  '{',
  '    public class Pump',
  '    {',
  ...drain('DrainAll'),
  '    }',
  '}',
];
const closer = (name: string) => [
  `export class ${name} {`,
  '  listeners: Listener[] = [];',
  '  timers = new Set<number>();',
  ...closeAll,
  '}',
];
const closerAfter = (name: string) => [
  `export class ${name} extends Base {`,
  '  listeners: Listener[] = [];',
  '  timers = new Set<number>();',
  '}',
];

const SOURCES: [string, string[] | undefined, string[] | undefined][] = [
  [MOVE_FILES.store, storeBefore, storeAfter],
  [MOVE_FILES.queue, queueBefore, queueAfter],
  [MOVE_FILES.headers, undefined, headersAfter],
  [MOVE_FILES.bridge, bridgeBefore, bridgeAfter],
  [MOVE_FILES.pump, undefined, pumpAfter],
  [MOVE_FILES.closeA, closer('A'), closerAfter('A')],
  [MOVE_FILES.closeB, closer('B'), closerAfter('B')],
  [
    MOVE_FILES.base,
    undefined,
    ['export class Base {', '  listeners: Listener[] = [];', '  timers = new Set<number>();', ...closeAll, '}'],
  ],
];

const text = (lines: string[] | undefined) => (lines?.length ? `${lines.join('\n')}\n` : '');
function changeFile(path: string, before: string[] | undefined, after: string[] | undefined, id: string): PrChangeFile {
  // An added or deleted file's patch is its one side whole, as GitHub sends it.
  const patch = !before
    ? [`@@ -0,0 +1,${after?.length ?? 0} @@`, ...(after ?? []).map((line) => `+${line}`)].join('\n')
    : !after
      ? [`@@ -1,${before.length} +0,0 @@`, ...before.map((line) => `-${line}`)].join('\n')
      : patchOf(before, after, { headers: true });
  const lines = patch.split('\n');
  return {
    path,
    status: !before ? 'added' : !after ? 'deleted' : 'modified',
    additions: lines.filter((line) => line.startsWith('+')).length,
    deletions: lines.filter((line) => line.startsWith('-')).length,
    changeId: id,
    patch,
  };
}
const contentsOf = (before: string[] | undefined, after: string[] | undefined): PrFileContents => ({
  before: before ? { kind: 'text', content: text(before) } : { kind: 'absent' },
  after: after ? { kind: 'text', content: text(after) } : { kind: 'absent' },
});

export const movedSymbolsFiles: PrChangeFile[] = SOURCES.map(([path, before, after], i) =>
  changeFile(path, before, after, `moves-${i}`)
);
const BY_PATH = new Map(SOURCES.map(([path, before, after]) => [path, { before, after }]));
export function movedSymbolsContents(path: string): PrFileContents | undefined {
  const file = BY_PATH.get(path);
  return file && contentsOf(file.before, file.after);
}

// ── The large PR ────────────────────────────────────────────────────────────

export const LARGE_MOVE_FILES = 240;
export const LARGE_MOVES = 36;
const FUNCTIONS = 24;

/** Function `k` of file `f`: 10 to 18 lines whose statements depend on both, so no two are alike. */
function largeFunction(
  extension: 'ts' | 'cs',
  f: number,
  k: number,
  name = extension === 'ts' ? `step${f}x${k}` : `Step${f}x${k}`
): string[] {
  const steps = 6 + ((f + k) % 9);
  const body = Array.from(
    { length: steps },
    (_, i) =>
      `total += Compute(input, ${(f * 31 + k * 7 + i) % 97}) * (limit - ${i}) + Offset${k % 5}(${i}, ${f * 100 + k});`
  );
  if (extension === 'ts')
    return [
      `export function ${name}(input: number[], limit: number): number {`,
      '  let total = 0;',
      ...body.map((l) => `  ${l}`),
      '  return total;',
      '}',
    ];
  return [
    `        public int ${name}(int[] input, int limit)`,
    '        {',
    '            var total = 0;',
    ...body.map((l) => `            ${l}`),
    '            return total;',
    '        }',
  ];
}
function largeSource(extension: 'ts' | 'cs', f: number, functions: string[][]): string[] {
  const body = functions.flatMap((fn) => ['', ...fn]);
  if (extension === 'ts') return [`// Large move fixture ${f}.`, "import { Compute } from './compute';", ...body];
  return [
    `// Large move fixture ${f}.`,
    'namespace Gnosis.Moves',
    '{',
    `    public class Service${f}`,
    '    {',
    ...body,
    '    }',
    '}',
  ];
}
interface LargeFile {
  path: string;
  before: string[];
  after: string[];
}
let large: Map<string, LargeFile> | undefined;
/** Where each large move goes: function `k` of file `from` to the end of file `to`, renamed or edited by its index. */
export const largeMoves = () =>
  Array.from({ length: LARGE_MOVES }, (_, m) => {
    const from = (m * 7) % LARGE_MOVE_FILES;
    // The same language, another file.
    const to = (from + 2 * (1 + (m % 5))) % LARGE_MOVE_FILES;
    return { from, to, k: 3 + (m % 12), renamed: m % 3 === 1, edited: m % 3 === 2 };
  });
function largeFiles(): Map<string, LargeFile> {
  if (large) return large;
  const extensionOf = (f: number): 'ts' | 'cs' => (f % 2 ? 'cs' : 'ts');
  const functions = Array.from({ length: LARGE_MOVE_FILES }, (_, f) =>
    Array.from({ length: FUNCTIONS }, (_, k) => largeFunction(extensionOf(f), f, k))
  );
  const afterFunctions = functions.map((list) => list.map((fn) => [...fn]));
  // Two small edits in every file: a line in its second and its last function.
  for (const list of afterFunctions)
    for (const fn of [list[1], list[FUNCTIONS - 1]]) fn[3] = fn[3].replace('* (limit -', '* (limit + 1 -');
  const removed = new Set<string>();
  for (const { from, to, k, renamed, edited } of largeMoves()) {
    const extension = extensionOf(from);
    removed.add(`${from}:${k}`);
    const moved = largeFunction(
      extension,
      from,
      k,
      renamed ? (extension === 'ts' ? `moved${from}x${k}` : `Moved${from}x${k}`) : undefined
    );
    if (edited) moved[4] = moved[4].replace('Compute(input,', 'Compute(input.slice(1),');
    afterFunctions[to].push(moved);
  }
  // Deleted and added functions that match nothing: every 9th file loses its function 20, every 11th gains a new one.
  for (let f = 0; f < LARGE_MOVE_FILES; f += 9) removed.add(`${f}:20`);
  for (let f = 5; f < LARGE_MOVE_FILES; f += 11) afterFunctions[f].push(largeFunction(extensionOf(f), f + 1000, 99));
  large = new Map(
    functions.map((list, f) => {
      const extension = extensionOf(f);
      const path = `src/large-moves/${extension === 'ts' ? 'web' : 'Services'}/m${String(f).padStart(3, '0')}.${extension}`;
      const after = afterFunctions[f].filter((_, k) => k >= FUNCTIONS || !removed.has(`${f}:${k}`));
      return [path, { path, before: largeSource(extension, f, list), after: largeSource(extension, f, after) }];
    })
  );
  return large;
}
let largeChanges: PrChangeFile[] | undefined;
export const movedSymbolsLargeFiles = (): PrChangeFile[] =>
  (largeChanges ??= [...largeFiles().values()].map(({ path, before, after }, i) =>
    changeFile(path, before, after, `large-moves-${i}`)
  ));
export function movedSymbolsLargeContents(path: string): PrFileContents | undefined {
  if (!path.startsWith('src/large-moves/')) return undefined;
  const file = largeFiles().get(path);
  return file && contentsOf(file.before, file.after);
}
/** The path of large file `f`. */
export const largeMovePath = (f: number) =>
  `src/large-moves/${f % 2 ? 'Services' : 'web'}/m${String(f).padStart(3, '0')}.${f % 2 ? 'cs' : 'ts'}`;
