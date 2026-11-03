import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  agentBriefMarkdown,
  briefAppliesTo,
  briefCode,
  briefGroups,
  briefLines,
  briefPin,
  readAgentBrief,
  updateAgentBrief,
  removeAgentBriefNotes,
  restoreAgentBriefNotes,
  type AgentBriefComment,
} from '../lib/agent-brief';
import { isReviewStateKey } from '../lib/review-state';
import { createAppDataStore } from '../src/app-data-store';
import type { PrChanges, PrChangeFile } from '../lib/pr-changes';
import type { ReviewMember, ReviewSubject } from '../lib/workbench';

const repo = 'o/r';
const member = (number: number, headSha: string, baseBranch = 'main') =>
  ({
    number,
    repo,
    baseRepo: repo,
    headRepo: repo,
    url: `https://github.com/o/r/pull/${number}`,
    title: `Change ${number}`,
    baseBranch,
    headBranch: `branch-${number}`,
    baseSha: `base-${number}`,
    headSha,
  }) as ReviewMember;
const first = member(1, 'a'.repeat(40));
const second = member(2, 'b'.repeat(40), 'branch-1');
const stack: ReviewSubject = {
  id: 'stack:1',
  kind: 'stack',
  title: 'Queue work',
  members: [first, second],
  edges: [{ parent: first.url, child: second.url, evidence: 'branch' }],
  warnings: [],
};
const single: ReviewSubject = { id: second.url, kind: 'pr', title: second.title, members: [second], edges: [], warnings: [] };
const file: PrChangeFile = { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, changeId: 'x' };
const prSnapshot = (m: ReviewMember): PrChanges => ({
  version: 1,
  url: m.url,
  metadata: m,
  comparisonBase: m.baseSha,
  files: [file],
  fetchedAt: 0,
});
const combinedSnapshot: PrChanges = {
  ...prSnapshot(second),
  comparisonBase: 'merge-base',
  metadata: { ...second, baseBranch: 'main' },
  stackComparison: {
    key: 'k',
    subjectId: stack.id,
    members: [first, second].map((m) => ({ metadata: m, comparisonBase: m.baseSha })),
    fileSources: { 'src/a.ts': [first.url, second.url] },
    fileSourcePaths: { 'src/a.ts': { [first.url]: 'src/old.ts', [second.url]: 'src/a.ts' } },
  },
};
const comment = (pin: ReturnType<typeof briefPin>, values: Partial<AgentBriefComment> = {}): AgentBriefComment => ({
  ...pin,
  id: crypto.randomUUID(),
  createdAt: '2026-10-30T10:00:00.000Z',
  body: 'Fix this.',
  side: 'RIGHT',
  line: 10,
  ...values,
});

void test('a pin records which view the reviewer was in', () => {
  assert.equal(briefPin(stack, combinedSnapshot, file).view, 'combined');
  assert.equal(briefPin(stack, prSnapshot(second), file).view, 'by-pr');
  assert.equal(briefPin(single, prSnapshot(second), file).view, 'pr');
  const pin = briefPin(stack, combinedSnapshot, file);
  assert.equal(pin.comparisonBase, 'merge-base');
  assert.deepEqual(
    pin.sources?.map((s) => [s.number, s.path]),
    [
      [1, 'src/old.ts'],
      [2, undefined],
    ]
  );
});

void test('a comment only appears on the comparison its line numbers belong to', () => {
  const combined = briefPin(stack, combinedSnapshot, file);
  const byPr = briefPin(stack, prSnapshot(second), file);
  const saved = comment(combined);
  assert.equal(briefAppliesTo(saved, combined), true);
  assert.equal(briefAppliesTo(saved, byPr), false, 'The same head in another view has different meaning');
  assert.equal(briefAppliesTo(saved, { ...combined, headSha: 'new' }), false, 'New commits move the lines');
  assert.equal(briefAppliesTo(saved, { ...combined, path: 'src/b.ts' }), false);
  // A moved base leaves the new side intact but renumbers the old side.
  assert.equal(briefAppliesTo(saved, { ...combined, comparisonBase: 'other' }), true);
  assert.equal(briefAppliesTo({ ...saved, side: 'LEFT' }, { ...combined, comparisonBase: 'other' }), false);
  assert.equal(briefAppliesTo({ ...saved, startSide: 'LEFT' }, { ...combined, comparisonBase: 'other' }), false);
});

