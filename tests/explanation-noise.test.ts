import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  applyNoise,
  changedRange,
  contextOnlyHunks,
  leftOutLabel,
  noiseLevelChanged,
  noisePlannerDirective,
  normalizeNoiseReduction,
  normalizePlannerNoise,
  quietReason,
  ruleNoise,
  savedNoiseLevel,
  toolReadComment,
  withImportBlocks,
} from '../lib/explanation-noise';
import { blockKey, changeBlocks, patchHunks } from '../lib/semantic-noise';
import { syntaxLanguage } from '../lib/syntax-scope';
import { assertPerf, perfBudget } from './perf-budget';
import { structuredPatch } from 'diff';
import {
  DEFAULT_EXPLANATION_PREFERENCES,
  normalizeExplanationOptions,
  normalizeExplanationPreferences,
} from '../lib/explanation-options';
import { planReview, plannerUserSuffix } from '../lib/agent';
import { claudeProvider } from '../lib/providers/claude';
import { buildTopicContext } from '../lib/context-builder';
import { buildIndexedHunks, type IndexedHunk } from '../lib/diff-parse';
import type { TopicPlan } from '../lib/types';
import {
  FIXTURES,
  loadFixtures,
  noiseEngine,
  prepareFixture,
  replay,
  ruleCutsFor,
  writeRecorded,
  writeManifest,
  commitRecording,
  plannerInput,
  fixtureHash,
  promptHash,
} from '../scripts/explanation-noise-eval-lib';

/** One modified file's hunk from its two texts' changed lines. */
function hunk(header: string, rows: string[], filePath = 'src/a.ts', id = 'hunk-0') {
  return { id, filePath, fileStatus: 'modified' as const, hunkHeader: header, content: rows.join('\n') };
}
const text = (...lines: string[]) => lines.join('\n') + '\n';

/** Layer 1's cut reasons for each hunk of one file's change (null: kept), through the worker's comparison. */
const engine = noiseEngine();
async function cuts(path: string, before: string | null, after: string | null, level: 'conservative' | 'aggressive' = 'conservative') {
  const lines = (t: string | null) => (t === null ? null : t.replace(/\n$/, '').split('\n'));
  const prepared = prepareFixture(
    { id: 'case', title: 'T', description: 'D', source: '', files: [{ path, before: lines(before), after: lines(after), hunks: [] }] },
    false
  );
  const found = await ruleCutsFor(engine, prepared, level);
  return prepared.hunks.map((h) => found.get(h.id) ?? null);
}

