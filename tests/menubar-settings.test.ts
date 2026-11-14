import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MENUBAR_SETTINGS, menubarBadge, menubarSettings } from '../lib/menubar-settings';
import type { AttentionItem } from '../lib/attention';

void test('defaults, and an old preferences file without the setting', () => {
  assert.deepEqual(menubarSettings(undefined), { click: 'panel', badge: 'new' });
  assert.deepEqual(menubarSettings({ trayEnabled: true, theme: 'dark' }), DEFAULT_MENUBAR_SETTINGS);
});

void test('saved values are kept; invalid values fall back one by one', () => {
  assert.deepEqual(menubarSettings({ menubarSettings: { click: 'menu', badge: 'dot' } }), { click: 'menu', badge: 'dot' });
  assert.deepEqual(menubarSettings({ menubarSettings: { click: 'popover', badge: 'all' } }), { click: 'panel', badge: 'all' });
  assert.deepEqual(menubarSettings({ menubarSettings: { badge: 7 } }), DEFAULT_MENUBAR_SETTINGS);
  assert.deepEqual(menubarSettings({ menubarSettings: 'menu' }), DEFAULT_MENUBAR_SETTINGS);
  assert.deepEqual(menubarSettings(null), DEFAULT_MENUBAR_SETTINGS);
});

const rows = (fresh: number, seen: number) =>
  Array.from({ length: fresh + seen }, (_, i) => ({ id: String(i), isNew: i < fresh }) as AttentionItem);

void test('the badge for each mode: new, all, dot, none', () => {
  assert.deepEqual(menubarBadge(rows(2, 3), 'new'), { title: '2', dot: false, count: 2 });
  assert.deepEqual(menubarBadge(rows(2, 3), 'all'), { title: '5', dot: false, count: 5 });
  assert.deepEqual(menubarBadge(rows(2, 3), 'dot'), { title: '', dot: true, count: 2 });
  assert.deepEqual(menubarBadge(rows(0, 3), 'dot'), { title: '', dot: false, count: 0 });
  assert.deepEqual(menubarBadge(rows(2, 3), 'none'), { title: '', dot: false, count: 0 });
});

void test('no title for zero, 99+ above 99', () => {
  assert.equal(menubarBadge(rows(0, 4), 'new').title, '');
  assert.equal(menubarBadge(rows(99, 0), 'new').title, '99');
  assert.equal(menubarBadge(rows(140, 0), 'new').title, '99+');
});
