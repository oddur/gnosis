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
} from '../lib/explanation-noise';
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

void describe('rules: imports', () => {
  const before = text("import { a } from './x';", "import fs from 'node:fs';", '', 'run(a);');
  void test('an import widened from a module the file already imports is cut at every level', async () => {
    const after = text("import { a, b } from './x';", "import fs from 'node:fs';", '', 'run(a);');
    assert.deepEqual(await cuts('src/a.ts', before, after), ['import only']);
    assert.deepEqual(await cuts('src/a.ts', before, after, 'aggressive'), ['import only']);
  });
  void test('an import of a package the file never imported is kept at Conservative and cut at Aggressive', async () => {
    const after = text("import { a } from './x';", "import pLimit from 'p-limit';", "import fs from 'node:fs';", '', 'run(a);');
    assert.deepEqual(await cuts('src/a.ts', before, after), [null]);
    assert.match((await cuts('src/a.ts', before, after, 'aggressive'))[0] ?? '', /new dependency: p-limit/);
  });
  void test('multi-line imports, Rust use, Go blocks and Python parentheses are imports', async () => {
    assert.deepEqual(
      await cuts('src/a.ts', text('import {', '  a,', "} from './x';", '', 'run(a);'), text('import {', '  a,', '  b,', "} from './x';", '', 'run(a);')),
      ['import only']
    );
    assert.deepEqual(await cuts('src/a.rs', text('use crate::error::Result;', 'fn f() {}'), text('use crate::error::{Error, Result};', 'fn f() {}')), ['import only']);
    const go = (extra: string) => text('package a', '', 'import (', '\t"fmt"', ...(extra ? [extra] : []), ')', '', 'func F() { fmt.Println() }');
    assert.deepEqual(await cuts('a.go', go(''), go('\t"strings"')), ['import only'], 'A standard-library package is not a dependency');
    assert.deepEqual(await cuts('a.go', go(''), go('\t"github.com/acme/x"')), [null], 'A new module is a new dependency');
    assert.deepEqual(
      await cuts('a.py', text('from x import (', '    a,', ')', '', 'a()'), text('from x import (', '    a,', '    b,', ')', '', 'a()')),
      ['import only']
    );
  });
  void test('exports and re-exports are public API, never import-only', async () => {
    assert.deepEqual(await cuts('src/api.ts', text("export { a } from './a';"), text("export { a } from './a';", "export { b } from './b';")), [null]);
    assert.deepEqual(await cuts('src/a.rs', text('pub use a::A;', 'fn f() {}'), text('pub use a::A;', 'pub use b::B;', 'fn f() {}')), [null]);
  });
  void test('side-effect imports are never import-only, added or removed, at any level', async () => {
    const ts = (extra: string[]) => text("import { a } from './x';", ...extra, '', 'run(a);');
    assert.deepEqual(await cuts('src/a.ts', ts([]), ts(["import './polyfill';"]), 'aggressive'), [null]);
    assert.deepEqual(await cuts('src/a.ts', ts(["import './polyfill';"]), ts([]), 'aggressive'), [null]);
    const go = (extra: string) => text('package a', '', 'import (', '\t"fmt"', ...(extra ? [extra] : []), ')', '', 'func F() { fmt.Println() }');
    assert.deepEqual(await cuts('a.go', go(''), go('\t_ "embed"'), 'aggressive'), [null]);
    assert.deepEqual(await cuts('a.go', go(''), go('\t. "strings"'), 'aggressive'), [null]);
    assert.deepEqual(await cuts('a.py', text('import os', '', 'os.getcwd()'), text('import os', 'import plugins', '', 'os.getcwd()'), 'aggressive'), [null]);
    assert.deepEqual(
      await cuts('a.py', text('import os', '', 'os.getcwd()'), text('from __future__ import annotations', 'import os', '', 'os.getcwd()'), 'aggressive'),
      [null]
    );
  });
  void test('rebinding a name, or the same import under another name, is never import-only', async () => {
    const ts = (line: string) => text(line, '', 'parse(input);');
    assert.deepEqual(await cuts('src/a.ts', ts("import { strictParse as parse } from './p';"), ts("import { looseParse as parse } from './p';"), 'aggressive'), [null]);
    assert.deepEqual(await cuts('src/a.ts', ts("import { parse as p } from './p';"), ts("import { parse as q } from './p';"), 'aggressive'), [null]);
    assert.deepEqual(await cuts('src/a.ts', ts("import { parse } from './p';"), ts("import { parse } from './q';"), 'aggressive'), [null]);
    assert.deepEqual(await cuts('a.py', text('from p import strict as parse', '', 'parse()'), text('from p import loose as parse', '', 'parse()'), 'aggressive'), [null]);
  });
  void test('imports in a package’s entry file are its API', async () => {
    const widened = [text("import { a } from './x';", '', 'run(a);'), text("import { a, b } from './x';", '', 'run(a);')] as const;
    for (const path of ['src/index.ts', 'lib/index.js']) assert.deepEqual(await cuts(path, ...widened), [null], path);
    assert.deepEqual(await cuts('pkg/__init__.py', text('from .a import A', '', 'x = 1'), text('from .a import A, B', '', 'x = 1')), [null]);
    for (const path of ['src/lib.rs', 'src/net/mod.rs'])
      assert.deepEqual(await cuts(path, text('use a::A;', 'fn f() {}'), text('use a::{A, B};', 'fn f() {}')), [null], path);
  });
  void test('a statement after an import on the same line keeps the hunk', async () => {
    assert.deepEqual(await cuts('a.py', text('from x import a', '', 'a()'), text('from x import a, b; setup(debug=True)', '', 'a()'), 'aggressive'), [null]);
    assert.deepEqual(await cuts('src/a.ts', before, text("import { a, b } from './x'; run(b);", "import fs from 'node:fs';", '', 'run(a);'), 'aggressive'), [null]);
  });
  void test('import lines inside a template literal are not imports', async () => {
    const ts = (extra: string[]) => text('const example = `', "import { a } from './x';", ...extra, '`;', 'show(example);');
    assert.deepEqual(await cuts('src/a.ts', ts([]), ts(["import { b } from './y';"]), 'aggressive'), [null]);
  });
  void test('a hunk with an import and code is kept; a dynamic import is code', async () => {
    assert.deepEqual(await cuts('src/a.ts', text("import { a } from './x';"), text("import { a } from './x';", 'run(a);'), 'aggressive'), [null]);
    assert.deepEqual(await cuts('src/a.ts', text('run();'), text("const { default: Zip } = await import('zip-lib');", 'run();'), 'aggressive'), [null]);
  });
  void test('no grammar, no import cut: MDX, CSS, and added files', async () => {
    assert.deepEqual(
      await cuts('docs/a.mdx', text('---', 'title: A', '---', '', '# A'), text('---', 'title: A', '---', "import Tabs from '@theme/Tabs';", '', '# A'), 'aggressive'),
      [null]
    );
    assert.deepEqual(await cuts('src/a.scss', text('.a { color: red; }'), text("@use 'theme' with ($primary: blue);", '.a { color: red; }'), 'aggressive'), [null]);
    assert.deepEqual(await cuts('src/new.ts', null, text("import { a } from './x';"), 'aggressive'), [null]);
  });
});