void describe('rules: imports are cut only when they widen', () => {
  const both = async (path: string, before: string, after: string) => [
    ...(await cuts(path, before, after, 'conservative')),
    ...(await cuts(path, before, after, 'aggressive')),
  ];
  void test('positives: a new plain name from a module the file already imports is cut at both levels', async () => {
    // A new line in a multi-line TS import, and a new statement from a module already imported.
    assert.deepEqual(
      await both('src/a.ts', text('import {', '  alpha,', "} from './x';", '', 'run(alpha);'), text('import {', '  alpha,', '  beta,', "} from './x';", '', 'run(alpha);')),
      ['import only', 'import only']
    );
    assert.deepEqual(
      await both('src/a.ts', text("import { alpha } from './x';", '', 'run(alpha);'), text("import { alpha } from './x';", "import { beta } from './x';", '', 'run(alpha);')),
      ['import only', 'import only']
    );
    // A standard-library spec in an existing Go block.
    const go = (extra: string) => text('package a', '', 'import (', '\t"fmt"', ...(extra ? [extra] : []), ')', '', 'func F() { fmt.Println() }');
    assert.deepEqual(await both('a.go', go(''), go('\t"strings"')), ['import only', 'import only']);
    // A Rust use from a path the file already uses, and a Java single-type import from a package it already imports.
    assert.deepEqual(
      await both('src/a.rs', text('use crate::error::Result;', '', 'fn f() {}'), text('use crate::error::Result;', 'use crate::error::Failure;', '', 'fn f() {}')),
      ['import only', 'import only']
    );
    assert.deepEqual(
      await both('src/A.java', text('package p;', 'import a.b.Alpha;', '', 'class A {}'), text('package p;', 'import a.b.Alpha;', 'import a.b.Beta;', '', 'class A {}')),
      ['import only', 'import only']
    );
  });
  void test('a changed import line is never a widening, even `{ a }` to `{ a, b }`', async () => {
    assert.deepEqual(await both('src/a.ts', text("import { alpha } from './x';", '', 'run(alpha);'), text("import { alpha, beta } from './x';", '', 'run(alpha);')), [null, null]);
    assert.deepEqual(await both('src/a.rs', text('use crate::error::Result;', 'fn f() {}'), text('use crate::error::{Failure, Result};', 'fn f() {}')), [null, null]);
  });
  void test('round 2: a lodash swap across hunks is kept', async () => {
    const filler = Array.from({ length: 10 }, (_, i) => `const v${i} = ${i};`);
    const before = text("import debounce from 'lodash/debounce';", ...filler, "import { map } from 'lodash-es';", '', 'debounce(map);');
    const after = text(...filler, "import { map } from 'lodash-es';", "import { debounce } from 'lodash-es';", '', 'debounce(map);');
    assert.deepEqual(await cuts('src/a.ts', before, after, 'aggressive'), [null, null]);
  });
  void test('round 2: a name that shadows a global is kept', async () => {
    const before = text("import { map } from 'bluebird';", '', 'map([]);');
    assert.deepEqual(await both('src/a.ts', before, text("import { map } from 'bluebird';", "import { Promise } from 'bluebird';", '', 'map([]);')), [null, null]);
    // A name the old file already uses, as a local or anything else.
    const local = text("import { map } from 'bluebird';", 'const filter = 1;', '', 'map([]);');
    assert.deepEqual(await both('src/a.ts', local, text("import { map } from 'bluebird';", "import { filter } from 'bluebird';", 'const filter = 1;', '', 'map([]);')), [null, null]);
  });
  void test('round 2: Python is never import-only', async () => {
    assert.deepEqual(await both('m.py', text('from .safe import read', '', 'read()'), text('from .safe import read', 'from .safe import open', '', 'read()')), [null, null]);
    assert.deepEqual(await both('m.py', text('import os', 'import json', '', 'os.getcwd()'), text('import json', 'import os', '', 'os.getcwd()')), [null, null]);
    assert.deepEqual(await both('app/apps.py', text('from django.apps import AppConfig', '', 'x = 1'), text('from django.apps import AppConfig', 'from . import signals', '', 'x = 1')), [null, null]);
  });
  void test('round 2: a C# namespace swap is kept', async () => {
    assert.deepEqual(await both('A.cs', text('using System;', 'using Old.Json;', '', 'class A {}'), text('using System;', 'using New.Json;', '', 'class A {}')), [null, null]);
  });
  void test('round 2: `import type` is kept', async () => {
    const before = text("import { alpha } from './x';", '', 'run(alpha);');
    assert.deepEqual(await both('src/a.ts', before, text("import { alpha } from './x';", "import type { Beta } from './x';", '', 'run(alpha);')), [null, null]);
    assert.deepEqual(await both('src/a.ts', before, text("import { alpha } from './x';", "import { type Beta } from './x';", '', 'run(alpha);')), [null, null]);
  });
  void test('aliases, defaults, namespaces, new modules, side effects and removals are kept', async () => {
    const before = text("import { alpha } from './x';", '', 'run(alpha);');
    const add = (line: string) => text("import { alpha } from './x';", line, '', 'run(alpha);');
    for (const line of ["import { beta as b } from './x';", "import gamma from './x';", "import * as ns from './x';", "import { beta } from './y';", "import './x';"])
      assert.deepEqual(await both('src/a.ts', before, add(line)), [null, null], line);
    assert.deepEqual(await both('src/a.ts', add("import { beta } from './x';"), before), [null, null], 'A removal');
    const go = (extra: string) => text('package a', '', 'import (', '\t"fmt"', ...(extra ? [extra] : []), ')', '', 'func F() { fmt.Println() }');
    for (const spec of ['\t"github.com/acme/x"', '\t_ "embed"', '\t. "strings"', '\tstr "strings"'])
      assert.deepEqual(await both('a.go', go(''), go(spec)), [null, null], spec);
    assert.deepEqual(await both('src/a.rs', text('use crate::error::Result;', '', 'fn f() {}'), text('use crate::error::Result;', 'use other::Thing;', '', 'fn f() {}')), [null, null], 'A Rust path the file never used');
    assert.deepEqual(await both('src/a.rs', text('use crate::error::Result;', '', 'fn f() {}'), text('use crate::error::Result;', 'pub use crate::error::Failure;', '', 'fn f() {}')), [null, null], 'pub use');
    assert.deepEqual(await both('src/A.java', text('package p;', 'import a.b.Alpha;', '', 'class A {}'), text('package p;', 'import a.b.Alpha;', 'import a.b.*;', '', 'class A {}')), [null, null], 'A wildcard');
  });
  void test('entry files, statements after an import, template literals and added files are kept', async () => {
    const widened = [text("import { alpha } from './x';", '', 'run(alpha);'), text("import { alpha } from './x';", "import { beta } from './x';", '', 'run(alpha);')] as const;
    for (const path of ['src/index.ts', 'lib/index.js']) assert.deepEqual(await both(path, ...widened), [null, null], path);
    assert.deepEqual(await both('src/a.ts', widened[0], text("import { alpha } from './x';", "import { beta } from './x'; run(beta);", '', 'run(alpha);')), [null, null]);
    const literal = (extra: string[]) => text("import { alpha } from './x';", 'const example = `', ...extra, '`;', 'show(example, alpha);');
    assert.deepEqual(await both('src/a.ts', literal([]), literal(["import { beta } from './x';"])), [null, null]);
    assert.deepEqual(await both('src/new.ts', null as unknown as string, text("import { alpha } from './x';")), [null, null]);
  });
});

/**
 * Quiet changes in Changes and Explanation diffs (#396) take the same rule: the worker's comparison marks a patch
 * hunk's blocks `imports` only where layer 1 cuts it as "import only". The view's hunks follow its context lines; the
 * rule reads the patch at GitHub's 3. `pick` compares only those patch hunks, as a topic does, with the file's old text
 * from the view. The answer is per patch hunk.
 */
async function quietImports(path: string, before: string, after: string, { pick, context = 3 }: { pick?: number[]; context?: number } = {}) {
  const lines = (t: string) => t.replace(/\n$/, '').split('\n');
  const prepared = prepareFixture(
    { id: 'case', title: 'T', description: 'D', source: '', files: [{ path, before: lines(before), after: lines(after), hunks: [] }] },
    false
  );
  const all = prepared.hunks.flatMap((h) => patchHunks(`${h.hunkHeader}\n${h.content}`) ?? []);
  const patch = pick ? pick.map((i) => all[i]) : all;
  const view = pick
    ? patch
    : structuredPatch('a', 'b', prepared.before[path], prepared.after[path], '', '', { context }).hunks.map((h) => ({
        oldStart: h.oldLines === 0 ? h.oldStart + 1 : h.oldStart,
        newStart: h.newLines === 0 ? h.newStart + 1 : h.newStart,
        rows: h.lines.filter((l) => !l.startsWith('\\')).map((l) => ({ type: l[0] as ' ' | '+' | '-', text: l.slice(1) })),
      }));
  const language = syntaxLanguage(path);
  assert.ok(language && all.length === prepared.hunks.length);
  const result = await engine.noise(language, prepared.after[path], view, false, pick ? 'after' : 'both');
  const blocks = await withImportBlocks(engine, language, { path, patch, before: pick ? prepared.before[path] : undefined }, result);
  const kinds = new Map(blocks.map((block) => [blockKey(block), block.kind]));
  return patch.map((hunk) => {
    const found = changeBlocks([hunk]).map((block) => kinds.get(blockKey(block)));
    return found.length && found.every((kind) => kind === 'imports') ? 'import only' : found.includes('imports') ? 'part' : null;
  });
}

