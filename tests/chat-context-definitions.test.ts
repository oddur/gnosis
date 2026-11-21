import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefinitionsCache } from '../src/chat-context-definitions';
import { keepChatPreferences } from '../lib/chat-preferences';
import type { Preferences } from '../lib/types';

const file = {
  path: 'src/a.ts',
  status: 'modified',
  additions: 1,
  deletions: 0,
  patch: '@@ -1 +1 @@\n+export function run() {}',
};

void test('a parse that timed out or failed is not kept: the next question parses again', async () => {
  let mode: 'hang' | 'fail' | 'throw' | 'ok' = 'hang';
  let parses = 0;
  const cache = createDefinitionsCache((items) => {
    parses++;
    if (mode === 'hang') return new Promise(() => {});
    if (mode === 'throw') return Promise.reject(new Error('worker gone'));
    return Promise.resolve({
      results: mode === 'ok' ? { [items[0].path]: [{ name: 'run', kind: 'function', start: 1, end: 2 }] } : {},
      failed: mode === 'fail' ? items.map((i) => i.path) : [],
    });
  }, 50);
  assert.deepEqual(await cache.definitions('rev', [file]), {}, 'A timeout gives nothing');
  assert.deepEqual(cache.cached('rev'), [], 'and keeps nothing');
  mode = 'fail';
  assert.deepEqual(await cache.definitions('rev', [file]), {});
  assert.deepEqual(cache.cached('rev'), [], 'A file whose parse threw is not kept');
  mode = 'throw';
  assert.deepEqual(await cache.definitions('rev', [file]), {});
  assert.deepEqual(cache.cached('rev'), [], 'Nor is anything when the parse itself failed');
  mode = 'ok';
  assert.deepEqual(await cache.definitions('rev', [file]), {
    'src/a.ts': [{ name: 'run', kind: 'function', start: 1, end: 2 }],
  });
  assert.deepEqual(cache.cached('rev'), ['hunks:src/a.ts'], 'A finished parse is kept');
  mode = 'hang';
  const before = parses;
  assert.equal((await cache.definitions('rev', [file]))['src/a.ts'].length, 1, 'and answers from the cache');
  assert.equal(parses, before, 'without parsing again');
});

void test('a full preferences save keeps the chat fields a chat save wrote', () => {
  const onDisk = {
    theme: 'dark',
    chatPanelWidths: { file: 560 },
    chatModels: { topic: { provider: 'claude', model: 'claude-haiku-5-5' } },
    chatContextTokens: 128_000,
  } as Partial<Preferences>;
  // Settings saves its own copy, read before the chat save.
  const stale = { theme: 'light', chatPanelWidths: { file: 400 } } as Partial<Preferences>;
  assert.deepEqual(keepChatPreferences(stale, onDisk), {
    theme: 'light',
    chatPanelWidths: { file: 560 },
    chatModels: { topic: { provider: 'claude', model: 'claude-haiku-5-5' } },
    chatContextTokens: 128_000,
  });
  assert.deepEqual(keepChatPreferences({ theme: 'light', chatContextTokens: 32_000 } as Partial<Preferences>, {}), {
    theme: 'light',
  });
});
