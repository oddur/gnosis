import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStatCache } from '../src/stat-cache';
import { deepFreeze } from '../lib/deep-freeze';

void test('a cached file is read again only after it changes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-stat-cache-'));
  const file = path.join(directory, 'preferences.json');
  let reads = 0;
  const cache = createStatCache(
    () => file,
    (exists) => {
      reads++;
      return deepFreeze(
        exists ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { theme: string }) : { theme: 'default' }
      );
    }
  );
  try {
    assert.deepEqual(cache.get(), { theme: 'default' });
    assert.equal(cache.get(), cache.get());
    assert.equal(reads, 1, 'A missing file is cached too');
    fs.writeFileSync(file, JSON.stringify({ theme: 'dark' }));
    assert.deepEqual(cache.get(), { theme: 'dark' }, 'An external edit is picked up');
    assert.equal(reads, 2);
    assert.throws(() => {
      (cache.get() as { theme: string }).theme = 'light';
    }, TypeError);
    const written = deepFreeze({ theme: 'light' });
    fs.writeFileSync(file, JSON.stringify(written));
    cache.set(written);
    assert.equal(cache.get(), written, 'A write records its own value');
    assert.equal(reads, 2);
    cache.clear();
    assert.deepEqual(cache.get(), { theme: 'light' });
    assert.equal(reads, 3, 'Clearing reads the file again');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
