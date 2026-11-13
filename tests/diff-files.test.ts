import test from 'node:test';
import assert from 'node:assert/strict';
import { filesOfUnifiedDiff } from '../lib/diff-files';

// `git diff` output from a real repository (git 2.x, default core.quotePath). Covers CRLF content, octal-escaped
// non-ASCII paths, a quoted path with an escaped quote, paths with spaces (git ends their ---/+++ lines with a tab),
// an empty new file, a deletion, a binary change, a mode-only change, a rename with and without edits, and a file with
// no newline at its end.
const DIFF =
  "diff --git a/crlf.txt b/crlf.txt\n" +
  "index c30dea8..57213eb 100644\n" +
  "--- a/crlf.txt\n" +
  "+++ b/crlf.txt\n" +
  "@@ -1,2 +1,2 @@\n" +
  " a\r\n" +
  "-b\r\n" +
  "+B\r\n" +
  "diff --git \"a/docs/caf\\303\\251.md\" \"b/docs/caf\\303\\251.md\"\n" +
  "index 572eb43..bf7243d 100644\n" +
  "--- \"a/docs/caf\\303\\251.md\"\n" +
  "+++ \"b/docs/caf\\303\\251.md\"\n" +
  "@@ -1 +1 @@\n" +
  "-café\n" +
  "+café au lait\n" +
  "diff --git \"a/docs/na\\303\\257ve \\\"quote\\\".md\" \"b/docs/na\\303\\257ve \\\"quote\\\".md\"\n" +
  "new file mode 100644\n" +
  "index 0000000..3e75765\n" +
  "--- /dev/null\n" +
  "+++ \"b/docs/na\\303\\257ve \\\"quote\\\".md\"\t\n" +
  "@@ -0,0 +1 @@\n" +
  "+new\n" +
  "diff --git a/docs/with space.md b/docs/with space.md\n" +
  "index 587be6b..975fbec 100644\n" +
  "--- a/docs/with space.md\t\n" +
  "+++ b/docs/with space.md\t\n" +
  "@@ -1 +1 @@\n" +
  "-x\n" +
  "+y\n" +
  "diff --git a/empty.txt b/empty.txt\n" +
  "new file mode 100644\n" +
  "index 0000000..e69de29\n" +
  "diff --git a/gone.txt b/gone.txt\n" +
  "deleted file mode 100644\n" +
  "index 286c5f5..0000000\n" +
  "--- a/gone.txt\n" +
  "+++ /dev/null\n" +
  "@@ -1 +0,0 @@\n" +
  "-gone\n" +
  "diff --git a/logo.png b/logo.png\n" +
  "index d0463d4..c3d368a 100644\n" +
  "Binary files a/logo.png and b/logo.png differ\n" +
  "diff --git a/run.sh b/run.sh\n" +
  "old mode 100644\n" +
  "new mode 100755\n" +
  "diff --git a/src/moved.ts \"b/src/d\\303\\251plac\\303\\251.ts\"\n" +
  "similarity index 83%\n" +
  "rename from src/moved.ts\n" +
  "rename to \"src/d\\303\\251plac\\303\\251.ts\"\n" +
  "index 0970e47..a514be7 100644\n" +
  "--- a/src/moved.ts\n" +
  "+++ \"b/src/d\\303\\251plac\\303\\251.ts\"\n" +
  "@@ -3,4 +3,4 @@ l2\n" +
  " l3\n" +
  " l4\n" +
  " l5\n" +
  "-l6\n" +
  "+L6\n" +
  "diff --git a/src/main.ts b/src/main.ts\n" +
  "index 4cb29ea..f04eb26 100644\n" +
  "--- a/src/main.ts\n" +
  "+++ b/src/main.ts\n" +
  "@@ -1,3 +1,3 @@\n" +
  " one\n" +
  "-two\n" +
  "+2\n" +
  " three\n" +
  "diff --git a/src/old-name.ts b/src/new-name.ts\n" +
  "similarity index 100%\n" +
  "rename from src/old-name.ts\n" +
  "rename to src/new-name.ts\n" +
  "diff --git a/tail.txt b/tail.txt\n" +
  "index 20cbb4d..db1dabe 100644\n" +
  "--- a/tail.txt\n" +
  "+++ b/tail.txt\n" +
  "@@ -1 +1 @@\n" +
  "-no newline\n" +
  "\\ No newline at end of file\n" +
  "+no newline, changed\n" +
  "\\ No newline at end of file\n";

