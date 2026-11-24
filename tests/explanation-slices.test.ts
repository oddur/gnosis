// Focused explanation sections (#565): large hunks sliced by definition, and moves linked across slices
// (lib/explanation-slices.ts, #561), with the real grammars.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { createTwoFilesPatch } from 'diff';
import * as TreeSitter from 'web-tree-sitter';
import { buildIndexedHunks } from '../lib/diff-parse';
import {
  SLICE_MIN_CHANGED,
  coversExactly,
  filePrints,
  linkMoves,
  sliceFile,
  sliceMoves,
  slicePr,
  sliceRequests,
  triviaLines,
  type HunkSlice,
  type HunkSlices,
  type SliceFile,
} from '../lib/explanation-slices';
import type { MoveEnd, SymbolMove } from '../lib/moved-symbols';
import { createSyntaxEngine, type SyntaxLanguage } from '../lib/syntax-scope';
import { createConflictCheckWorker } from '../src/conflict-checks';
import {
  DELETED_ONLY,
  MOVED_EDITED,
  MOVED_IDENTICAL,
  drainFile,
  drainFileWithEditedRequeue,
  queueAfter,
  queueBefore,
  storeFile,
} from './fixtures/explanation-slices/fixtures';

const assets = path.resolve(__dirname, '../src/assets/tree-sitter');
const engine = createSyntaxEngine(TreeSitter, {
  runtime: async () => new Uint8Array(await fs.readFile(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))),
  grammar: async (language) => new Uint8Array(await fs.readFile(path.join(assets, `${language}.wasm`))),
  tags: (name) => fs.readFile(path.join(assets, `${name}-tags.scm`), 'utf8'),
});

interface Change {
  path: string;
  /** Undefined for an added file. */
  before?: string;
  after: string;
}
/** A git diff of the changes. Modified files come first: the diff parser carries an added file's status forward. */
function gitDiff(changes: readonly Change[]) {
  return [...changes]
    .sort((a, b) => Number(a.before === undefined) - Number(b.before === undefined))
    .map(({ path: file, before, after }) => {
      const patch = createTwoFilesPatch(
        before === undefined ? '/dev/null' : `a/${file}`,
        `b/${file}`,
        before ?? '',
        after,
        undefined,
        undefined,
        { context: 3 }
      );
      const body = patch.split('\n').filter((line) => !line.startsWith('Index:') && !line.startsWith('===='));
      return [
        `diff --git a/${file} b/${file}`,
        ...(before === undefined ? ['new file mode 100644'] : []),
        ...body,
      ].join('\n');
    })
    .join('\n');
}
/**
 * The worker's files for the changes, as the explanation builds them from its indexed hunks. `alsoChanged`: files the
 * PR changes that the explanation leaves out (filtered, generated, without a patch).
 */
function requests(changes: readonly Change[], alsoChanged: readonly string[] = []): SliceFile[] {
  const before: Record<string, string> = {},
    after: Record<string, string> = {};
  for (const change of changes) {
    if (change.before !== undefined) before[change.path] = change.before;
    after[change.path] = change.after;
  }
  const changed = [
    ...changes.map((c) => ({
      filename: c.path,
      status: c.before === undefined ? ('added' as const) : ('modified' as const),
    })),
    ...alsoChanged.map((filename) => ({ filename, status: 'modified' as const })),
  ];
  return sliceRequests(changed, buildIndexedHunks(gitDiff(changes), before, after), before, after);
}
/** The PR's slices, each file read in turn and the moves matched, as the worker does it, without the worker. */
function slices(files: readonly SliceFile[], disabled: SyntaxLanguage[] = []): Promise<HunkSlices[]> {
  return slicePr(
    files,
    (file) => sliceFile(engine, file, disabled),
    (file) => filePrints(engine, file, disabled),
    (candidates) => Promise.resolve(sliceMoves(candidates))
  );
}
const hunkOf = (files: readonly SliceFile[], id: string) => {
  const hunk = files.flatMap((file) => file.hunks).find((h) => h.id === id);
  assert.ok(hunk, id);
  return hunk;
};
const ofFile = (sliced: readonly HunkSlices[], file: string) => {
  const found = sliced.filter((hunk) => hunk.filePath === file);
  assert.equal(found.length, 1, `${file} has one hunk`);
  return found[0];
};
/** Each changed line of every hunk is in exactly one slice, and the counts add up to the hunk's. */
function assertCovered(files: readonly SliceFile[], sliced: readonly HunkSlices[]) {
  for (const hunk of sliced) {
    const source = hunkOf(files, hunk.hunkId);
    assert.ok(coversExactly(source, hunk.slices), `${hunk.filePath} is covered exactly`);
    const lines = source.content.split('\n');
    const count = (marker: string) => lines.filter((line) => line.startsWith(marker)).length;
    assert.equal(
      hunk.slices.reduce((n, s) => n + s.additions, 0),
      count('+')
    );
    assert.equal(
      hunk.slices.reduce((n, s) => n + s.deletions, 0),
      count('-')
    );
    for (const slice of hunk.slices) assert.ok(slice.id.startsWith(`${hunk.hunkId}:`), slice.id);
    assert.equal(new Set(hunk.slices.map((s) => s.id)).size, hunk.slices.length, 'slice IDs are unique');
  }
}

