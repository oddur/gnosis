import test from 'node:test';
import assert from 'node:assert/strict';
import type { Root, RootContent, Element } from 'hast';
import { buildMarkdownReview } from '../lib/markdown-review-engine';
import { isMarkdownFile, type MarkdownReviewRequest } from '../lib/markdown-review';
import { githubMarkdownUrl } from '../lib/github-markdown';
const source = { repo: 'owner/repo', ref: 'head', path: 'docs/guide.md' };
const request = (before: string | null, after: string | null): MarkdownReviewRequest => ({
  before,
  after,
  beforeSource: { ...source, ref: 'base' },
  afterSource: source,
});
const all = (node: Root | RootContent): RootContent[] =>
  node.type === 'element' || node.type === 'root'
    ? [...(node.type === 'root' ? [] : [node]), ...node.children.flatMap(all)]
    : [node];
const text = (node: Root | RootContent): string =>
  all(node)
    .filter((n) => n.type === 'text')
    .map((n) => n.value)
    .join('');
const tags = (node: Root, tag: string) =>
  all(node).filter((n): n is Element => n.type === 'element' && n.tagName === tag);
void test('word edits preserve readable paragraphs and clean final prose', async () => {
  const review = await buildMarkdownReview(
    request('# Retries\n\nRequests retry three times.', '# Retries\n\nRequests retry five times.')
  );
  assert.deepEqual(
    review.blocks.map((b) => b.change),
    ['unchanged', 'changed']
  );
  assert.equal(text(tags(review.blocks[1].tree, 'del')[0]), 'three');
  assert.equal(text(tags(review.blocks[1].tree, 'ins')[0]), 'five');
  assert.equal(text(review.clean), 'RetriesRequests retry five times.');
  assert.deepEqual(review.blocks[1].after, { side: 'after', start: 3, end: 3 });
});
void test('line wrapping is not presented as editorial change', async () => {
  const review = await buildMarkdownReview(
    request('Read these words\non two lines.', 'Read these words on two lines.')
  );
  assert.equal(review.sourceOnly, true);
  assert.equal(review.blocks[0].change, 'unchanged');
});
void test('changed list items and table cells preserve their document structure', async () => {
  const before = '- Keep this\n- Retry three times\n\n| Limit | Value |\n| --- | --- |\n| Retry | 3 |';
  const after = before.replace('three', 'five').replace('| 3 |', '| 5 |');
  const review = await buildMarkdownReview(request(before, after));
  assert.equal(tags(review.blocks[0].tree, 'ul').length, 1);
  assert.equal(tags(review.blocks[0].tree, 'li').length, 2);
  assert.equal(tags(review.blocks[1].tree, 'table').length, 1);
  assert.equal(tags(review.blocks[1].tree, 'del').map(text).join(''), '3');
});
void test('unchanged link text does not conceal a changed destination or reference definition', async () => {
  const review = await buildMarkdownReview(
    request('Read [the guide][ref].\n\n[ref]: old.md', 'Read [the guide][ref].\n\n[ref]: new.md')
  );
  assert.equal(review.blocks[0].change, 'changed');
  assert.match(text(review.blocks[0].tree), /link: old.md → new.md/);
  const links = tags(review.blocks[0].tree, 'a');
  assert.equal(links[0].properties.href, 'https://github.com/owner/repo/blob/base/docs/old.md');
  assert.equal(links[1].properties.href, 'https://github.com/owner/repo/blob/head/docs/new.md');
});
void test('formatting and heading-level changes stay visible', async () => {
  const review = await buildMarkdownReview(
    request('A **strong** point.\n\n## Title', 'A *strong* point.\n\n### Title')
  );
  assert.equal(review.sourceOnly, false);
  assert.equal(tags(review.blocks[0].tree, 'strong')[0].properties['data-md-change'], 'removed');
  assert.equal(tags(review.blocks[0].tree, 'em')[0].properties['data-md-change'], 'added');
  assert.deepEqual(
    review.blocks.slice(1).map((b) => b.change),
    ['removed', 'added']
  );
});
void test('unique moved blocks appear once at the new location', async () => {
  const review = await buildMarkdownReview(request('Alpha.\n\nBravo.\n\nCharlie.', 'Bravo.\n\nAlpha.\n\nCharlie.'));
  assert.equal(review.blocks.filter((b) => b.change === 'moved').length, 1);
  assert.equal(review.blocks.length, 3);
  assert.equal(review.blocks.map((b) => text(b.tree)).join('|'), 'Bravo.|Alpha.|Charlie.');
});
void test('added and deleted documents retain source identity', async () => {
  const added = await buildMarkdownReview(request(null, '# Hello\n\nNew document.'));
  assert.equal(
    added.blocks.every((b) => b.change === 'added' && !b.before && b.after),
    true
  );
  const deleted = await buildMarkdownReview(request('# Hello', null));
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.blocks[0].change, 'removed');
  assert.equal(deleted.clean.children.length, 0);
});
void test('unsafe HTML never enters the renderer and image paths use the correct file directory and revision', async () => {
  const review = await buildMarkdownReview(
    request(
      '![Old](../old.png)',
      '<script>alert(1)</script>\n\n<img src="images/new.svg" onerror="alert(1)"><iframe src="https://evil.test"></iframe>\n\n[Bad](javascript:alert(1))'
    )
  );
  assert.equal(tags(review.clean, 'script').length, 0);
  assert.equal(tags(review.clean, 'iframe').length, 0);
  const img = tags(review.clean, 'img')[0];
  assert.equal(img.properties.src, 'https://raw.githubusercontent.com/owner/repo/head/docs/images/new.svg');
  assert.equal(img.properties.onError, undefined);
  assert.equal(tags(review.clean, 'a')[0].properties.href, undefined);
  const oldImg = review.blocks
    .flatMap((b) => tags(b.tree, 'img'))
    .find((n) => String(n.properties.src).includes('old.png'));
  assert.equal(oldImg?.properties.src, 'https://raw.githubusercontent.com/owner/repo/base/old.png');
});
void test('code indentation is substantive and diagram changes remain separate before/after blocks', async () => {
  const before = '```python\nif ready:\n  run()\n```';
  const review = await buildMarkdownReview(request(before, before.replace('  run()', 'run()')));
  assert.equal(review.sourceOnly, false);
  assert.deepEqual(
    review.blocks.map((b) => b.change),
    ['changed']
  );
  assert.equal(tags(review.blocks[0].tree, 'pre').length, 1);
  assert.ok(
    all(review.blocks[0].tree).some((n) => n.type === 'element' && n.properties['data-md-change'] === 'removed')
  );
  const diagrams = await buildMarkdownReview(request('```mermaid\nA --> B\n```', '```mermaid\nA --> C\n```'));
  assert.deepEqual(
    diagrams.blocks.map((b) => b.change),
    ['removed', 'added']
  );
});
void test('preview limits and file recognition leave source as an escape hatch', async () => {
  await assert.rejects(buildMarkdownReview(request(null, 'x'.repeat(500_001))), /too large/);
  assert.equal(isMarkdownFile('docs/README.MD'), true);
  assert.equal(isMarkdownFile('docs/page.mdx'), false);
  assert.equal(isMarkdownFile('script.js'), false);
});
void test('relative paths include encoded file directories; root paths remain repository-relative', () => {
  assert.equal(
    githubMarkdownUrl('./a.png', true, { ...source, path: 'docs/my folder/readme.md' }),
    'https://raw.githubusercontent.com/owner/repo/head/docs/my%20folder/a.png'
  );
  assert.equal(githubMarkdownUrl('/a.png', true, source), 'https://raw.githubusercontent.com/owner/repo/head/a.png');
});