void describe('quiet changes: the same import rule as Reduce noise', () => {
  const ts = (...extra: string[]) => text("import { alpha } from './x';", ...extra, '', 'run(alpha);');
  const go = (extra: string) => text('package a', '', 'import (', '\t"fmt"', ...(extra ? [extra] : []), ')', '', 'func F() { fmt.Println() }');
  const cases: [string, string, string][] = [
    ['src/a.ts', ts(), ts("import { beta } from './x';")],
    ['src/a.ts', text('import {', '  alpha,', "} from './x';", '', 'run(alpha);'), text('import {', '  alpha,', '  beta,', "} from './x';", '', 'run(alpha);')],
    ['a.go', go(''), go('\t"strings"')],
    ['src/a.rs', text('use crate::error::Result;', '', 'fn f() {}'), text('use crate::error::Result;', 'use crate::error::Failure;', '', 'fn f() {}')],
    ['src/A.java', text('package p;', 'import a.b.Alpha;', '', 'class A {}'), text('package p;', 'import a.b.Alpha;', 'import a.b.Beta;', '', 'class A {}')],
    ['src/a.ts', ts(), ts("import { beta } from './y';")],
    ['src/a.ts', ts(), ts("import { z } from 'zod';")],
    ['a.go', go(''), go('\t"github.com/acme/x"')],
    ['src/a.rs', text('use crate::error::Result;', '', 'fn f() {}'), text('use crate::error::Result;', 'use other::Thing;', '', 'fn f() {}')],
    ['src/a.ts', ts(), ts("import { beta as b } from './x';")],
    ['src/a.ts', ts(), ts("import type { Beta } from './x';")],
    ['src/index.ts', ts(), ts("import { beta } from './x';")],
    ['m.py', text('from .safe import read', '', 'read()'), text('from .safe import read', 'from .safe import open', '', 'read()')],
  ];
  void test('Changes quiets exactly the hunks layer 1 cuts as "import only", at both levels', async () => {
    for (const [path, before, after] of cases) {
      const quiet = await quietImports(path, before, after);
      const conservative = (await cuts(path, before, after, 'conservative')).map((reason) => (reason === 'import only' ? reason : null));
      const aggressive = (await cuts(path, before, after, 'aggressive')).map((reason) => (reason === 'import only' ? reason : null));
      assert.deepEqual(quiet, conservative, `${path}: ${after}`);
      assert.deepEqual(quiet, aggressive, `${path}: ${after}`);
    }
    assert.deepEqual(await quietImports(...cases[0]), ['import only'], 'The rule does quiet a widening');
  });
  void test('an import of a module or package the file did not import is never quiet: it is a new dependency', async () => {
    for (const line of ["import { z } from 'zod';", "import { beta } from './y';", "import gamma from 'gamma';"])
      assert.deepEqual(await quietImports('src/a.ts', ts(), ts(line)), [null], line);
    assert.deepEqual(await quietImports('a.go', go(''), go('\t"github.com/acme/x"')), [null]);
    assert.deepEqual(await quietImports('src/A.java', text('package p;', 'import a.b.Alpha;', '', 'class A {}'), text('package p;', 'import a.b.Alpha;', 'import c.d.Gamma;', '', 'class A {}')), [null]);
  });
  void test('round 1 of #512: an import with a tool directive in or after it is never quiet, nor cut', async () => {
    for (const line of [
      "import { beta } from './x'; // eslint-disable-line no-unused-vars",
      "import { beta } from './x'; // @ts-ignore",
      "import { beta } from './x'; /* biome-ignore lint: reason */",
      "import { beta } from './x'; // prettier-ignore",
    ]) {
      assert.deepEqual(await quietImports('src/a.ts', ts(), ts(line)), [null], line);
      assert.deepEqual(await cuts('src/a.ts', ts(), ts(line)), [null], line);
    }
    const multi = (...names: string[]) => text('import {', '  alpha,', ...names, "} from './x';", '', 'run(alpha);');
    assert.deepEqual(await quietImports('src/a.ts', multi(), multi('  beta, // eslint-disable-line')), [null], 'Inside a multi-line import');
    assert.deepEqual(await quietImports('src/a.ts', multi(), multi('  beta, // a note')), ['import only'], 'A plain comment is still prose');
  });
  void test('round 1 of #512: a value import from a module the file imported only as types is a new runtime dependency', async () => {
    const typed = (...extra: string[]) => text("import type { Alpha } from './x';", ...extra, '', 'let a: Alpha;');
    assert.deepEqual(await quietImports('src/a.ts', typed(), typed("import { beta } from './x';")), [null]);
    assert.deepEqual(await cuts('src/a.ts', typed(), typed("import { beta } from './x';")), [null]);
    const inline = (...extra: string[]) => text("import { type Alpha } from './x';", ...extra, '', 'let a: Alpha;');
    assert.deepEqual(await quietImports('src/a.ts', inline(), inline("import { beta } from './x';")), [null], 'Every specifier a type');
    const mixed = (...extra: string[]) => text("import { type Alpha, gamma } from './x';", ...extra, '', 'let a: Alpha = gamma;');
    assert.deepEqual(await quietImports('src/a.ts', mixed(), mixed("import { beta } from './x';")), ['import only'], 'A module that loads at run time');
  });
  void test('round 1 of #512: the rule reads GitHub’s hunks, so a view’s context lines never change what is quiet', async () => {
    const filler = ['const one = 1;', 'const two = 2;', 'const three = 3;', 'const four = 4;'];
    const before = text("import { alpha } from './x';", ...filler, 'run(alpha);');
    const after = text("import { alpha } from './x';", "import { beta } from './x';", ...filler, 'run(alpha, beta);');
    for (const context of [1, 3]) assert.deepEqual(await quietImports('src/a.ts', before, after, { context }), [null], `context ${context}`);
    assert.deepEqual(await cuts('src/a.ts', before, after), [null], 'Reduce noise keeps it too');
  });
  void test('fails closed: a mixed hunk, a parse error, a removal stay code', async () => {
    assert.deepEqual(await quietImports('src/a.ts', ts(), text("import { alpha } from './x';", "import { beta } from './x';", 'const extra = beta;', '', 'run(alpha);')), [null], 'An import with code beside it');
    assert.deepEqual(await quietImports('src/a.ts', text("import { alpha } from './x';", '', 'run(alpha'), text("import { alpha } from './x';", "import { beta } from './x';", '', 'run(alpha')), [null], 'A file that does not parse');
    assert.deepEqual(await quietImports('src/a.ts', ts("import { beta } from './x';"), ts()), [null], 'A removal');
  });
  void test('a topic’s few hunks read the file’s real old text: a name from a module another hunk adds stays shown', async () => {
    const filler = Array.from({ length: 10 }, (_, i) => `// note ${i}`);
    const before = text("import { alpha } from './x';", ...filler, '', 'run(alpha);');
    // The first hunk imports a new package; the second takes another name from it.
    const after = text("import { alpha } from './x';", "import { a } from 'pkg';", ...filler, "import { b } from 'pkg';", '', 'run(alpha);');
    assert.deepEqual(await quietImports('src/a.ts', before, after), [null, null], 'Changes: both are a new package');
    assert.deepEqual(await quietImports('src/a.ts', before, after, { pick: [1] }), [null], 'A topic of the second hunk alone');
    const widened = text("import { alpha } from './x';", ...filler, "import { beta } from './x';", '', 'run(alpha);');
    assert.deepEqual(await quietImports('src/a.ts', before, widened, { pick: [0] }), ['import only'], 'A topic quiets a real widening');
  });
  void test('perf: a large file with many import-only hunks stays instant', async () => {
    const modules = Array.from({ length: 300 }, (_, i) => `./m${i}`);
    const body = (i: number) => Array.from({ length: 6 }, (_, k) => `export const v${i}_${k} = use${i}(${k});`);
    const before = text(...modules.flatMap((m, i) => [`import { use${i} } from '${m}';`, ...body(i)]));
    const after = text(...modules.flatMap((m, i) => [`import { use${i} } from '${m}';`, `import { extra${i} } from '${m}';`, ...body(i)]));
    assert.deepEqual(await quietImports('src/many.ts', before, after), modules.map(() => 'import only'), 'Every widening is quiet');
    const hunks = patchHunks(structuredPatch('a', 'b', before, after, '', '', { context: 3 }).hunks.map((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines].join('\n')).join('\n')) ?? [];
    assert.equal(hunks.length, 300);
    // Both sides' import nodes come from the comparison's own trees: only the rule is added after it.
    const t0 = performance.now();
    const plain = await engine.noise('typescript', after, hunks);
    const t1 = performance.now();
    const result = await engine.noise('typescript', after, hunks, false, 'both');
    const t2 = performance.now();
    const blocks = await withImportBlocks(engine, 'typescript', { path: 'src/many.ts', patch: hunks }, result);
    const t3 = performance.now();
    assert.equal(blocks.filter((block) => block.kind === 'imports').length, plain.blocks.length);
    assertPerf('quiet imports: 300 import-only hunks, the rule after the comparison', t3 - t2, perfBudget(25));
    assertPerf('quiet imports: 300 import-only hunks, the comparison with import nodes', t2 - t1, perfBudget(800), {
      detail: `the comparison alone took ${Math.round(t1 - t0)} ms`,
    });
  });
});

