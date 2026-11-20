import test from 'node:test';
import assert from 'node:assert/strict';
import type { Octokit } from '@octokit/rest';
import {
  getFileContent,
  getFileMetadata,
  getNeighborFiles,
  getProjectClaudeContext,
  makeGithubClaudeIO,
} from '../lib/github';
import { probeClaudeContext } from '../lib/claude-context';
import { fakeRepo } from './fake-github-repo';
import type { ChangedFile } from '../lib/types';

const imports = (count: number) =>
  Array.from({ length: count }, (_, i) => `import { v${i} } from './dep${i}';`).join('\n') +
  "\nimport { u } from './util';\nimport { b } from './bin';\nimport { e } from './empty';\nimport { t } from './big';";

void test('neighbor files come from batched blob queries and match the one-path-at-a-time reads', async () => {
  const files: Parameters<typeof fakeRepo>[0] = {
    'src/main.ts': imports(26),
    // `util` is a directory with an index; `''` and `.ts` miss before `/index.ts` resolves.
    'src/util/index.ts': 'export const u = 1;',
    // GraphQL gives no text for a binary blob, or a truncated one, so those go through REST.
    'src/bin.js': { text: 'export const b = 1;', binary: true },
    'src/big.tsx': { text: 'export const t = 1;', truncated: true },
    // An empty file reads as absent through REST, so the next extension wins.
    'src/empty.ts': '',
    'src/empty.js': 'export const e = 1;',
  };
  for (let i = 0; i < 26; i++) files[`src/dep${i}${i % 2 ? '.tsx' : '.ts'}`] = `export const v${i} = ${i};`;
  const changed = ['src/main.ts'],
    contents = { 'src/main.ts': files['src/main.ts'] as string };

  const old = fakeRepo(files);
  const expected = await getNeighborFiles(old.octokit, 'o', 'r', changed, contents, 'ref', undefined, (path) =>
    getFileContent(old.octokit, 'o', 'r', path, 'ref')
  );
  assert.equal(old.counts.graphql, 0);
  assert.ok(old.counts.getContent > 60, `the old path reads one candidate at a time (${old.counts.getContent})`);

  const batched = fakeRepo(files);
  const actual = await getNeighborFiles(batched.octokit, 'o', 'r', changed, contents, 'ref');
  assert.deepEqual(actual, expected);
  assert.equal(Object.keys(actual).length, 30);
  assert.equal(actual['src/util/index.ts'], 'export const u = 1;');
  assert.equal(actual['src/empty.js'], 'export const e = 1;');
  // 30 imports × 8 extensions = 240 candidates, 50 aliases per query, then one listing of the directories holding
  // the files that exist, for their modes.
  assert.equal(batched.counts.graphql, 6);
  assert.deepEqual(batched.counts.contentPaths.sort(), ['src/big.tsx', 'src/bin.js']);
});

void test('the Claude-context probe needs two GraphQL queries and matches the REST probe', async () => {
  const files = {
    'CLAUDE.md': '# Project\n\nUse strict types.',
    '.claude/commands/review.md': '---\ndescription: Review the code for correctness\n---\nBody',
    '.claude/commands/deploy.md': 'Deploy to production.',
    '.claude/commands/notes.txt': 'not a command',
    '.claude/agents/security.md': 'An agent that checks security issues.',
    '.claude/skills/polish/SKILL.md': '---\ndescription: Polish the UI typography\n---\n',
    '.claude/skills/polish/script.sh': 'echo hi',
    '.claude/skills/empty/README.md': 'no skill file here',
    '.claude/settings.json': '{}',
  };
  for (const unfiltered of [false, true]) {
    const old = fakeRepo(files);
    const expected = await probeClaudeContext(makeGithubClaudeIO(old.octokit, 'o', 'r', 'ref'), { unfiltered });
    assert.ok(expected);
    assert.ok(old.counts.getContent >= 9);

    const batched = fakeRepo(files);
    const actual = await getProjectClaudeContext(batched.octokit, 'o', 'r', 'ref', { unfiltered });
    assert.deepEqual(actual, expected);
    assert.equal(batched.counts.graphql, 3, 'the tree query, the texts, then the root listing for CLAUDE.md’s mode');
    assert.equal(batched.counts.getContent, 0);
    // Only the texts the probe reads: no notes.txt, settings.json or skill scripts.
    assert.deepEqual(batched.counts.blobPaths.sort(), [
      '.claude/agents/security.md',
      '.claude/commands/deploy.md',
      '.claude/commands/review.md',
      '.claude/skills/polish/SKILL.md',
      'CLAUDE.md',
    ]);
  }

  const none = fakeRepo({ 'README.md': 'hello' });
  assert.equal(await getProjectClaudeContext(none.octokit, 'o', 'r', 'ref'), null);
  assert.equal(none.counts.graphql, 2, 'the tree query, then CLAUDE.md');
  assert.equal(none.counts.getContent, 0);
});

void test('a symlink in .claude makes that directory listing fall back to REST', async () => {
  const files = {
    '.claude/commands/review.md': 'Review the code.',
    '.claude/commands/linked.md': { text: 'review.md', mode: 0o120000 },
  };
  const old = fakeRepo(files);
  const expected = await probeClaudeContext(makeGithubClaudeIO(old.octokit, 'o', 'r', 'ref'), { unfiltered: true });
  const batched = fakeRepo(files);
  assert.deepEqual(await getProjectClaudeContext(batched.octokit, 'o', 'r', 'ref', { unfiltered: true }), expected);
  assert.deepEqual(batched.counts.contentPaths, ['.claude/commands', '.claude/commands/linked.md']);
});