void test('focused previews keep context, heading ancestry and comments; gaps expand without losing changes', async () => {
  const { markdownReviewContext, markdownBlockAt } = await import('../lib/markdown-review-context');
  const before =
    '# Guide\n\nIntroduction.\n\n## Setup\n\nFirst step.\n\nSecond step.\n\nThird step.\n\nFourth step.\n\nFifth step.\n\n## Retries\n\nWait briefly.\n\nTry three times.\n\nLog the result.\n\nArchive the log.\n\nKeep a backup.\n\nFinish.';
  const review = await buildMarkdownReview(request(before, before.replace('three', 'five')));
  const items = markdownReviewContext(review.blocks);
  const shown = items.flatMap((item) => (item.kind === 'block' ? [text(item.block.tree)] : []));
  assert.deepEqual(shown, ['Guide', 'Retries', 'Wait briefly.', 'Try threefive times.', 'Log the result.']);
  assert.equal(items.filter((item) => item.kind === 'gap').length, 2);
  const comment = review.blocks.find((block) => text(block.tree) === 'Third step.');
  assert.ok(comment);
  const withComments = markdownReviewContext(review.blocks, new Set([comment.id]));
  for (const value of ['Setup', 'Second step.', 'Third step.', 'Fourth step.']) {
    assert.ok(withComments.some((item) => item.kind === 'block' && text(item.block.tree) === value));
  }
  assert.equal(markdownBlockAt(review.blocks, comment.after)?.id, comment.id);
  const expanded = markdownReviewContext(review.blocks, new Set(), new Set(review.blocks.map((block) => block.id)));
  assert.equal(expanded.length, review.blocks.length);
  assert.ok(expanded.every((item) => item.kind === 'block'));
});