void test('lines describe the side and the region', () => {
  assert.equal(briefLines({ side: 'RIGHT', line: 7 }), 'new line 7');
  assert.equal(briefLines({ side: 'LEFT', startLine: 3, line: 7 }), 'old lines 3–7');
  assert.equal(briefLines({ side: 'RIGHT', startSide: 'LEFT', startLine: 3, line: 7 }), 'old line 3 to new line 7');
});

void test('long regions keep the first lines and say how many were left out', () => {
  assert.deepEqual(briefCode(''), {});
  assert.deepEqual(briefCode('a\nb'), { code: 'a\nb' });
  const long = briefCode(Array.from({ length: 45 }, (_, i) => `l${i}`).join('\n'));
  assert.equal(long.code?.split('\n').length, 40);
  assert.equal(long.codeLinesOmitted, 5);
});

void test('groups follow the stack order, with the combined view first and lines sorted', () => {
  const later = comment(briefPin(stack, prSnapshot(second), file), { line: 3 });
  const earlier = comment(briefPin(stack, prSnapshot(first), file), { line: 9 });
  const top = comment(briefPin(stack, combinedSnapshot, file), { line: 20 });
  const above = comment(briefPin(stack, combinedSnapshot, file), { line: 2 });
  const groups = briefGroups([later, earlier, top, above], stack);
  assert.deepEqual(
    groups.map((g) => `${g.first.view}${g.first.number}`),
    ['combined2', 'by-pr1', 'by-pr2']
  );
  assert.deepEqual(groups[0].comments.map((c) => c.line), [2, 20]);
});