const seedChanges = (): Change[] => [
  { path: 'src/queue.rs', before: queueBefore(), after: queueAfter() },
  { path: 'src/drain.rs', after: drainFileWithEditedRequeue() },
];

void describe('a Rust PR shaped like klanggames/seed#38134', () => {
  void test('the new file splits into its struct, each method and each test', async () => {
    const files = requests(seedChanges());
    const sliced = await slices(files);
    assertCovered(files, sliced);
    const drain = ofFile(sliced, 'src/drain.rs');
    assert.equal(drain.whole, undefined);
    const drainLines = files.find((f) => f.path === 'src/drain.rs')?.head?.split('\n').length ?? 0;
    assert.ok(drainLines > 950, `the new file has about 1,000 lines (${drainLines})`);
    const labels = drain.slices.map((s) => s.label);
    // Imports and the constant are tiny neighbours: one slice.
    assert.match(labels[0], /^use std::collections::VecDeque;.*const MAX_BATCH/);
    assert.equal(labels[1], 'struct EntityDrainState');
    assert.equal(labels.filter((l) => l.endsWith('(impl EntityDrainState)')).length, 20);
    assert.ok(labels.includes('fn supersede (impl EntityDrainState)'));
    assert.equal(labels.filter((l) => /^fn drains_case_\d+ \(mod tests\)$/.test(l)).length, 26);
    for (const slice of drain.slices) assert.ok(slice.additions <= 150, `${slice.label} is at most 150 lines`);
    // Every line of the new file is in one slice.
    const seen = new Array<number>(drainLines).fill(0);
    for (const slice of drain.slices)
      for (const range of slice.newLines) for (let l = range.start; l <= range.end; l++) seen[l - 1]++;
    assert.ok(seen.slice(0, drainLines - 1).every((n) => n === 1));
    // The tests module's own lines (its attribute, `use super::*;`, its closing brace) are a part of it.
    assert.ok(labels.includes('mod tests (part)'));
  });

  void test('the deletion splits by method, and moved methods link to their new copies', async () => {
    const files = requests(seedChanges());
    const sliced = await slices(files);
    const queue = ofFile(sliced, 'src/queue.rs');
    const drain = ofFile(sliced, 'src/drain.rs');
    assert.equal(queue.whole, undefined);
    assert.deepEqual(
      queue.slices.map((s) => s.label),
      [...MOVED_IDENTICAL, MOVED_EDITED, ...DELETED_ONLY].map((name) => `fn ${name} (impl Queue)`)
    );
    const byLabel = (hunk: HunkSlices, label: string) => {
      const slice = hunk.slices.find((s) => s.label === label);
      assert.ok(slice, label);
      return slice;
    };
    for (const name of [...MOVED_IDENTICAL, MOVED_EDITED]) {
      const from = byLabel(queue, `fn ${name} (impl Queue)`);
      const to = byLabel(drain, `fn ${name} (impl EntityDrainState)`);
      const body = name === MOVED_EDITED ? 'edited' : 'identical';
      assert.equal(from.movedTo, to.id, name);
      assert.equal(to.movedFrom, from.id, name);
      assert.equal(from.moveBody, body, name);
      assert.equal(to.moveBody, body, name);
    }
    for (const name of DELETED_ONLY) {
      const slice = byLabel(queue, `fn ${name} (impl Queue)`);
      assert.equal(slice.movedTo, undefined, `${name} is only deleted`);
    }
    assert.equal(drain.slices.filter((s) => s.movedFrom).length, 3);
  });

  void test('a family with a file left unread links no move: an unproven pair stays ordinary', async () => {
    const files = requests([
      ...seedChanges(),
      { path: 'src/other.rs', after: `fn other() {}\n${'// x\n'.repeat(90)}` },
    ]);
    const sliced = await slicePr(
      files,
      (file) => (file.path === 'src/other.rs' ? Promise.resolve(undefined) : sliceFile(engine, file)),
      (file) => filePrints(engine, file),
      (candidates) => Promise.resolve(sliceMoves(candidates))
    );
    assert.equal(ofFile(sliced, 'src/other.rs').whole, 'timeout');
    assert.ok(sliced.every((hunk) => hunk.slices.every((s) => !s.movedTo && !s.movedFrom)));
  });

  void test("a file the explanation leaves out refuses its family's moves", async () => {
    // A generated or filtered Rust file the PR changes: it has no hunks here, so it is unread, and could hold a rival.
    const files = requests(seedChanges(), ['src/generated.rs']);
    assert.deepEqual(
      files.map((f) => [f.path, f.hunks.length]),
      [
        ['src/queue.rs', 1],
        ['src/drain.rs', 1],
        ['src/generated.rs', 0],
      ]
    );
    const sliced = await slices(files);
    assert.ok(sliced.every((hunk) => hunk.slices.every((s) => !s.movedTo && !s.movedFrom)));
    assert.equal(ofFile(sliced, 'src/drain.rs').whole, undefined, 'the slices stay');
  });

  void test('a slow fingerprint keeps the slices read, and no more jobs are sent after it', async () => {
    const files = requests(seedChanges());
    const jobs: string[] = [];
    const sliced = await slicePr(
      files,
      (file) => {
        jobs.push(`slices ${file.path}`);
        return sliceFile(engine, file);
      },
      (file) => {
        jobs.push(`prints ${file.path}`);
        return Promise.resolve(undefined);
      },
      () => {
        jobs.push('moves');
        return Promise.resolve([]);
      }
    );
    assert.deepEqual(jobs, ['slices src/queue.rs', 'prints src/queue.rs']);
    assert.equal(ofFile(sliced, 'src/queue.rs').whole, undefined, "the first file's slices stay");
    assert.ok(ofFile(sliced, 'src/queue.rs').slices.length > 1);
    assert.equal(ofFile(sliced, 'src/drain.rs').whole, 'timeout', 'the file after it is not sent');
    assertCovered(files, sliced);
  });

  void test('slice IDs are stable, and editing one method changes only its own', async () => {
    const files = requests(seedChanges());
    const first = await slices(files);
    const again = await slices(requests(seedChanges()));
    assert.deepEqual(
      again.map((h) => h.slices.map((s) => s.id)),
      first.map((h) => h.slices.map((s) => s.id))
    );
    const edited = drainFile().replace(/(pub fn claim_batch[^\n]*\n[^\n]*)wrapping_add/, '$1saturating_add');
    assert.notEqual(edited, drainFile());
    const changed = await slices(requests([{ path: 'src/drain.rs', after: edited }]));
    const original = await slices(requests([{ path: 'src/drain.rs', after: drainFile() }]));
    const ids = (sliced: HunkSlices[]) => new Map(ofFile(sliced, 'src/drain.rs').slices.map((s) => [s.label, s.id]));
    const before = ids(original),
      after = ids(changed);
    assert.equal(after.size, before.size);
    for (const [label, id] of before) {
      if (label === 'fn claim_batch (impl EntityDrainState)') assert.notEqual(after.get(label), id);
      else assert.equal(after.get(label), id, label);
    }
  });
});