void test('focused previews preserve whole added, deleted and source-only documents', async () => {
  const { markdownReviewContext } = await import('../lib/markdown-review-context');
  const document = '# Guide\n\nOne.\n\nTwo.\n\nThree.\n\nFour.';
  for (const input of [request(null, document), request(document, null), request(document, document + '\n')]) {
    const review = await buildMarkdownReview(input);
    assert.ok(markdownReviewContext(review.blocks).every((item) => item.kind === 'block'));
  }
});

void test('explanation previews merge overlapping saved sections and retain original coordinates across gaps', async () => {
  const { buildExplanationMarkdown } = await import('../lib/explanation-markdown');
  const hunk = (header: string, content: string) => ({
    filePath: 'docs/guide.md',
    hunkHeader: header,
    content,
    language: 'markdown',
    renderedHtml: '',
  });
  const result = await buildExplanationMarkdown({
    kind: 'explanation',
    fileStatus: 'modified',
    beforeSource: source,
    afterSource: source,
    hunks: [
      hunk('@@ -20,3 +20,3 @@', ' ## Policy\n \n-Retry three times.\n+Retry five times.'),
      hunk('@@ -22,2 +22,2 @@', '-Retry three times.\n+Retry five times.\n Keep the ID.'),
      hunk('@@ -80,1 +82,1 @@', '-Old warning.\n+New warning.'),
    ],
  });
  assert.equal(result.excerpt, true);
  assert.equal(text(result.clean), 'PolicyRetry five times.\nKeep the ID.Between saved sectionsNew warning.');
  const changed = result.blocks.filter((block) => block.change === 'changed');
  assert.equal(changed.length, 2);
  assert.deepEqual(changed[0].before, { side: 'before', start: 22, end: 23 });
  assert.equal(tags(changed[0].tree, 'del')[0].properties['data-md-side'], 'before');
  assert.equal(tags(changed[0].tree, 'del')[0].properties['data-md-start'], 22);
  assert.equal(changed[1].before?.start, 80);
  assert.equal(changed[1].after?.start, 82);
  const { markdownReviewContext } = await import('../lib/markdown-review-context');
  assert.ok(markdownReviewContext(result.blocks).some((item) => item.kind === 'block' && item.block.sourceGap));
});

void test('explanation previews reject contradictory overlapping sections and malformed saved diffs', async () => {
  const { buildExplanationMarkdown } = await import('../lib/explanation-markdown');
  const hunk = {
    filePath: 'README.md',
    hunkHeader: '@@ -1 +1 @@',
    content: '-Before\n+After',
    language: 'markdown',
    renderedHtml: '',
  };
  const request = { kind: 'explanation' as const, beforeSource: source, afterSource: source, hunks: [hunk] };
  await assert.rejects(
    buildExplanationMarkdown({ ...request, hunks: [hunk, { ...hunk, content: '-Different\n+After' }] }),
    /disagree/
  );
  await assert.rejects(
    buildExplanationMarkdown({ ...request, hunks: [{ ...hunk, hunkHeader: 'no coordinates' }] }),
    /cannot be rendered/
  );
  assert.equal(githubMarkdownUrl('./private.md', false, { repo: '', ref: '', path: 'docs/a.md' }), '');
});