void test('file churn reads every PR commit at once and dates run alongside', async () => {
  let inFlight = 0,
    peak = 0;
  const commits = Array.from({ length: 30 }, (_, i) => ({ sha: `c${i}` }));
  const octokit = {
    pulls: { listCommits: () => Promise.resolve({ data: commits }) },
    repos: {
      getCommit: async ({ ref }: { ref: string }) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        const i = Number(ref.slice(1));
        return { data: { files: [{ filename: 'a.ts' }, ...(i % 3 === 0 ? [{ filename: 'b.ts' }] : [])] } };
      },
      listCommits: ({ path }: { path: string }) =>
        Promise.resolve({ data: path === 'a.ts' ? [{ commit: { committer: { date: '2026-01-01T00:00:00Z' } } }] : [] }),
    },
  } as unknown as Octokit;
  const file = (filename: string, status: ChangedFile['status']): ChangedFile => ({ filename, status, additions: 1, deletions: 0 });
  const metadata = await getFileMetadata(octokit, 'o', 'r', 1, 'base', [
    file('a.ts', 'modified'),
    file('b.ts', 'modified'),
    file('c.ts', 'added'),
  ]);
  assert.equal(peak, 10, 'commit reads run ten at a time instead of one after another');
  assert.deepEqual(
    metadata.map((m) => [m.filename, m.prCommitCount, m.lastModified]),
    [
      ['a.ts', 30, '2026-01-01T00:00:00Z'],
      ['b.ts', 10, null],
      ['c.ts', 1, null],
    ]
  );
});

void test('a symlinked CLAUDE.md or neighbor reads its target through REST, never the link path', async () => {
  const files = {
    'AGENTS.md': '# Agents\n\nUse strict types.',
    'CLAUDE.md': { text: 'AGENTS.md', mode: 0o120000 },
    'src/main.ts': "import { a } from './a';",
    'src/real.ts': 'export const a = 1;',
    'src/a.ts': { text: 'real.ts', mode: 0o120000 },
  };
  const old = fakeRepo(files);
  const expected = await probeClaudeContext(makeGithubClaudeIO(old.octokit, 'o', 'r', 'ref'));
  const batched = fakeRepo(files);
  const actual = await getProjectClaudeContext(batched.octokit, 'o', 'r', 'ref');
  assert.deepEqual(actual, expected);
  assert.match(actual?.projectInstructions ?? '', /Use strict types/);
  const neighbors = await getNeighborFiles(batched.octokit, 'o', 'r', ['src/main.ts'], { 'src/main.ts': files['src/main.ts'] }, 'ref');
  assert.deepEqual(neighbors, { 'src/a.ts': 'export const a = 1;' });
});

void test('when the neighbor batch fails, REST reads each import in extension order and stops at the first hit', async () => {
  const repo = fakeRepo({ 'src/main.ts': "import { a } from './a';\nimport { b } from './b';", 'src/a.ts': 'a', 'src/b/index.ts': 'b' });
  const octokit = Object.assign(Object.create(repo.octokit) as Octokit, {
    graphql: () => Promise.reject(Object.assign(new Error('Bad gateway'), { status: 502 })),
  });
  const result = await getNeighborFiles(octokit, 'o', 'r', ['src/main.ts'], { 'src/main.ts': "import { a } from './a';\nimport { b } from './b';" }, 'ref');
  assert.deepEqual(result, { 'src/a.ts': 'a', 'src/b/index.ts': 'b' });
  // a: '', '.ts'. b: '', '.ts', '.tsx', '.js', '.jsx', '/index.ts'. Not all 16 candidates.
  assert.equal(repo.counts.getContent, 8);
});

void test('mapBounded starts nothing after the first failure and waits for what is running', async () => {
  const { mapBounded } = await import('../lib/bounded');
  const started: number[] = [];
  let running = 0;
  const done: number[] = [];
  await assert.rejects(
    mapBounded([0, 1, 2, 3, 4, 5, 6, 7], 2, async (n) => {
      started.push(n);
      running++;
      await new Promise((resolve) => setTimeout(resolve, n === 0 ? 1 : 10));
      running--;
      if (n === 0) throw new Error('first');
      done.push(n);
      return n;
    }),
    /first/
  );
  assert.deepEqual(started, [0, 1], 'no item starts after the failure');
  assert.equal(running, 0, 'the item already running finished before the call rejected');
  assert.deepEqual(done, [1]);
});

void test('a blob alias with an error falls back alone; the rest of the batch stands', async () => {
  const { readBlobs } = await import('../lib/github-graphql-batch');
  const repo = fakeRepo({ 'a.ts': 'a', 'b.ts': 'b' });
  const octokit = Object.assign(Object.create(repo.octokit) as Octokit, {
    graphql: async (query: string) => {
      const data = await repo.octokit.graphql<{ r0: Record<string, unknown> }>(query);
      data.r0.f1 = null;
      throw Object.assign(new Error('partial'), { data, errors: [{ message: 'Timeout', path: ['r0', 'f1'] }] });
    },
  });
  const answers = await readBlobs(octokit, ['a.ts', 'b.ts'].map((path) => ({ owner: 'o', repo: 'r', ref: 'ref', path })));
  assert.deepEqual(answers, [{ kind: 'text', text: 'a' }, { kind: 'other', reason: 'failed' }]);
});