void describe('rules: comments a tool reads', () => {
  void test('a Python docstring with a doctest is code; a plain docstring is a comment', async () => {
    const py = (doc: string[]) => text('def add(a, b):', '    """Adds two numbers.', ...doc, '    """', '    return a + b');
    assert.deepEqual(await cuts('m.py', py(['    >>> add(1, 2)', '    3']), py(['    >>> add(1, 2)', '    4'])), [null]);
    assert.deepEqual(await cuts('m.py', py(['    More words.']), py(['    Other words.'])), ['comments only']);
  });
  void test('a Rust doc comment with a fenced example is code', async () => {
    const rs = (line: string) => text('/// Adds one.', '///', '/// ```', line, '/// ```', 'pub fn inc(x: u32) -> u32 { x + 1 }');
    assert.deepEqual(await cuts('src/a.rs', rs('/// assert_eq!(inc(1), 2);'), rs('/// assert_eq!(inc(2), 3);')), [null]);
    assert.deepEqual(
      await cuts('src/a.rs', text('/// Adds one.', 'pub fn inc(x: u32) -> u32 { x + 1 }'), text('/// Adds 1.', 'pub fn inc(x: u32) -> u32 { x + 1 }')),
      ['comments only']
    );
  });
  void test('a JSDoc type in a JavaScript file is code', async () => {
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
    assert.match(plannerUserSuffix('aggressive'), /Reduce noise: Aggressive\. Also list small related edits/);
    assert.match(plannerUserSuffix('aggressive'), /Never list a hunk that changes behavior/);
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
    assert.equal(result.failed, false, JSON.stringify(result.scores.flatMap((s) => s.wrong)));
    const rules = result.scores.filter((s) => s.layer === 'rules');
    assert.equal(rules.length, 2);
    for (const s of rules) {
      assert.equal(s.wrong.length, 0);
      assert.ok(s.cuts > 0);
    }
    if (!fs.existsSync(path.join(FIXTURES, 'recorded')))
      assert.deepEqual(result.unrecorded.map((u) => u.level), ['conservative', 'aggressive'], 'Layer 2 reports "not recorded"');
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
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