void describe('slicing other files', () => {
  void test('a TypeScript file splits into its class methods and merged small items', async () => {
    const files = requests([{ path: 'src/store.ts', after: storeFile() }]);
    const sliced = await slices(files);
    assertCovered(files, sliced);
    const store = ofFile(sliced, 'src/store.ts');
    assert.equal(store.whole, undefined);
    const labels = store.slices.map((s) => s.label);
    assert.match(labels[0], /^import \{ readFile \}.*interface StoreOptions$/);
    assert.ok(labels.includes('save() (class Store)'));
    assert.equal(labels.filter((l) => l.endsWith('(class Store)')).length, 12);
    // The class's own lines (its header and fields) are a part of it, not the first method's.
    assert.ok(labels.includes('class Store (part)'));
    assert.equal(labels.at(-1), 'function openStore(), function storeSize()');
  });

  void test('a file with no grammar keeps its whole hunk', async () => {
    const markdown = Array.from({ length: 120 }, (_, i) => (i % 10 ? `Line ${i} of the guide.` : `## Part ${i}`)).join(
      '\n'
    );
    const files = requests([{ path: 'docs/guide.md', after: `${markdown}\n` }]);
    const sliced = await slices(files);
    assertCovered(files, sliced);
    const guide = ofFile(sliced, 'docs/guide.md');
    assert.equal(guide.whole, 'no-grammar');
    assert.equal(guide.slices.length, 1);
    assert.equal(guide.slices[0].additions, 120);
  });

  void test('a parse error in the hunk keeps it whole', async () => {
    const broken = storeFile().replace(
      '  load(input: number[], limit: number): number {',
      '  load(input: number[], limit: number): number {{ ) =>'
    );
    const files = requests([{ path: 'src/store.ts', after: broken }]);
    const sliced = await slices(files);
    assertCovered(files, sliced);
    assert.equal(ofFile(sliced, 'src/store.ts').whole, 'parse-error');
    assert.equal(ofFile(sliced, 'src/store.ts').slices.length, 1);
  });

  void test(`a hunk of ${SLICE_MIN_CHANGED} changed lines or fewer keeps it whole`, async () => {
    const before = queueAfter();
    const after = before.replace('Mode::Slow => total_len_hint', 'Mode::Slow => total_len_hint + 1');
    assert.notEqual(after, before);
    const files = requests([{ path: 'src/queue.rs', before, after }]);
    const sliced = await slices(files);
    assertCovered(files, sliced);
    const queue = ofFile(sliced, 'src/queue.rs');
    assert.equal(queue.whole, 'small');
    assert.equal(queue.slices.length, 1);
    // The impl holds the change and fits in 150 lines: it is the unit, not the method inside it.
    assert.equal(queue.slices[0].label, 'impl Queue');
    assert.deepEqual(
      queue.slices[0].symbols.map((s) => s.side),
      ['before', 'after']
    );
  });

  void test('a language turned off in Code intelligence keeps whole hunks', async () => {
    const files = requests([{ path: 'src/drain.rs', after: drainFile() }]);
    const sliced = await slices(files, ['rust']);
    assert.equal(ofFile(sliced, 'src/drain.rs').whole, 'off');
    assertCovered(files, sliced);
  });

  void test('a text that does not match its hunk keeps it whole', async () => {
    const [file] = requests([{ path: 'src/drain.rs', after: drainFile() }]);
    const answer = await sliceFile(engine, { ...file, head: drainFile().replace('supersede', 'replaced') });
    assert.equal(answer[0].whole, 'failed');
    assert.ok(coversExactly(file.hunks[0], answer[0].slices));
  });

  void test('coverage fails when a changed line is in two slices or in none', () => {
    const [file] = requests([{ path: 'docs/a.md', after: 'a\nb\nc\n' }]);
    const hunk = file.hunks[0];
    const slice = (start: number, end: number) => ({
      id: 'x',
      label: '',
      symbols: [],
      lines: [{ start, end }],
      oldLines: [],
      newLines: [],
      removed: [],
      added: [],
      additions: 0,
      deletions: 0,
    });
    assert.ok(coversExactly(hunk, [slice(0, 0), slice(1, 2)]));
    assert.ok(!coversExactly(hunk, [slice(0, 1), slice(1, 2)]));
    assert.ok(!coversExactly(hunk, [slice(0, 1)]));
    assert.ok(!coversExactly(hunk, [slice(0, 2), slice(3, 3)]));
  });
});

