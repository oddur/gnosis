import type { PrChangeFile, PrFileContents } from '../../lib/pr-changes';
import { structuredPatch } from 'diff';
import { patchOf } from './syntax-scope';

/**
 * Synthetic files for the breadcrumb navigation matrix (`--breadcrumb-nav`, tests/breadcrumb-nav-browser.ts), added to
 * the workbench fixture's Changes with `?breadcrumb-nav`, and to its first Explanation topic.
 *
 * - `deep.ts`: TypeScript four levels deep (`namespace › class › method › function`), the class line hidden in a gap,
 *   and an import changed at the top level.
 * - `far_mod.rs`: Rust `mod › impl › fn`, the module's first line 240 lines above its change, so a jump reveals a hunk
 *   long enough to be sliced (#353) and its slices mount late.
 * - `Navmesh.cs`: C# `namespace › class › property` and `› method`.
 * - `queue.py`, `server.go`, `Store.java`: Python, Go and Java, nested where the language nests.
 * - `ledger.ts`: a hunk that only deletes lines, named by the old file.
 * - `twice.ts`: a definition whose first line is in another hunk above.
 * - `scoped.ts`: show scope's rule (lib/show-scope.ts): a short class that shows whole around its method, two hunks of one
 *   function that join, a function too long to show, and one whose ends show around a long middle.
 * - `outline.ts`: the outline (#394): a modified, a removed, an added function and a modified method.
 */
const range = (count: number, line: (i: number) => string) => Array.from({ length: count }, (_, i) => line(i));
const double = (pattern: RegExp) => (line: string) => line.replace(pattern, (_m, lead: string, n: string) => `${lead}${n} * 2;`);

const deepBefore = [
  '// Breadcrumb navigation fixture: TypeScript, four levels deep.',
  "import { join } from 'node:path';",
  "import { readFile } from 'node:fs/promises';",
  '',
  ...range(20, (i) => `export const lead${i} = ${i};`),
  'export namespace Engine {',
  '  export class Scheduler {',
  '    private ticks = 0;',
  ...range(18, (i) => `    readonly slot${i} = ${i};`),
  '    run(input: number): number {',
  '      let total = input;',
  '      function step(value: number): number {',
  '        let next = value;',
  ...range(60, (i) => `        next += ${i};`),
  '        return next;',
  '      }',
  '      total = step(total);',
  '      return total;',
  '    }',
  '  }',
  '}',
];
const deepAfter = deepBefore
  .map((line) => (line === "import { join } from 'node:path';" ? "import { join, resolve } from 'node:path';" : line))
  .map(double(/^( {8}next \+= )(\d+);$/));

const farBefore = [
  '// Breadcrumb navigation fixture: Rust, a module far above its change.',
  'pub mod api {',
  '    pub struct Client;',
  ...range(240, (i) => `    pub const FAR_${i}: u32 = ${i};`),
  '    impl Client {',
  '        pub fn handle(&self, input: u32) -> u32 {',
  '            let mut total = input;',
  ...range(60, (i) => `            total += ${i};`),
  '            total',
  '        }',
  '    }',
  '}',
];
const farAfter = farBefore.map(double(/^( {12}total \+= )(\d+);$/));

const navmeshBefore = [
  'using UnityEngine;',
  '',
  'namespace Seed.World',
  '{',
  '    public class Navmesh : MonoBehaviour',
  '    {',
  ...range(20, (i) => `        private int field${i} = ${i};`),
  '        public float Speed',
  '        {',
  '            get',
  '            {',
  '                var s = 0f;',
  ...range(30, (i) => `                s += ${i}f;`),
  '                return s;',
  '            }',
  '        }',
  '',
  ...range(20, (i) => `        private int other${i} = ${i};`),
  '        private void Update()',
  '        {',
  '            var d = 0f;',
  ...range(40, (i) => `            d += ${i}f;`),
  '            transform.Translate(0, d, 0);',
  '        }',
  '    }',
  '}',
];
const navmeshAfter = navmeshBefore.map((line) => line.replace(/^( +)(s|d) \+= (\d+)f;$/, '$1$2 += $3f * 2f;'));

const queueBefore = [
  '# Breadcrumb navigation fixture: Python.',
  'import os',
  '',
  ...range(20, (i) => `LEAD_${i} = ${i}`),
  'class Queue:',
  '    """A queue of work."""',
  ...range(15, (i) => `    slot_${i} = ${i}`),
  '    def drain(self, items):',
  '        total = 0',
  '        def visit(item):',
  '            nonlocal total',
  ...range(50, (i) => `            total += ${i}`),
  '            return total',
  '        for item in items:',
  '            visit(item)',
  '        return total',
];
const queueAfter = queueBefore.map((line) => line.replace(/^( {12}total \+= )(\d+)$/, '$1$2 * 2'));