void describe('rules: comments a tool reads', () => {
  void test('a Python docstring with a doctest is code; a plain docstring is a comment', async () => {
    const py = (doc: string[]) => text('def add(a, b):', '    """Adds two numbers.', ...doc, '    """', '    return a + b');
    assert.deepEqual(await cuts('m.py', py(['    >>> add(1, 2)', '    3']), py(['    >>> add(1, 2)', '    4'])), [null]);
    assert.deepEqual(await cuts('m.py', py(['    More words.']), py(['    Other words.'])), ['comments only']);
  });
  void test('every Rust doc comment is code, an indented rustdoc example too; a plain comment is not', async () => {
    const rs = (line: string) => text('/// Adds one.', '///', line, 'pub fn inc(x: u32) -> u32 { x + 1 }');
    assert.deepEqual(await cuts('src/a.rs', rs('///     assert_eq!(inc(1), 2);'), rs('///     assert_eq!(inc(2), 3);')), [null]);
    assert.deepEqual(await cuts('src/a.rs', text('/// Adds one.', 'pub fn inc(x: u32) -> u32 { x + 1 }'), text('/// Adds 1.', 'pub fn inc(x: u32) -> u32 { x + 1 }')), [null]);
    assert.deepEqual(await cuts('src/a.rs', text('//! The crate.', 'pub fn f() {}'), text('//! This crate.', 'pub fn f() {}')), [null]);
    assert.deepEqual(await cuts('src/a.rs', text('// Adds one.', 'pub fn inc(x: u32) -> u32 { x + 1 }'), text('// Adds 1.', 'pub fn inc(x: u32) -> u32 { x + 1 }')), ['comments only']);
  });
  void test('a cgo preamble is code', async () => {
    const go = (include: string) => text('package a', '', `// #include <${include}>`, 'import "C"', '', 'func F() {}');
    assert.deepEqual(await cuts('a.go', go('a.h'), go('b.h')), [null]);
    assert.deepEqual(await cuts('a.go', text('package a', '', '// F does a thing.', 'func F() {}'), text('package a', '', '// F does one thing.', 'func F() {}')), ['comments only']);
  });
  void test('a fenced example and a JSDoc type in a JavaScript file are code', async () => {
    const ts = (line: string) => text('/**', ' * ```ts', line, ' * ```', ' */', 'export function inc(x: number) { return x + 1; }');
    assert.deepEqual(await cuts('src/a.ts', ts(' * inc(1) === 2'), ts(' * inc(2) === 3')), [null]);
    const js = (type: string) => text('/**', ` * @param {${type}} name`, ' */', 'export function greet(name) { return name; }');
    assert.deepEqual(await cuts('src/a.js', js('string'), js('number')), [null]);
  });
  void test('the comment check reads the block around the line', () => {
    assert.equal(toolReadComment('a.ts', text('// plain', '// words'), 1), false);
    assert.equal(toolReadComment('a.ts', text('// ```', '// x()', '// ```'), 2), true);
    assert.equal(toolReadComment('a.ts', undefined, 1), true, 'No text: treated as read');
  });
});

