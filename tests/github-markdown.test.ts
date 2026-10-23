import test from 'node:test';
import assert from 'node:assert/strict';
import { githubMarkdownUrl } from '../lib/github-markdown';

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