const serverBefore = [
  'package nav',
  '',
  'import (',
  '\t"fmt"',
  ')',
  '',
  ...range(20, (i) => `const lead${i} = ${i}`),
  'type Server struct {',
  '\tcount int',
  '}',
  '',
  ...range(20, (i) => `var pad${i} = ${i}`),
  'func (s *Server) Handle(input int) int {',
  '\ttotal := input',
  ...range(50, (i) => `\ttotal += ${i}`),
  '\tfmt.Println(total)',
  '\treturn total',
  '}',
];
const serverAfter = serverBefore
  .flatMap((line) => (line === '\t"fmt"' ? [line, '\t"strings"'] : [line]))
  .map((line) => line.replace(/^(\ttotal \+= )(\d+)$/, '$1$2 * 2'));

const storeBefore = [
  'package nav;',
  '',
  'public class Store {',
  ...range(20, (i) => `    private int lead${i} = ${i};`),
  '    static class Cache {',
  '        private int hits = 0;',
  ...range(15, (i) => `        private int slot${i} = ${i};`),
  '        int load(int input) {',
  '            int total = input;',
  ...range(50, (i) => `            total += ${i};`),
  '            return total;',
  '        }',
  '    }',
  '}',
];
const storeAfter = storeBefore.map(double(/^( {12}total \+= )(\d+);$/));

const ledgerBefore = [
  '// Breadcrumb navigation fixture: a method that only loses lines.',
  'export class Ledger {',
  ...range(18, (i) => `  readonly mark${i} = ${i};`),
  '  settle(): number {',
  '    let n = 0;',
  ...range(80, (i) => `    n += ${i};`),
  '    return n;',
  '  }',
  '}',
];
const ledgerAfter = ledgerBefore.filter((line) => !/^ {4}n \+= \d*[02468];$/.test(line));

/** A class whose first line is in a hunk of its own, above the method's: going to it reveals nothing. */
const twiceBefore = [
  '// Breadcrumb navigation fixture: a definition in another hunk above.',
  'export class Twice {',
  '  private first = 1;',
  ...range(30, (i) => `  readonly pad${i} = ${i};`),
  '  work(input: number): number {',
  '    let total = input;',
  ...range(60, (i) => `    total += ${i};`),
  '    return total;',
  '  }',
  '}',
];
const twiceAfter = twiceBefore
  .map((line) => (line === '  private first = 1;' ? '  private first = 2;' : line))
  .map(double(/^( {4}total \+= )(\d+);$/));

const scopedBefore = [
  '// Show scope fixture.',
  'export class Small {',
  '  private a = 1;',
  '  private b = 2;',
  '  total(): number {',
  '    let t = 0;',
  '    t += this.a;',
  '    t += this.b;',
  '    t += 1;',
  '    return t;',
  '  }',
  '  reset(): void {',
  '    this.a = 0;',
  '  }',
  '  readonly c = 3;',
  '}',
  ...range(20, (i) => `export const mid${i} = ${i};`),
  'export function joined(input: number): number {',
  '  let v = input;',
  ...range(26, (i) => `  v += ${i};`),
  '  return v;',
  '}',
  '',
  'export function long(input: number): number {',
  '  let w = input;',
  ...range(40, (i) => `  w += ${i};`),
  '  return w;',
  '}',
  'export function apart(input: number): number {',
  '  let x = input;',
  ...range(34, (i) => `  x += ${i};`),
  '  return x;',
  '}',
];
const scopedAfter = scopedBefore.map((line) =>
  ['    t += this.b;', '  v += 2;', '  v += 19;', '  w += 20;', '  x += 2;', '  x += 31;'].includes(line) ? line.replace(/;$/, ' * 2;') : line
);

const outlineBefore = [
  '// Outline fixture.',
  'export function merge(a: number[], b: number[]): number[] {',
  '  const out = [...a];',
  '  out.push(...b);',
  '  return out;',
  '}',
  ...range(10, (i) => `export const pad${i} = ${i};`),
  'export function rebase(list: number[]): number[] {',
  '  return list.slice(1);',
  '}',
  ...range(10, (i) => `export const gap${i} = ${i};`),
  'export class Updater {',
  '  private n = 0;',
  '  updateBranch(): number {',
  '    return this.n;',
  '  }',
  '}',
  ...range(10, (i) => `export const tail${i} = ${i};`),
];
const outlineAfter = [
  ...outlineBefore
    .map((line) => (line === '  out.push(...b);' ? '  out.push(...b.filter(Boolean));' : line === '    return this.n;' ? '    return this.n + 1;' : line))
    .filter((_line, i) => i < 16 || i > 18),
  'export function squash(list: number[]): number {',
  '  return list.length;',
  '}',
];

export const NAV_SOURCES: Record<string, [string[], string[]]> = {
  'src/nav/deep.ts': [deepBefore, deepAfter],
  'src/nav/far_mod.rs': [farBefore, farAfter],
  'src/nav/Navmesh.cs': [navmeshBefore, navmeshAfter],
  'src/nav/queue.py': [queueBefore, queueAfter],
  'src/nav/server.go': [serverBefore, serverAfter],
  'src/nav/Store.java': [storeBefore, storeAfter],
  'src/nav/ledger.ts': [ledgerBefore, ledgerAfter],
  'src/nav/twice.ts': [twiceBefore, twiceAfter],
  'src/nav/scoped.ts': [scopedBefore, scopedAfter],
  'src/nav/outline.ts': [outlineBefore, outlineAfter],
};