void describe('rules: whitespace, formatting and comments', () => {
  void test('a hunk is quiet only when every block is', () => {
    assert.equal(quietReason(['whitespace']), 'whitespace');
    assert.equal(quietReason(['whitespace', 'formatting']), 'formatting');
    assert.equal(quietReason(['comments']), 'comments only');
    assert.equal(quietReason(['comments', 'formatting-comments']), 'formatting and comments');
    assert.equal(quietReason(['formatting', 'code']), undefined, 'A mixed hunk is kept');
    assert.equal(quietReason([]), undefined);
    assert.equal(quietReason(undefined), undefined);
  });
  void test('Off cuts nothing', () => {
    const h = hunk('@@ -1,1 +1,1 @@', ['-a( 1 );', '+a(1);']);
    assert.equal(ruleNoise([h], {}, {}, { kinds: new Map([['hunk-0', ['whitespace']]]), imports: new Map() }, 'off').size, 0);
  });
  void test('the syntax comparison classifies real hunks through the same engine as generation', async () => {
    const byId = new Map(loadFixtures().map((f) => [f.id, prepareFixture(f)]));
    const reason = async (id: string, file: string, level: 'conservative' | 'aggressive' = 'conservative') => {
      const prepared = byId.get(id);
      assert.ok(prepared);
      const cuts = await ruleCutsFor(engine, prepared, level);
      return prepared.hunks.filter((h) => h.filePath === file).map((h) => cuts.get(h.id) ?? null);
    };
    assert.deepEqual(await reason('whitespace-only', 'src/cache/config.ts'), ['whitespace', null]);
    assert.deepEqual(await reason('formatting-only', 'src/sync/report.ts'), ['formatting']);
    assert.deepEqual(await reason('comment-only', 'src/store.rs'), ['comments only', null]);
    assert.deepEqual(await reason('mixed-hunks', 'src/snapshots.rs'), [null], 'Formatting with a type change is kept');
    assert.deepEqual(await reason('mixed-hunks', 'src/flush.ts'), [null]);
  });
});

void test('options: Reduce noise defaults to Conservative and normalizes unknown values', () => {
  assert.equal(DEFAULT_EXPLANATION_PREFERENCES.reduceNoise, 'conservative');
  assert.equal(normalizeExplanationPreferences(null).reduceNoise, 'conservative');
  assert.equal(normalizeExplanationPreferences({ reduceNoise: 'aggressive' }).reduceNoise, 'aggressive');
  assert.equal(normalizeExplanationPreferences({ reduceNoise: 'off' }).reduceNoise, 'off');
  assert.equal(normalizeExplanationPreferences({ reduceNoise: 'everything' }).reduceNoise, 'conservative');
  assert.equal(normalizeExplanationOptions({ reduceNoise: 'off', fileOverrides: {} }).reduceNoise, 'off');
});

