import assert from 'node:assert/strict';
import test from 'node:test';
import { offerSuggestion } from '../lib/conflict-offer';
import type { ConflictFile } from '../lib/conflict-resolution';

/** Two conflicts with text around them, as Git writes them. */
const original = [
  'export const head = 0;\n',
  '<<<<<<< pr\nexport const a = 1;\n=======\nexport const a = 2;\n>>>>>>> main\n',
  'export const mid = 0;\n',
  '<<<<<<< pr\nexport const b = 1;\n=======\nexport const b = 2;\n>>>>>>> main\n',
].join('');
const file = (extra: Partial<ConflictFile> = {}): ConflictFile => ({
  path: 'src/values.ts',
  mode: '100644',
  base: '',
  ours: '',
  theirs: '',
  original,
  result: original,
  resolved: false,
  source: 'manual',
  ...extra,
});
/** An answer that only fills the conflicts. */
const perConflict = 'export const head = 0;\nexport const a = 3;\nexport const mid = 0;\nexport const b = 3;\n';
/** An answer that also rewrites code around them. */
const whole = 'export const head = 1;\nexport const a = 3;\nexport const mid = 0;\nexport const b = 3;\n';

void test('a per-conflict answer replaces an older whole-file proposal, so its parts get their own verdicts', () => {
  const f = file({ wholeFile: { source: 'mergiraf', text: whole }, source: 'mergiraf' });
  const note = offerSuggestion(f, perConflict, 'model');
  assert.equal(f.wholeFile, undefined);
  assert.deepEqual(
    f.proposals?.map((p) => p && [p.source, p.text]),
    [
      ['model', 'export const a = 3;\n'],
      ['model', 'export const b = 3;\n'],
    ]
  );
  // A model's parts wait on their cards; the draft keeps the conflicts.
  assert.equal(f.result, original);
  assert.equal(f.source, 'agent');
  assert.match(note, /2 conflicts have a proposal to check/);
});

void test('a whole-file answer replaces the per-conflict proposals nobody chose, and is checked as one proposal', () => {
  const f = file({
    proposals: [
      { source: 'model', text: 'export const a = 3;\n' },
      { source: 'model', text: 'export const b = 3;\n' },
    ],
  });
  offerSuggestion(f, whole, 'mergiraf');
  assert.deepEqual(f.wholeFile, { source: 'mergiraf', text: whole });
  assert.equal(f.proposals, undefined);
  assert.equal(f.result, original);
  assert.equal(f.source, 'mergiraf');
  // Once you decided a conflict, a whole-file answer is refused: it would rewrite your choice.
  const decided = file({ result: original.replace(/<<<<<<< pr\nexport const a[\s\S]*?>>>>>>> main\n/, 'export const a = 1;\n'), picks: ['ours', null] });
  assert.throws(() => offerSuggestion(decided, whole, 'mergiraf'), /already decided/);
});
