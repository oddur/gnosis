import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import * as TreeSitter from 'web-tree-sitter';
import { createSyntaxEngine } from '../lib/syntax-scope';
import { parseConflicts } from '../lib/conflict-blocks';
import { MOVED_UNCHECKED, verifyProposals, verifyWholeFile, type Analyse } from '../lib/conflict-verify';
import { moveProposer } from '../src/conflict-checks';

/** One side moved or renamed a function and the other edited it (#445 item 17). */
const assets = path.resolve(__dirname, '../src/assets/tree-sitter');
const fixtures = path.resolve(__dirname, 'fixtures/conflicts');
const engine = createSyntaxEngine(TreeSitter, {
  runtime: async () => new Uint8Array(await fs.readFile(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))),
  grammar: async (language) => new Uint8Array(await fs.readFile(path.join(assets, `${language}.wasm`))),
  tags: (name) => fs.readFile(path.join(assets, `${name}-tags.scm`), 'utf8'),
});
const analyse: Analyse = (language, text, ranges) => engine.definitions(language, text, ranges);
const propose = moveProposer(engine);

/** A lab case's file as the service holds it: its three versions and Git's diff3 conflict. */
async function caseFile(name: string, file: string) {
  const read = (side: string) => fs.readFile(path.join(fixtures, name, side, file), 'utf8').catch(() => undefined);
  const [base, ours, theirs, resolved] = await Promise.all(['base', 'ours', 'theirs', 'resolved'].map(read));
  assert.ok(base !== undefined && ours !== undefined && theirs !== undefined);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnosis-moved-'));
  try {
    const names = ['ours', 'base', 'theirs'].map((n) => path.join(dir, n));
    await Promise.all(names.map((n, i) => fs.writeFile(n, [ours, base, theirs][i])));
    let original: string;
    try {
      original = execFileSync('git', ['merge-file', '-p', '--diff3', ...names]).toString();
    } catch (error) {
      original = (error as { stdout: Buffer }).stdout.toString();
    }
    return { file: { path: file, base, ours, theirs, original }, resolved };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

for (const [name, file, note] of [
  ['ts-move-vs-edit-bottom', 'src/pricing.ts', 'The PR moved orderTotal, and main edited it.'],
  ['ts-move-vs-edit-main-moves', 'src/pricing.ts', 'Main moved orderTotal, and the PR edited it.'],
  ['py-move-vs-edit-bottom', 'lab/stats.py', 'The PR moved weighted_mean, and main edited it.'],
  ['go-move-vs-edit-bottom', 'lab/pairs.go', 'The PR moved ParsePairs, and main edited it.'],
  ['ts-rename-move-vs-edit', 'src/users.ts', 'The PR renamed loadUser to findUser and moved it, and main edited it.'],
  [
    'py-rename-move-vs-edit',
    'lab/stats.py',
    'The PR renamed weighted_mean to weighted_average and moved it, and main edited it.',
  ],
] as const)
  void test(`the move rule applies the other side's edit at the new place, in Check: ${name}`, async () => {
    const { file: f, resolved } = await caseFile(name, file);
    assert.ok(parseConflicts(f.original).some((s) => s.kind === 'conflict'));
    const proposal = await propose(f);
    assert.ok(proposal);
    assert.equal(proposal.source, 'moved');
    assert.equal(proposal.text, resolved);
    assert.equal(proposal.note, note);
    const verdict = await verifyWholeFile(f, proposal, analyse);
    assert.equal(verdict.merged, false);
    assert.equal(verdict.passed, true);
    assert.ok(verdict.note.startsWith(note));
    assert.ok(verdict.note.endsWith(MOVED_UNCHECKED), verdict.note);
  });

for (const [name, file] of [
  // The moving side also changed the body: not the same body, so no move to apply the edit to.
  ['ts-move-vs-edit-trap-both-changed', 'src/pricing.ts'],
  // Two added bodies match the one that left: which one main's edit belongs to is unknown.
  ['ts-move-vs-edit-trap-ambiguous', 'src/pricing.ts'],
  // The function went to a file Git merged cleanly, which the resolution does not hold.
  ['go-move-vs-edit-other-file', 'lab/pairs.go'],
] as const)
  void test(`the move rule proposes nothing when in doubt: ${name}`, async () => {
    const { file: f } = await caseFile(name, file);
    assert.equal(await propose(f), undefined);
  });

void test('the move rule proposes nothing when an open conflict holds more of the other side than its edit', async () => {
  const { file: f } = await caseFile('ts-move-vs-edit-bottom', 'src/pricing.ts');
  // Main's side of the conflict also holds a line main wrote outside orderTotal: taking the PR's side would drop it.
  const original = f.original.replace(/\n>>>>>>> /, '\n// main’s note\n>>>>>>> ');
  assert.notEqual(original, f.original);
  assert.equal(await propose({ ...f, original }), undefined);
  assert.ok(await propose(f));
});

void test('a renamed function whose edit lands wrong fails the checks', async () => {
  const { file: f, resolved } = await caseFile('ts-rename-move-vs-edit', 'src/users.ts');
  assert.ok(resolved);
  // Two lines of findUser swap places: every line is still there, so only the rename check can tell.
  const swapped = resolved.replace(
    '  const cached = cache.get(id);\n  if (cached) return cached;\n',
    '  if (cached) return cached;\n  const cached = cache.get(id);\n'
  );
  assert.notEqual(swapped, resolved);
  const verdict = await verifyWholeFile(f, { source: 'moved', text: swapped }, analyse);
  assert.equal(verdict.passed, undefined);
  assert.match(verdict.note, /findUser in the result doesn’t match main’s change to loadUser|doesn’t parse/);
  // The old name back beside the new one.
  const both = `${resolved}\n${f.theirs.slice(f.theirs.indexOf('export function loadUser'), f.theirs.indexOf('\n}\n') + 3)}`;
  const twice = await verifyWholeFile(f, { source: 'moved', text: both }, analyse);
  assert.equal(twice.passed, undefined);
});

void test('a moved proposal is never Merged per conflict', async () => {
  const { file: f, resolved } = await caseFile('ts-move-vs-edit-bottom', 'src/pricing.ts');
  assert.ok(resolved);
  const blocks = parseConflicts(f.original);
  const proposals = blocks.flatMap((s) =>
    s.kind === 'conflict' ? [{ source: 'moved' as const, text: s.block.ours }] : []
  );
  const verdict = await verifyProposals({ ...f, proposals }, analyse);
  assert.equal(verdict.merged, false);
});

void test('the move rule proposes nothing for a language that is off', async () => {
  const { file: f } = await caseFile('ts-move-vs-edit-bottom', 'src/pricing.ts');
  assert.equal(await moveProposer(engine, ['typescript'])(f), undefined);
});