void describe('planner', () => {
  void test('the planner’s context lists the hunks the rules left out, so the index does not look incomplete', async () => {
    const fixture = loadFixtures().find((f) => f.id === 'formatting-only');
    assert.ok(fixture);
    const prepared = prepareFixture(fixture);
    const input = plannerInput(prepared, await ruleCutsFor(engine, prepared, 'conservative'), 'conservative');
    assert.match(input.context, /<left_out_hunks count="1">\nLeft out as noise, not shown: these hunks are not in the hunk index and need no topic\./);
    assert.match(input.context, /- src\/sync\/report\.ts:\d+-\d+ \(formatting\)\n<\/left_out_hunks>/);
    assert.doesNotMatch(input.hunkIndex, /src\/sync\/report\.ts/, 'The left-out hunk is not in the index');
    // When the rules would cut every hunk, the planner sees them all and no list.
    const everything = new Map(prepared.hunks.map((h) => [h.id, 'formatting']));
    const all = plannerInput(prepared, everything, 'conservative');
    assert.doesNotMatch(all.context, /left_out_hunks/);
    assert.match(all.hunkIndex, /src\/sync\/report\.ts/);
  });
  void test('the prompt adds the noise directive and schema field only when the level is on', () => {
    assert.ok(!plannerUserSuffix('off').includes('"noise"'));
    assert.equal(noisePlannerDirective('off'), '');
    for (const level of ['conservative', 'aggressive'] as const) {
      const suffix = plannerUserSuffix(level);
      assert.match(suffix, /"noise": \[\{ "hunkId": "hunk-7", "reason": string \}\]/);
      assert.match(suffix, /List a hunk only when all of it is noise/);
      assert.match(suffix, /When unsure, keep it/);
    }
    assert.match(plannerUserSuffix('conservative'), /Reduce noise: Conservative\. List only clear noise/);
    assert.match(plannerUserSuffix('conservative'), /Keep anything that could change behavior: logic, config values, dependency versions, public API or exports, SQL, and schema/);
    assert.doesNotMatch(plannerUserSuffix('conservative'), /Aggressive/);
    const aggressive = plannerUserSuffix('aggressive');
    assert.match(aggressive, /Reduce noise: Aggressive\. Also list edits with no runtime effect beyond the main change: renames, test data and fixtures that follow the main change, a field threaded through without changing any value, and doc or comment updates\./);
    assert.match(aggressive, /Never list a hunk that changes what the code does at runtime: any change to a value, condition, call, string handling or data flow is behavior, however small or off-topic\./);
    assert.match(aggressive, /never list dependency versions, public API or exports, SQL, or schema/);
    assert.doesNotMatch(aggressive, /small related edits|helper tweak/, 'No longer invites small behavior changes');
    assert.doesNotMatch(aggressive, /Conservative/);
  });
  void test('the planner output keeps its noise list, and Off drops it', async (t) => {
    const plan = {
      summary: 'S',
      riskLevel: 'low',
      storyArc: '',
      topics: [{ title: 'T', hunkIds: ['hunk-1'], dependsOn: [], order: 1 }],
      noise: [{ hunkId: 'hunk-0', reason: 'import only' }],
    };
    const prompts: string[] = [];
    t.mock.method(claudeProvider, 'generate', ({ content }: { content: string }) => (prompts.push(content), Promise.resolve(JSON.stringify(plan))));
    const on = await planReview('index', 'meta', 'claude', 'claude-sonnet-5-5' as never, undefined, false, undefined, undefined, 'conservative');
    assert.deepEqual(on.noise, plan.noise);
    assert.match(prompts[0], /Reduce noise: Conservative/);
    const off = await planReview('index', 'meta', 'claude', 'claude-sonnet-5-5' as never);
    assert.equal(off.noise, undefined);
    assert.doesNotMatch(prompts[1], /NOISE:/);
  });
  void test('the noise list keeps known hunks once, with a short reason', () => {
    const ids = new Set(['hunk-0', 'hunk-1']);
    assert.deepEqual(
      normalizePlannerNoise(
        [{ hunkId: 'hunk-0', reason: '  unused   import ' }, { hunkId: 'hunk-0', reason: 'again' }, { hunkId: 'hunk-9' }, { hunkId: 'hunk-1' }, 'x', null],
        ids
      ),
      [
        { hunkId: 'hunk-0', reason: 'unused import' },
        { hunkId: 'hunk-1', reason: 'not part of the main change' },
      ]
    );
    assert.deepEqual(normalizePlannerNoise({ hunkId: 'hunk-0' }, ids), []);
  });
});

