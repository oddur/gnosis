import test from 'node:test';
import assert from 'node:assert/strict';
import { createStartupPreferences } from '../lib/startup-preferences';
import type { Preferences } from '../lib/types';

const preferences = (theme: Preferences['theme']) => ({ theme }) as Preferences;
function api(initial = preferences('dark')) {
  let reads = 0;
  let saved = initial;
  let changed: ((prefs: Preferences) => void) | undefined;
  return {
    reads: () => reads,
    save: (next: Preferences) => {
      saved = next;
      changed?.(next);
    },
    loadPreferences: () => {
      reads++;
      return Promise.resolve(saved);
    },
    onPreferencesChanged: (callback: (prefs: Preferences) => void) => {
      changed = callback;
      return () => {};
    },
  };
}

void test('reads once', async () => {
  const source = api();
  const startup = createStartupPreferences(source);
  assert.equal(startup.current(), undefined);
  assert.equal((await startup.ready)?.theme, 'dark');
  assert.equal((await startup.ready)?.theme, 'dark');
  assert.equal((await startup.initial()).theme, 'dark', 'The first page uses the startup read');
  assert.equal(startup.current()?.theme, 'dark');
  assert.equal(source.reads(), 1);
  // Later pages and retries read again, so they never see stale values.
  await startup.initial();
  assert.equal(source.reads(), 2);
});

void test('updates on preferences-changed', async () => {
  const source = api();
  const startup = createStartupPreferences(source);
  await startup.ready;
  source.save(preferences('light'));
  assert.equal(startup.current()?.theme, 'light');
  assert.equal((await startup.initial()).theme, 'light');
  assert.equal((await startup.ready)?.theme, 'dark', 'Startup-only settings keep the startup read');

  const failing = createStartupPreferences({ loadPreferences: () => Promise.reject(new Error('Unreadable')) });
  assert.equal(await failing.ready, undefined, 'A failed read leaves settings recovery available');
});
