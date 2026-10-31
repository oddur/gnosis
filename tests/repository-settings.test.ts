import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRepositorySettings, repositorySettings, subjectRecentlyUpdated, discoveryInactivityDays, automaticBriefingBlock, briefingBudget, localBriefingDay, briefingResetAt, repositoryDiscoverySettings } from '../lib/repository-settings';
import type { ReviewSubject } from '../lib/workbench';
const defaults = { prInactivityDays: 30, ignoreDependabotPrs: true, autoBriefings: false, briefingDailyLimit: 20, repositoryBriefingDailyLimit: 10 };
const now = new Date(2026, 9, 31, 12).getTime();
const subject = { id: 'stack', kind: 'stack', members: [
  { repo: 'ORG/One', url: 'one', state: 'open', merged: false, updatedAt: new Date(now - 60 * 86400000).toISOString() },
  { repo: 'org/two', url: 'two', state: 'open', merged: false, updatedAt: new Date(now - 60 * 86400000).toISOString() },
] } as ReviewSubject;
void test('repository overrides inherit independently and validate persisted input', () => {
  const map = normalizeRepositorySettings({ 'ORG/One': { autoBriefings: true, briefingDailyLimit: 0, prInactivityDays: 0, icon: 'emoji:🚀', color: 'purple' },
    'org/two': { ignoreDependabotPrs: false, briefingDailyLimit: -1, icon: 'bad', color: 'url(evil)' }, bad: {}, 'org/three': { autoBriefings: 'false', prInactivityDays: 1.5 } });
  assert.deepEqual(Object.keys(map), ['org/one', 'org/two']);
  assert.deepEqual(map['org/two'], { ignoreDependabotPrs: false });
  const one = repositorySettings({ ...defaults, repositorySettings: map }, 'ORG/One');
  assert.equal(one.autoBriefings, true); assert.equal(one.prInactivityDays, 0); assert.equal(one.briefingDailyLimit, 0);
  assert.equal(repositorySettings({ ...defaults, repositorySettings: map }, 'org/two').briefingDailyLimit, 10);
  assert.equal(repositorySettings({ ...defaults, ignoreDependabotPrs: false, repositorySettings: map }, 'org/one').ignoreDependabotPrs, false);
});
void test('discovery widens for repository exceptions without applying that exception to other repositories', () => {
  const p = { ...defaults, repositorySettings: { 'org/one': { prInactivityDays: 90 } } };
  assert.equal(discoveryInactivityDays(p), 90);
  assert.equal(subjectRecentlyUpdated(subject, p, now, new Set()), true);
  assert.equal(subjectRecentlyUpdated({ ...subject, members: [subject.members[1]] }, p, now, new Set()), false);
  assert.equal(subjectRecentlyUpdated(subject, defaults, now, new Set(['two'])), true);
  assert.equal(discoveryInactivityDays({ ...p, repositorySettings: { 'org/one': { prInactivityDays: 0 } } }), 0);
  assert.deepEqual(repositoryDiscoverySettings({ ...p, repositorySettings: { ...p.repositorySettings, 'org/two': { color: 'blue', autoBriefings: true } } }), [['org/one', 90, undefined]]);
});
void test('every repository in a stack must allow automatic briefings and have allowance', () => {
  const p = { ...defaults, repositorySettings: { 'org/one': { autoBriefings: true }, 'org/two': { autoBriefings: true, briefingDailyLimit: 2 } } };
  assert.equal(automaticBriefingBlock(subject, p, 0, {}), undefined);
  assert.match(automaticBriefingBlock(subject, { ...p, repositorySettings: { 'org/one': { autoBriefings: true } } }, 0, {}) ?? '', /off for org\/two/);
  assert.match(automaticBriefingBlock(subject, p, 0, { 'org/two': 2 }) ?? '', /limit reached for org\/two/);
  assert.match(automaticBriefingBlock(subject, p, 20, {}) ?? '', /Overall/);
  const budget = briefingBudget(p, ['ORG/One', 'org/one', 'org/two'], 4, { 'org/one': 4, 'org/two': 1 }, now);
  assert.equal(budget.remaining, 16); assert.equal(budget.repositories['org/one'].remaining, 6); assert.equal(budget.repositories['org/two'].remaining, 1);
});
void test('daily reset follows local midnight including DST calendar boundaries', () => {
  const before = new Date(2026, 9, 25, 0, 5).getTime();
  assert.equal(localBriefingDay(before), '2026-10-25');
  const reset = new Date(briefingResetAt(before));
  assert.equal(reset.getDate(), 26); assert.equal(reset.getHours(), 0);
  assert.equal(localBriefingDay(reset.getTime() - 1), '2026-10-25');
  assert.equal(localBriefingDay(reset.getTime()), '2026-10-26');
});

void test('all installed Lucide icons are valid repository choices; legacy choices retain their meaning', async () => {
  const { default: names } = await import('../lib/lucide-icon-names.json');
  const { repositoryLucideName, validRepositoryIcon } = await import('../lib/repository-settings');
  const { readFileSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  const path = await import('node:path');
  const require = createRequire(import.meta.url);
  const manifest = readFileSync(path.join(path.dirname(require.resolve('lucide-react/package.json')), 'dist/esm/dynamicIconImports.js'), 'utf8');
  const installed = [...manifest.matchAll(/"([a-z0-9-]+)":/g)].map(match => match[1]).sort();
  assert.deepEqual(names, installed, 'Run node scripts/sync-lucide-icons.mjs after updating Lucide');
  assert.ok(names.length > 1900);
  for (const name of names) assert.equal(validRepositoryIcon(`lucide:${name}`), true);
  assert.equal(repositoryLucideName('book'), 'book-marked');
  assert.equal(repositoryLucideName('lucide:book'), 'book');
  assert.equal(repositoryLucideName('flask'), 'flask-conical');
  assert.equal(validRepositoryIcon('lucide:not-an-icon'), false);
  assert.equal(normalizeRepositorySettings({ 'org/repo': { icon: 'lucide:telescope', color: 'purple' } })['org/repo'].icon, 'lucide:telescope');
});
