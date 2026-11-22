import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { blocks, confusion, runCase } from '../scripts/conflict-lab.mjs';
import { loadCase } from '../scripts/conflict-lab-lib.mjs';

/** Three tiny fixtures through the conflict lab: one Merged, one Check, one Decide, and the wrong-Merged count. */
const mergiraf = path.resolve('resources/mergiraf/runtime', process.platform === 'win32' ? 'mergiraf.exe' : 'mergiraf');
const fixture = (name: string) => loadCase(path.resolve('tests/fixtures/conflicts', name));

void test(
  'the conflict lab scores buckets against each case’s expectations',
  { skip: !fs.existsSync(mergiraf) && 'Run npm run prepare:mergiraf first.' },
  async () => {
    const cases = await Promise.all(
      ['order-anchor-insert-around-changed', 'toml-add-dependencies', 'ts-same-constant-different-values'].map(fixture)
    );
    const results = await Promise.all(cases.map((c: unknown) => runCase(c)));
    for (const r of results) assert.equal(r.error, undefined, r.error);
    const rows = blocks(results) as {
      case: string;
      actual: string;
      expected: string;
      wrong: string;
      comparison?: string;
    }[];
    assert.deepEqual(
      rows.map((r) => [r.case, r.actual]),
      [
        // Each side changed its own place around go(1): Merged. (Both sides adding at one place is Check since #476.)
        ['order-anchor-insert-around-changed', 'merged'],
        // Mergiraf merges TOML, but Gnosis has no TOML grammar to check the result.
        ['toml-add-dependencies', 'check'],
        // Both sides changed the same constant: no safe proposal.
        ['ts-same-constant-different-values', 'decide'],
      ]
    );
    assert.equal(rows[0].comparison, 'exact', 'The Merged result equals the known-correct resolution');
    assert.equal(rows.filter((r) => r.wrong).length, 0);
    assert.deepEqual((confusion(rows) as Record<string, Record<string, number>>)['any-but-merged'], {
      merged: 0,
      check: 0,
      decide: 1,
      decided: 0,
      clean: 0,
      local: 0,
      none: 0,
    });
  }
);

void test('a file that needs a local merge tool scores as local, whatever its buckets', () => {
  const rows = blocks([
    {
      name: 'rename',
      meta: {},
      steps: [{ step: 'pr', files: [{ path: 'a.ts', buckets: ['decide'], expected: ['local'], unsupported: 'rename' }] }],
    },
  ]) as { actual: string; wrong: string }[];
  assert.deepEqual(
    rows.map((r) => [r.actual, r.wrong]),
    [['local', '']]
  );
});

void test('a Merged block where Merged is unsafe counts as wrong', () => {
  const rows = blocks([
    {
      name: 'trap',
      meta: {},
      steps: [
        {
          step: 'pr',
          files: [{ path: 'a.ts', buckets: ['merged', 'decide'], expected: ['any-but-merged', 'any-but-merged'] }],
        },
      ],
    },
  ]) as { wrong: string }[];
  assert.deepEqual(
    rows.map((r) => r.wrong),
    ['Merged where Merged is unsafe', '']
  );
});