void test('the worker: a file it does not answer for keeps whole hunks', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-slices-worker-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // A worker that never answers: every job runs out of time.
  const script = path.join(dir, 'silent-worker.mjs');
  await fs.writeFile(
    script,
    "import { parentPort } from 'node:worker_threads';\nparentPort.on('message', () => {});\n"
  );
  const worker = createConflictCheckWorker(script, () => ({ runtime: '', grammars: '' }), 1_000, 50);
  t.after(() => worker.dispose());
  const files = requests(seedChanges());
  const sliced = await worker.slices(files);
  assert.deepEqual(
    sliced.map((hunk) => [hunk.filePath, hunk.whole, hunk.slices.length]),
    [
      ['src/queue.rs', 'timeout', 1],
      ['src/drain.rs', 'timeout', 1],
    ]
  );
  assertCovered(files, sliced);
});

void describe('moves and labels', () => {
  const nestedOuter = () => {
    const lines = ['export function outer(weights: number[]): number {', '  let sum = 0;'];
    for (let i = 0; i < 200; i++) lines.push(`  sum += weights[${i % 7}] * ${i + 3} - Math.min(sum, ${i});`);
    lines.push(...normalizeWeights('  '), '  return normalizeWeights(weights, sum).length;', '}');
    return lines;
  };
  const normalizeWeights = (indent: string) => [
    `${indent}function normalizeWeights(values: number[], scale: number): number[] {`,
    `${indent}  const total = values.reduce((sum, value) => sum + Math.abs(value), 0) || 1;`,
    `${indent}  const shifted = values.map((value, index) => value * scale + index / total);`,
    `${indent}  const largest = Math.max(...shifted.map((value) => Math.abs(value)), 1);`,
    `${indent}  return shifted.map((value) => Math.round((value / largest) * 1000) / 1000);`,
    `${indent}}`,
  ];
  const keep = ['export function keep(): number {', '  return 1;', '}'];

  void test('a definition over 150 lines with its own body is sliced as a part, and only the moved child links', async () => {
    const before = [...nestedOuter(), '', ...keep].join('\n') + '\n';
    const after = `${keep.join('\n')}\n`;
    const files = requests([
      { path: 'src/a.ts', before, after },
      { path: 'src/b.ts', after: `${normalizeWeights('').join('\n')}\n` },
    ]);
    const sliced = await slices(files);
    assertCovered(files, sliced);
    const a = ofFile(sliced, 'src/a.ts');
    const part = a.slices.find((s) => s.label === 'function outer() (part)');
    assert.ok(part, a.slices.map((s) => s.label).join(' | '));
    assert.equal(part.movedTo, undefined, 'the outer body did not move');
    const child = a.slices.find((s) => s.label.startsWith('function normalizeWeights()'));
    assert.ok(child);
    assert.ok(child.deletions <= 8, `only the nested function's lines (${child.deletions})`);
    const b = ofFile(sliced, 'src/b.ts');
    assert.equal(child.movedTo, b.slices[0].id);
    assert.equal(b.slices[0].movedFrom, child.id);
    assert.equal(child.moveBody, 'identical');
  });

  const end = (side: 'before' | 'after', name: string, start: number, last: number): MoveEnd => ({
    file: side === 'before' ? 'a.ts' : 'b.ts',
    url: '',
    headSha: '',
    path: side === 'before' ? 'a.ts' : 'b.ts',
    diffPath: side === 'before' ? 'a.ts' : 'b.ts',
    side,
    kind: 'function',
    name,
    label: `${name}()`,
    start,
    end: last,
    signatureEnd: start,
  });
  const move = (from: MoveEnd, to: MoveEnd, fields: Partial<SymbolMove> = {}): SymbolMove => ({
    from,
    to,
    exact: true,
    renamed: false,
    similarity: 1,
    commentsChanged: false,
    lines: { before: new Uint32Array(), after: new Uint32Array() },
    ...fields,
  });
  /** A slice of one definition on one side, its changed lines `start` to `last`. */
  const oneSlice = (
    side: 'before' | 'after',
    name: string,
    def: [number, number],
    changed: [number, number]
  ): HunkSlices => {
    const range = { start: changed[0], end: changed[1] };
    const count = changed[1] - changed[0] + 1;
    const slice: HunkSlice = {
      id: `${side}:${name}`,
      label: `${name}()`,
      symbols: [
        {
          side,
          kind: 'function',
          name,
          label: `${name}()`,
          start: def[0],
          end: def[1],
          span: { start: def[0] - 1, end: def[1] },
        },
      ],
      lines: [{ start: 0, end: count - 1 }],
      oldLines: side === 'before' ? [range] : [],
      newLines: side === 'after' ? [range] : [],
      removed: side === 'before' ? [range] : [],
      added: side === 'after' ? [range] : [],
      additions: side === 'after' ? count : 0,
      deletions: side === 'before' ? count : 0,
    };
    return { hunkId: side, filePath: side === 'before' ? 'a.ts' : 'b.ts', slices: [slice] };
  };

  void test('a move links only when the slice changes nothing outside the definition and its comments', () => {
    const exact = move(end('before', 'save', 10, 30), end('after', 'save', 5, 25));
    const linked = linkMoves(
      [oneSlice('before', 'save', [10, 30], [9, 30]), oneSlice('after', 'save', [5, 25], [5, 25])],
      [exact]
    );
    assert.equal(linked[0].slices[0].movedTo, 'after:save');
    assert.equal(linked[0].slices[0].moveBody, 'identical');
    // The deleted slice also removes line 31, past the definition (a closing brace, an `impl` header): no link.
    const wider = linkMoves(
      [oneSlice('before', 'save', [10, 30], [10, 31]), oneSlice('after', 'save', [5, 25], [5, 25])],
      [exact]
    );
    assert.equal(wider[0].slices[0].movedTo, undefined);
    assert.equal(wider[1].slices[0].movedFrom, undefined);
  });

  void test('a renamed move is edited, and says the old and new names', () => {
    const renamed = move(end('before', 'save', 10, 30), end('after', 'store', 5, 25), { renamed: true });
    const [from, to] = linkMoves(
      [oneSlice('before', 'save', [10, 30], [10, 30]), oneSlice('after', 'store', [5, 25], [5, 25])],
      [renamed]
    );
    assert.equal(from.slices[0].moveBody, 'edited');
    assert.deepEqual(from.slices[0].renamed, { from: 'save', to: 'store' });
    assert.deepEqual(to.slices[0].renamed, { from: 'save', to: 'store' });
  });

  void test('a modified file with only one text has no candidates', async () => {
    const [queue] = requests(seedChanges());
    assert.ok(queue.base !== undefined && queue.head !== undefined);
    assert.ok(await filePrints(engine, queue), 'both texts: read');
    assert.equal(await filePrints(engine, { ...queue, base: undefined }), null);
    assert.equal(await filePrints(engine, { ...queue, head: undefined }), null);
  });

  void test('a line starting with * is a comment only inside a block comment', () => {
    const lines = ['const total = base', '  * factor;', '/**', ' * Docs.', ' */', '// note', '', 'x();'];
    assert.deepEqual([...triviaLines(lines, 'typescript')].slice(1), [0, 0, 1, 1, 1, 1, 1, 0]);
    assert.deepEqual([...triviaLines(['# note', 'x = 1', '* y'], 'python')].slice(1), [1, 0, 0]);
  });
});
