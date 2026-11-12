import test from 'node:test';
import assert from 'node:assert/strict';
import { githubMarkdownUrl, sameGitHubSource, sameMarkdownProps } from '../lib/github-markdown';

const source = { repo: 'owner/fork', ref: 'abc123' };
void test('PR Markdown resolves images and source links at the reviewed revision', () => {
  assert.equal(
    githubMarkdownUrl('docs/demo.png', true, source),
    'https://raw.githubusercontent.com/owner/fork/abc123/docs/demo.png'
  );
  assert.equal(
    githubMarkdownUrl('/src/index.ts', false, source),
    'https://github.com/owner/fork/blob/abc123/src/index.ts'
  );
  assert.equal(
    githubMarkdownUrl('https://github.com/owner/fork/blob/main/demo.png', true, source),
    'https://raw.githubusercontent.com/owner/fork/main/demo.png'
  );
  assert.equal(
    githubMarkdownUrl('/user-attachments/assets/example', true, source),
    'https://github.com/user-attachments/assets/example'
  );
  assert.equal(githubMarkdownUrl('https://example.com/demo.gif', true, source), 'https://example.com/demo.gif');
});
void test('PR Markdown rejects executable, local, and malformed image URLs', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///etc/passwd',
    'https://',
    'mailto:test@example.com',
    'irc://example.com',
    '#anchor',
  ]) {
    assert.equal(githubMarkdownUrl(url, true, source), '', url);
  }
});

void test('image blob URLs preserve owners or repositories named blob', () => {
  assert.equal(
    githubMarkdownUrl('https://github.com/blob/blob/blob/main/demo.png', true, source),
    'https://raw.githubusercontent.com/blob/blob/main/demo.png'
  );
});

void test('equal githubSource fields compare equal', () => {
  assert.equal(sameGitHubSource({ repo: 'owner/fork', ref: 'abc123' }, { repo: 'owner/fork', ref: 'abc123' }), true);
  assert.equal(sameGitHubSource({ repo: 'owner/fork', ref: 'abc123' }, { repo: 'owner/fork', ref: 'def456' }), false);
  assert.equal(sameGitHubSource({ repo: 'o/r', ref: 'a', path: 'docs/a.md' }, { repo: 'o/r', ref: 'a' }), false);
  assert.equal(sameGitHubSource(undefined, undefined), true);
  assert.equal(sameGitHubSource({ repo: 'o/r', ref: 'a' }, undefined), false);
  // PR details build a new source on each render; every other prop must still be compared.
  const props = { children: 'Text', githubSource: { repo: 'o/r', ref: 'a' }, headingLevel: 3 };
  assert.equal(sameMarkdownProps(props, { ...props, githubSource: { repo: 'o/r', ref: 'a' } }), true);
  assert.equal(sameMarkdownProps(props, { ...props, children: 'Changed' }), false);
  assert.equal(sameMarkdownProps(props, { ...props, headingLevel: 4 }), false);
  assert.equal(sameMarkdownProps<{ githubSource?: { repo: string; ref: string }; className?: string }>(props, { ...props, className: 'x' }), false);
});
