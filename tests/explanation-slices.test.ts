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
  sliceFile,
  sliceMoves,
  slicePr,
  sliceRequests,
  type HunkSlices,
  type SliceFile,
} from '../lib/explanation-slices';
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
/** The worker's files for the changes, as the explanation builds them from its indexed hunks. */
function requests(changes: readonly Change[]): SliceFile[] {
  const before: Record<string, string> = {},
    after: Record<string, string> = {};
  for (const change of changes) {
    if (change.before !== undefined) before[change.path] = change.before;
    after[change.path] = change.after;
  }
  return sliceRequests(buildIndexedHunks(gitDiff(changes), before, after), before, after);
}
/** The PR's slices, each file read in turn and the moves matched, as the worker does it, without the worker. */
function slices(files: readonly SliceFile[], disabled: SyntaxLanguage[] = []): Promise<HunkSlices[]> {
  return slicePr(
    files,
    (file) => sliceFile(engine, file, disabled),
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
    // The new file's lines, in order, with no gap and no overlap.
    assert.deepEqual(drain.slices[0].newLines[0].start, 1);
    for (let i = 1; i < drain.slices.length; i++)
      assert.equal(drain.slices[i].newLines[0].start, (drain.slices[i - 1].newLines.at(-1)?.end ?? 0) + 1);
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
      (candidates) => Promise.resolve(sliceMoves(candidates))
    );
    assert.equal(ofFile(sliced, 'src/other.rs').whole, 'timeout');
    assert.ok(sliced.every((hunk) => hunk.slices.every((s) => !s.movedTo && !s.movedFrom)));
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
    assert.equal(answer.slices[0].whole, 'failed');
    assert.ok(coversExactly(file.hunks[0], answer.slices[0].slices));
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