/**
 * Added and deleted files (#394): their structure comes from the patch, which holds the whole side, with no read.
 * `wire_response.rs` adds a struct and its impl, `widget_panel.ts` a class with three methods, and `worker_job.ts`
 * deletes two functions. Each is long enough to scroll through with its hunk header pinned. Their names sort after
 * every other file, so the rows around `far_mod.rs` are the same as without them: the arrival check needs it near the
 * top, and the scroll performance check mounts the rows below it.
 */
const responseAdded = [
  'use serde::Serialize;',
  '',
  '#[derive(Debug, Clone, Default, Serialize)]',
  'pub struct BuildingObjectPositionResponse {',
  ...Array.from({ length: 24 }, (_, i) => `    pub field_${i}: f32,`),
  '}',
  '',
  'impl BuildingObjectPositionResponse {',
  '    pub fn new() -> Self {',
  ...Array.from({ length: 40 }, (_, i) => `        let value_${i} = ${i} as f32;`),
  '        Self::default()',
  '    }',
  '}',
];
const method = (name: string) => [
  `  ${name}(): number {`,
  '    let size = 0;',
  ...Array.from({ length: 24 }, (_, i) => `    size += ${i}; // ${name}`),
  '    return size;',
  '  }',
];
const panelAdded = ["import { render } from './dom';", '', 'export class Panel {', ...method('open'), ...method('close'), ...method('resize'), '}'];
const jobDeleted = [
  'export function runJob(input: number): number {',
  ...Array.from({ length: 30 }, (_, i) => `  input += ${i}; // run`),
  '  return input;',
  '}',
  '',
  'export function stopJob(input: number): number {',
  ...Array.from({ length: 30 }, (_, i) => `  input -= ${i}; // stop`),
  '  return input;',
  '}',
];
export const NAV_WHOLE: Record<string, { status: 'added' | 'deleted'; lines: string[] }> = {
  'src/nav/wire_response.rs': { status: 'added', lines: responseAdded },
  'src/nav/widget_panel.ts': { status: 'added', lines: panelAdded },
  'src/nav/worker_job.ts': { status: 'deleted', lines: jobDeleted },
};

const text = (lines: string[]) => `${lines.join('\n')}\n`;
/** GitHub's patch of a whole file added or deleted: one hunk from `@@ -0,0 +1,N @@` or `@@ -1,N +0,0 @@`. */
function wholePatch(status: 'added' | 'deleted', lines: string[]): string {
  const [before, after] = status === 'added' ? ['', text(lines)] : [text(lines), ''];
  const [hunk] = structuredPatch('a', 'b', before, after, '', '', { context: 3 }).hunks;
  return [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines].join('\n');
}

export const breadcrumbNavFiles: PrChangeFile[] = [
  ...Object.entries(NAV_SOURCES).map(([path, [before, after]], i) => {
    const patch = patchOf(before, after);
    const additions = patch.split('\n').filter((line) => line.startsWith('+')).length;
    const deletions = patch.split('\n').filter((line) => line.startsWith('-')).length;
    return { path, status: 'modified' as const, additions, deletions, changeId: `nav-${i}`, patch };
  }),
  ...Object.entries(NAV_WHOLE).map(([path, { status, lines }], i) => ({
    path,
    status,
    additions: status === 'added' ? lines.length : 0,
    deletions: status === 'deleted' ? lines.length : 0,
    changeId: `nav-whole-${i}`,
    patch: wholePatch(status, lines),
  })),
];

export function breadcrumbNavContents(path: string): PrFileContents | undefined {
  const whole = Object.hasOwn(NAV_WHOLE, path) ? NAV_WHOLE[path] : undefined;
  if (whole)
    return whole.status === 'added'
      ? { before: { kind: 'absent' }, after: { kind: 'text', content: text(whole.lines) } }
      : { before: { kind: 'text', content: text(whole.lines) }, after: { kind: 'absent' } };
  const source = Object.hasOwn(NAV_SOURCES, path) ? NAV_SOURCES[path] : undefined;
  if (!source) return undefined;
  return { before: { kind: 'text', content: text(source[0]) }, after: { kind: 'text', content: text(source[1]) } };
}

/** The files the first Explanation topic shows whole with `?breadcrumb-nav`: the same checks run in a slide;
 * `far_mod.rs`, far down the topic, is arrived at straight in its middle; and `panel.ts` is an added file. */
export const NAV_TOPIC_FILES = ['src/nav/deep.ts', 'src/nav/scoped.ts', 'src/nav/outline.ts', 'src/nav/far_mod.rs', 'src/nav/widget_panel.ts'];
