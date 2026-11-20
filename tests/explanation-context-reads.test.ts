import test from 'node:test';
import assert from 'node:assert/strict';
import type { Octokit } from '@octokit/rest';
import {
  getFileContent,
  getFileContents,
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
  // 30 imports × 8 extensions = 240 candidates, 50 aliases per query.
  assert.equal(batched.counts.graphql, 5);
  assert.deepEqual(batched.counts.contentPaths.sort(), ['src/big.tsx', 'src/bin.js']);
});

void test('getFileContents falls back to REST for anything a failed query did not answer', async () => {
  const repo = fakeRepo({ 'a.ts': 'a', 'b.ts': 'b' });
  const octokit = Object.assign(Object.create(repo.octokit) as Octokit, {
    graphql: () => Promise.reject(Object.assign(new Error('Something went wrong'), { status: 502 })),
  });
  const result = await getFileContents(octokit, 'o', 'r', ['a.ts', 'b.ts', 'missing.ts'], 'ref');
  assert.deepEqual(Object.fromEntries(result), { 'a.ts': 'a', 'b.ts': 'b', 'missing.ts': null });
  assert.equal(repo.counts.getContent, 3);
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
    assert.equal(batched.counts.graphql, 2, 'the tree query, then one query for every SKILL.md');
    assert.equal(batched.counts.getContent, 0);
  }

  const none = fakeRepo({ 'README.md': 'hello' });
  assert.equal(await getProjectClaudeContext(none.octokit, 'o', 'r', 'ref'), null);
  assert.equal(none.counts.graphql, 1);
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