void describe('routing', () => {
  const hunks = [0, 1, 2, 3].map((i) =>
    hunk(`@@ -${i * 10 + 1},1 +${i * 10 + 1},2 @@`, [` a${i}`, `+b${i}`], i === 3 ? 'src/b.ts' : 'src/a.ts', `hunk-${i}`)
  );
  const topic = (title: string, hunkIds: string[], dependsOn: string[] = []): TopicPlan =>
    ({ title, hunkIds, dependsOn, order: 1, slideType: 'feature', importance: 'important', narrativeBrief: '' }) as TopicPlan;
  const seen = new Set(['hunk-0', 'hunk-1', 'hunk-2', 'hunk-3']);
  void test('fail closed: a hunk the planner neither assigns nor lists stays for Other changes', () => {
    const { topics, cut } = applyNoise([topic('Main', ['hunk-0'])], hunks, new Map(), [{ hunkId: 'hunk-1', reason: 'typo' }], 'conservative', seen);
    assert.deepEqual([...cut.keys()], ['hunk-1']);
    const assigned = new Set([...topics.flatMap((t) => t.hunkIds), ...cut.keys()]);
    assert.deepEqual(hunks.filter((h) => !assigned.has(h.id)).map((h) => h.id), ['hunk-2', 'hunk-3'], 'Unlisted hunks go to Other changes');
  });
  void test('the planner cuts only hunks whose whole source was in its evidence', () => {
    const noise = [{ hunkId: 'hunk-1', reason: 'typo' }, { hunkId: 'hunk-2', reason: 'typo' }];
    const { cut } = applyNoise([topic('Main', ['hunk-0'])], hunks, new Map(), noise, 'aggressive', new Set(['hunk-1']));
    assert.deepEqual([...cut.keys()], ['hunk-1'], 'hunk-2 was sampled or missing: it stays');
    assert.equal(applyNoise([topic('Main', ['hunk-0'])], hunks, new Map(), noise, 'aggressive').cut.size, 0, 'No evidence, no planner cuts');
  });
  void test('when rules and planner together would cut every hunk, nothing is cut', () => {
    const { topics, cut, leftOut } = applyNoise(
      [topic('Main', ['hunk-0'])],
      hunks.slice(0, 3),
      new Map([['hunk-0', 'import only']]),
      [{ hunkId: 'hunk-1', reason: 'typo' }, { hunkId: 'hunk-2', reason: 'typo' }],
      'aggressive',
      seen
    );
    assert.equal(cut.size, 0);
    assert.deepEqual(leftOut, []);
    assert.deepEqual(topics[0].hunkIds, ['hunk-0']);
  });
  void test('a hunk both assigned and listed stays in its topic', () => {
    const { topics, cut } = applyNoise([topic('Main', ['hunk-0'])], hunks, new Map(), [{ hunkId: 'hunk-0', reason: 'noise' }], 'aggressive', seen);
    assert.equal(cut.size, 0);
    assert.deepEqual(topics[0].hunkIds, ['hunk-0']);
  });
  void test('a topic whose hunks are all cut disappears, and prerequisites on it are dropped', () => {
    const { topics, cut, leftOut } = applyNoise(
      [topic('Imports', ['hunk-2']), topic('Main', ['hunk-0', 'hunk-2'], ['Imports'])],
      hunks,
      new Map([['hunk-2', 'import only']]),
      undefined,
      'conservative'
    );
    assert.deepEqual(topics.map((t) => [t.title, t.hunkIds, t.dependsOn]), [['Main', ['hunk-0'], []]]);
    assert.deepEqual(cut.get('hunk-2'), { reason: 'import only', source: 'rules' });
    assert.deepEqual(leftOut, [{ filePath: 'src/a.ts', side: 'after', startLine: 22, endLine: 22, reason: 'import only', source: 'rules' }]);
  });
  void test('Off ignores rule cuts and the planner list', () => {
    const { topics, cut } = applyNoise([topic('Main', ['hunk-0'])], hunks, new Map([['hunk-0', 'x']]), [{ hunkId: 'hunk-1', reason: 'x' }], 'off');
    assert.equal(cut.size, 0);
    assert.deepEqual(topics[0].hunkIds, ['hunk-0']);
  });
  void test('a kept topic’s writer sees cut hunks in its own files as context only', () => {
    const cut = new Set(['hunk-1', 'hunk-3']);
    assert.deepEqual(contextOnlyHunks(['hunk-0'], hunks, cut).map((h) => h.id), ['hunk-1']);
    const diff = text('diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,2 @@', "+import { b } from './b';", ' a', '@@ -20,1 +21,2 @@', ' c', '+b();');
    const indexed = buildIndexedHunks(diff, {}, {});
    const map = new Map<string, IndexedHunk>(indexed.map((h) => [h.id, h]));
    const context = buildTopicContext(topic('Main', ['hunk-1']), map, {}, {}, {}, 'T', 'D', 'Arc', [], null, [indexed[0]]);
    assert.match(context, /<left_out_hunks>\nLeft out of the explanation as noise\. Use them only as context/);
    assert.match(context, /Do not explain or cite them/);
    assert.match(context, /--- src\/a\.ts \[hunk-0\]\n@@ -1,1 \+1,2 @@\n\+import \{ b \} from '\.\/b';/);
    assert.doesNotMatch(buildTopicContext(topic('Main', ['hunk-1']), map, {}, {}, {}, 'T', 'D', 'Arc', []), /left_out_hunks/);
  });
});

void describe('the left-out list', () => {
  void test('each entry names the changed lines, on the old side for a deletion', () => {
    assert.deepEqual(changedRange(hunk('@@ -10,4 +10,5 @@', [' a', '-b', '+c', '+d', ' e', ' f'])), { side: 'after', startLine: 11, endLine: 12 });
    assert.deepEqual(changedRange(hunk('@@ -10,3 +10,1 @@', [' a', '-b', '-c'])), { side: 'before', startLine: 11, endLine: 12 });
    assert.equal(leftOutLabel({ filePath: 'src/a.ts', startLine: 4, endLine: 9 }), 'src/a.ts:4-9');
    assert.equal(leftOutLabel({ filePath: 'src/a.ts', startLine: 4, endLine: 4 }), 'src/a.ts:4');
  });
  void test('a saved list is normalized', () => {
    assert.equal(normalizeNoiseReduction(null), undefined);
    assert.equal(normalizeNoiseReduction({ level: 'loud' }), undefined);
    assert.deepEqual(
      normalizeNoiseReduction({
        level: 'aggressive',
        defaultLevel: 'conservative',
        repository: 'o/r',
        leftOut: [{ filePath: 'a.ts', side: 'before', startLine: 3, endLine: 4, reason: ' typo ', source: 'planner' }, { filePath: 'b.ts', startLine: 'x' }],
      }),
      {
        level: 'aggressive',
        defaultLevel: 'conservative',
        repository: 'o/r',
        leftOut: [{ filePath: 'a.ts', side: 'before', startLine: 3, endLine: 4, reason: 'typo', source: 'planner' }],
      }
    );
  });
  void test('an explanation that followed the repository’s level is out of date when the level changes', () => {
    const prefs = { repositorySettings: { 'o/r': { explanation: { reduceNoise: 'aggressive' as const } } }, localExplanationPreferences: { 'local:/p': { reduceNoise: 'off' as const } } };
    assert.equal(savedNoiseLevel(prefs, 'o/r'), 'aggressive');
    assert.equal(savedNoiseLevel(prefs, 'local:/p'), 'off');
    assert.equal(savedNoiseLevel(prefs, 'other/repo'), 'conservative');
    const followed = { level: 'conservative' as const, defaultLevel: 'conservative' as const, leftOut: [] };
    assert.equal(noiseLevelChanged(followed, 'aggressive'), true);
    assert.equal(noiseLevelChanged(followed, 'conservative'), false);
    assert.equal(noiseLevelChanged({ ...followed, level: 'off' }, 'aggressive'), false, 'A level chosen for one explanation is not out of date');
    assert.equal(noiseLevelChanged({ level: 'off', leftOut: [] }, 'aggressive'), false, 'Older explanations are not flagged');
  });
});