void test('a whole diff splits into files with paths, statuses, counts, patches and abbreviated blob SHAs', () => {
  const files = filesOfUnifiedDiff(DIFF);
  assert.deepEqual(
    files.map((f) => [f.filename, f.status, f.previous_filename, f.additions, f.deletions, f.patch !== undefined, f.sha]),
    [
      ['crlf.txt', 'modified', undefined, 1, 1, true, '57213eb'],
      ['docs/café.md', 'modified', undefined, 1, 1, true, 'bf7243d'],
      ['docs/naïve "quote".md', 'added', undefined, 1, 0, true, '3e75765'],
      ['docs/with space.md', 'modified', undefined, 1, 1, true, '975fbec'],
      ['empty.txt', 'added', undefined, 0, 0, false, 'e69de29'],
      ['gone.txt', 'deleted', undefined, 0, 1, true, undefined],
      ['logo.png', 'modified', undefined, 0, 0, false, 'c3d368a'],
      ['run.sh', 'modified', undefined, 0, 0, false, undefined],
      ['src/déplacé.ts', 'renamed', 'src/moved.ts', 1, 1, true, 'a514be7'],
      ['src/main.ts', 'modified', undefined, 1, 1, true, 'f04eb26'],
      ['src/new-name.ts', 'renamed', 'src/old-name.ts', 0, 0, false, undefined],
      ['tail.txt', 'modified', undefined, 1, 1, true, 'db1dabe'],
    ]
  );
});
void test('patches start at the first hunk, keep CRs and no-newline markers, and match the files API', () => {
  const files = new Map(filesOfUnifiedDiff(DIFF).map((f) => [f.filename, f]));
  assert.equal(files.get('src/main.ts')?.patch, '@@ -1,3 +1,3 @@\n one\n-two\n+2\n three');
  assert.equal(files.get('crlf.txt')?.patch, '@@ -1,2 +1,2 @@\n a\r\n-b\r\n+B\r');
  assert.equal(
    files.get('tail.txt')?.patch,
    '@@ -1 +1 @@\n-no newline\n\\ No newline at end of file\n+no newline, changed\n\\ No newline at end of file'
  );
  assert.equal(files.get('src/déplacé.ts')?.patch, '@@ -3,4 +3,4 @@ l2\n l3\n l4\n l5\n-l6\n+L6');
});
void test('empty and malformed diffs give no files', () => {
  assert.deepEqual(filesOfUnifiedDiff(''), []);
  assert.deepEqual(filesOfUnifiedDiff('\n'), []);
  assert.deepEqual(filesOfUnifiedDiff('not a diff\n'), []);
  // A header with no readable paths is skipped; its neighbours are kept.
  assert.deepEqual(
    filesOfUnifiedDiff('diff --git nonsense\ndiff --git a/x b/x\nindex 1111111..2222222 100644\n').map((f) => f.filename),
    ['x']
  );
});
void test('quoted header paths decode escapes; unquoted paths with " b/" pick the equal split', () => {
  const [tab, spaced, copied] = filesOfUnifiedDiff(
    'diff --git "a/t\\tab" "b/t\\tab"\nindex 1111111..2222222 100644\n' +
      'diff --git a/x b/y b/x b/y\nindex 1111111..3333333 100644\n' +
      'diff --git a/src.ts b/copy.ts\nsimilarity index 100%\ncopy from src.ts\ncopy to copy.ts\n'
  );
  assert.equal(tab.filename, 't\tab');
  assert.equal(spaced.filename, 'x b/y');
  assert.deepEqual([copied.filename, copied.status, copied.previous_filename], ['copy.ts', 'added', undefined]);
});
void test('the whole-diff fallback keeps listed entries, fills patches GitHub omitted, and adds the rest', async () => {
  const { createGitHubClientPool } = await import('./cache-test-pool');
  const { wholeDiffFiles } = await import('../lib/github');
  const pool = createGitHubClientPool({
    fetch: (() => Promise.resolve(new Response(DIFF, { headers: { 'content-type': 'application/vnd.github.diff; charset=utf-8' } }))) as typeof fetch,
  });
  const listed = [
    { filename: 'src/main.ts', status: 'modified', additions: 1, deletions: 1, patch: 'json patch', sha: 'f'.repeat(40) },
    // Past its size budget, GitHub's JSON comparison omits the patch and reports zero counts.
    { filename: 'crlf.txt', status: 'modified', additions: 0, deletions: 0, sha: 'c'.repeat(40) },
  ];
  const whole = await wholeDiffFiles(pool.client('one'), 'o', 'r', 'base', 'head', listed);
  assert.equal(whole?.files.length, 12);
  assert.equal(whole.added.size, 10);
  const main = whole.files.find((f) => f.filename === 'src/main.ts');
  assert.equal(main, listed[0], 'A listed entry with a patch is kept as it is');
  const crlf = whole.files.find((f) => f.filename === 'crlf.txt');
  assert.deepEqual(crlf, { ...listed[1], additions: 1, deletions: 1, patch: '@@ -1,2 +1,2 @@\n a\r\n-b\r\n+B\r' });
  // A diff that misses a listed file is not this comparison's list.
  assert.equal(await wholeDiffFiles(pool.client('one'), 'o', 'r', 'base', 'head', [...listed, { filename: 'absent.ts', additions: 0, deletions: 0 }]), undefined);
});