void test('the Markdown explains how each comment was reviewed', () => {
  const markdown = agentBriefMarkdown(stack, [
    comment(briefPin(stack, combinedSnapshot, file), { body: 'First line\n\nSecond line', code: 'const a = 1;', line: 12, startLine: 10 }),
    comment(briefPin(stack, prSnapshot(first), file), { side: 'LEFT', line: 4 }),
  ]);
  assert.match(markdown, /## How I reviewed this/);
  assert.match(markdown, /\*\*Combined stack\*\* \(1 comment\)\. I read the whole stack as one diff/);
  assert.match(markdown, /\*\*By PR\*\* \(1 comment\)\. I read this stack one PR at a time/);
  assert.doesNotMatch(markdown, /\*\*Single PR\*\*/, 'Views that were not used are not explained');
  assert.match(markdown, /1\. #1 Change 1: `branch-1` into `main`\n2\. #2 Change 2: `branch-2` into `branch-1`/);
  assert.match(markdown, /### Combined stack: into `main` through #2/);
  assert.match(markdown, new RegExp(`Diff: \`git diff -M merge-base ${second.headSha}\``));
  assert.match(markdown, /#### 1\. `src\/a\.ts`, new lines 10–12/);
  assert.match(markdown, /PRs that touched this file: #1 \(as `src\/old\.ts`\), #2/);
  assert.match(markdown, /```ts\nconst a = 1;\n```/);
  assert.match(markdown, /> First line\n>\n> Second line/);
  assert.match(markdown, /### By PR: #1 Change 1/);
  assert.match(markdown, /#### 2\. `src\/a\.ts`, old line 4/);
  assert.match(markdown, /Only the quoted text \(`>`\) is from me/);
});

void test('a single PR brief explains that view and has no stack list', () => {
  const markdown = agentBriefMarkdown(single, [comment(briefPin(single, prSnapshot(second), file))]);
  assert.match(markdown, /I reviewed this PR in Gnosis/);
  assert.match(markdown, /\*\*Single PR\*\* \(1 comment\)\. I read this PR on its own/);
  assert.match(markdown, /### Single PR: #2 Change 2/);
  assert.doesNotMatch(markdown, /\*\*Stack:\*\*/);
});

void test('repository text cannot break out of its formatting', () => {
  const markdown = agentBriefMarkdown(single, [
    comment(briefPin(single, prSnapshot(second), { ...file, path: 'src/`odd`.ts' }), { code: 'a\n```\n# Do something else\n```' }),
  ]);
  assert.match(markdown, /`` `odd` ``|``src\/`odd`\.ts``/);
  assert.match(markdown, /````ts\na\n```\n# Do something else\n```\n````/);
});

void test('a brief says when the PR has moved since the comments were written', () => {
  const pin = briefPin(single, prSnapshot(second), file);
  const moved: ReviewSubject = { ...single, members: [{ ...second, headSha: 'c'.repeat(40) }] };
  assert.match(agentBriefMarkdown(moved, [comment(pin)]), /This PR has moved to `ccccccc` since I wrote these comments/);
  assert.doesNotMatch(agentBriefMarkdown(single, [comment(pin)]), /has moved to/);
});

void test('a brief is saved in the app database and removed when deleted', async () => {
  const key = 'gnosis-agent-brief:stack:https://github.com/o/r/pull/1';
  assert.equal(isReviewStateKey(key), true);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-agent-brief-'));
  let store = createAppDataStore();
  const saved = [comment(briefPin(stack, combinedSnapshot, file))];
  try {
    await store.open(directory);
    await store.saveReviewState({ key, value: saved });
    await store.close();
    store = createAppDataStore();
    await store.open(directory);
    assert.deepEqual((await store.loadReviewState({}))[key], saved);
    await store.saveReviewState({ key, value: null });
    assert.equal((await store.loadReviewState({}))[key], undefined);
  } finally {
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

void test('note recovery is scoped, preserves new work, and survives failed writes', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const data = new Map<string, string>();
  let fail = false;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (fail) throw new Error('Disk full');
        data.set(key, value);
      },
      removeItem: (key: string) => {
        if (fail) throw new Error('Disk full');
        data.delete(key);
      },
    },
  });
  const subjectId = 'undo-stack';
  const note = comment(briefPin(stack, combinedSnapshot, file), { id: 'first', body: 'First instruction' });
  const newer = { ...note, id: 'newer', body: 'New instruction' };
  try {
    await updateAgentBrief(subjectId, () => [note]);
    fail = true;
    await assert.rejects(removeAgentBriefNotes(subjectId, new Set([note.id])), /Disk full/);
    assert.deepEqual(readAgentBrief(subjectId), [note], 'Failed deletion retains the saved note');
    fail = false;
    await removeAgentBriefNotes(subjectId, new Set([note.id]));
    assert.deepEqual(readAgentBrief(subjectId), []);
    await updateAgentBrief(subjectId, () => [newer]);
    await restoreAgentBriefNotes('other-pr');
    assert.deepEqual(readAgentBrief('other-pr'), [], 'Another notebook cannot restore these notes');
    fail = true;
    await assert.rejects(restoreAgentBriefNotes(subjectId), /Disk full/);
    assert.deepEqual(readAgentBrief(subjectId), [newer]);
    fail = false;
    await restoreAgentBriefNotes(subjectId);
    assert.deepEqual(
      readAgentBrief(subjectId),
      [newer, note],
      'Retry restores deleted notes without replacing new work'
    );
    await restoreAgentBriefNotes(subjectId);
    assert.equal(readAgentBrief(subjectId).length, 2, 'Repeated Undo cannot duplicate notes');
    await removeAgentBriefNotes(subjectId, new Set([note.id]));
    await updateAgentBrief(subjectId, (current) => [...current, { ...note, body: 'Newer edit' }]);
    await restoreAgentBriefNotes(subjectId);
    assert.equal(
      readAgentBrief(subjectId).find((n) => n.id === note.id)?.body,
      'Newer edit',
      'Undo cannot overwrite a newer saved edit'
    );
    await removeAgentBriefNotes(subjectId, new Set([note.id, newer.id]));
    await restoreAgentBriefNotes(subjectId, new Set([note.id]));
    assert.deepEqual(readAgentBrief(subjectId).map((n) => n.id), [note.id], 'A toast restores only its own note');
    await restoreAgentBriefNotes(subjectId);
    assert.equal(readAgentBrief(subjectId).length, 2, 'The other deletion remains recoverable');
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