void describe('the eval runner', () => {
  void test('replay scores the rules on every fixture and cuts no essential hunk', async () => {
    const fixtures = loadFixtures();
    assert.ok(fixtures.length >= 20);
    const result = await replay(fixtures);
    // A recording made with an older planner prompt only warns here, so a prompt change doesn't block every PR.
    // `npm run explanation-noise-eval` stays strict; re-record with --live when planner prompts change materially.
    if (result.stale.length)
      console.warn(`[explanation-noise] ${result.stale.length} stale recording(s); run the live eval again:\n  ${result.stale.join('\n  ')}`);
    const cut = result.scores.flatMap((s) => s.wrong.filter((w) => w.failure));
    assert.deepEqual(cut, [], 'No recorded or rule cut removes an essential hunk');
    const rules = result.scores.filter((s) => s.layer === 'rules');
    assert.equal(rules.length, 2);
    for (const s of rules) {
      assert.equal(s.wrong.length, 0);
      assert.ok(s.cuts > 0);
    }
    if (!fs.existsSync(path.join(FIXTURES, 'recorded')))
      assert.deepEqual(result.unrecorded.map((u) => u.level), ['conservative', 'aggressive'], 'Layer 2 reports "not recorded"');
  });
  void test('a live run writes each level’s recording and manifest entry together, and a mixed manifest fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noise-eval-'));
    try {
      const fixture = loadFixtures().find((f) => f.id === 'config-value');
      assert.ok(fixture);
      const prepared = prepareFixture(fixture);
      const input = plannerInput(prepared, await ruleCutsFor(engine, prepared, 'conservative'), 'conservative');
      const plan = { summary: '', riskLevel: 'low' as const, riskRationale: '', storyArc: '', topics: [] };
      const record = { recordedAt: '', provider: 'claude', model: 'claude-sonnet-5-5', fixtureHash: fixtureHash(fixture) };
      commitRecording('conservative', fixture.id, plan, record, { promptHash: promptHash('conservative'), evidenceHash: input.evidenceHash, options: input.options }, root);
      assert.deepEqual(fs.readdirSync(path.join(root, 'recorded')).sort(), ['conservative', 'manifest.json'], 'No temporary files left');
      const written = JSON.parse(fs.readFileSync(path.join(root, 'recorded', 'conservative', `${fixture.id}.json`), 'utf8')) as Record<string, unknown>;
      assert.equal(written.model, 'claude-sonnet-5-5');
      assert.deepEqual((await replay([fixture], root)).stale, []);
      // Another fixture recorded with another model: the set mixes models.
      const other = loadFixtures().find((f) => f.id === 'move');
      assert.ok(other);
      commitRecording('conservative', other.id, plan, { ...record, model: 'claude-opus-5-5', fixtureHash: fixtureHash(other) }, { promptHash: promptHash('conservative'), evidenceHash: 'x', options: {} }, root);
      assert.match((await replay([fixture], root)).stale.join('\n'), /the manifest mixes providers or models/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  void test('a recorded planner answer that cuts an essential hunk fails the run', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noise-eval-'));
    try {
      const fixture = loadFixtures().find((f) => f.id === 'drive-by-edits');
      assert.ok(fixture);
      const prepared = prepareFixture(fixture);
      const essential = prepared.hunks.find((h) => prepared.labels.get(h.id)?.label === 'essential');
      assert.ok(essential);
      writeRecorded('conservative', fixture.id, { summary: '', riskLevel: 'low', riskRationale: '', storyArc: '', topics: [], noise: [{ hunkId: essential.id, reason: 'looks like config churn' }] }, root);
      // No manifest: the recording is stale, and the run fails on that alone.
      let result = await replay([fixture], root);
      assert.equal(result.failed, true);
      assert.match(result.stale.join('\n'), /conservative\/drive-by-edits: recorded, but there is no manifest/);
      // A matching manifest entry: the run fails on the essential hunk the planner cut.
      const engine = noiseEngine();
      const input = plannerInput(prepared, await ruleCutsFor(engine, prepared, 'conservative'), 'conservative');
      writeManifest(
        {
          fixtures: {
            [fixture.id]: {
              recordedAt: '',
              provider: 'claude',
              model: 'claude-opus-5-5',
              fixtureHash: fixtureHash(fixture),
              levels: { conservative: { promptHash: promptHash('conservative'), evidenceHash: input.evidenceHash, options: input.options } },
            },
          },
        },
        root
      );
      result = await replay([fixture], root);
      assert.deepEqual(result.stale, []);
      assert.equal(result.failed, true);
      const wrong = result.scores.find((s) => s.level === 'conservative' && s.layer === 'rules+planner')?.wrong;
      assert.deepEqual(wrong?.map((w) => [w.fixture, w.hunk, w.failure, w.layer]), [['drive-by-edits', essential.id, true, 'planner']]);
      assert.deepEqual(result.unrecorded, [{ level: 'aggressive', missing: ['drive-by-edits'] }]);
      // A changed fixture makes its recording stale.
      const changed = { ...fixture, description: fixture.description + ' Changed.' };
      assert.match((await replay([changed], root)).stale.join('\n'), /the fixture changed/);
      // A recording made with another model than its manifest entry says.
      const file = path.join(root, 'recorded', 'conservative', `${fixture.id}.json`);
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(file, JSON.stringify({ ...saved, provider: 'codex', model: 'gpt-6.2-sol' }));
      assert.match((await replay([fixture], root)).stale.join('\n'), /recorded with codex\/gpt-6\.2-sol, the manifest says claude\/claude-opus-5-5/);
      // A manifest entry whose recording is gone.
      fs.rmSync(file);
      const gone = await replay([fixture], root);
      assert.equal(gone.failed, true);
      assert.match(gone.stale.join('\n'), /conservative\/drive-by-edits: the manifest has an entry but no recording/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
