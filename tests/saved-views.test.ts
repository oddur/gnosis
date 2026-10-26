import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeViews,
  editViewFilters,
  applyViewAction,
  activeViewFilters,
  viewIsModified,
} from '../lib/saved-views';
import { createSavedViewStore } from '../src/saved-view-store';

void test('saved filters and per-view drafts are independent through switching, updates, reset and duplication', () => {
  let id = 0;
  const newId = () => String(++id);
  let state = normalizeViews(null, { repo: 'a/repo', createdWithin: 30 });
  state = applyViewAction(state, { type: 'create', name: 'Recent' }, newId);
  state = editViewFilters(state, { repo: 'a/repo', createdWithin: 7 });
  assert.ok(viewIsModified(state.views[0]));
  state = applyViewAction(state, { type: 'create', name: 'This week' }, newId);
  assert.equal(state.views[0].filters.createdWithin, 30);
  assert.equal(state.views[1].filters.createdWithin, 7);
  state = applyViewAction(state, { type: 'activate', id: '1' }, newId);
  assert.equal(activeViewFilters(state).createdWithin, 7);
  state = applyViewAction(state, { type: 'duplicate', id: '1' }, newId);
  assert.equal(state.views[2].filters.createdWithin, 30, 'Duplicate copies the saved definition');
  state = applyViewAction(state, { type: 'update', id: '1' }, newId);
  assert.equal(state.views[0].filters.createdWithin, 7);
  state = applyViewAction(state, { type: 'activate', id: '1' }, newId);
  state = editViewFilters(state, { author: 'alice' });
  state = applyViewAction(state, { type: 'reset', id: '1' }, newId);
  assert.equal(activeViewFilters(state).createdWithin, 7);
  assert.equal(viewIsModified(state.views[0]), false);
  state = applyViewAction(state, { type: 'activate', id: null }, newId);
  assert.equal(activeViewFilters(state).createdWithin, 30, 'Review queue keeps its own filters');
});
void test('names, ordering and deletion are deterministic and invalid actions do not mutate state', () => {
  let id = 0;
  const nextId = () => String(++id);
  let state = normalizeViews(null);
  for (const name of ['Mine', 'Recent', 'Drafts']) state = applyViewAction(state, { type: 'create', name }, nextId);
  assert.throws(() => applyViewAction(state, { type: 'rename', id: '2', name: ' mine ' }, nextId), /already/);
  assert.throws(() => applyViewAction(state, { type: 'create', name: ' ' }, nextId), /Enter/);
  state = applyViewAction(state, { type: 'move', id: '3', beforeId: '1' }, nextId);
  assert.deepEqual(
    state.views.map((v) => v.name),
    ['Drafts', 'Mine', 'Recent']
  );
  state = applyViewAction(state, { type: 'move', id: '3', beforeId: null }, nextId);
  assert.deepEqual(
    state.views.map((v) => v.name),
    ['Mine', 'Recent', 'Drafts']
  );
  state = applyViewAction(state, { type: 'delete', id: '3' }, nextId);
  assert.equal(state.activeId, null);
  assert.equal(state.views.length, 2);
});
void test('view order, active selection and drafts persist separately for each GitHub account', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnosis-views-'));
  try {
    const store = createSavedViewStore(() => dir);
    store.load('alice', { repo: 'org/repo' });
    const created = store.act('alice', { type: 'create', name: 'Mine' });
    store.edit('alice', { involvement: 'mine', status: 'draft' });
    store.load('bob');
    assert.equal(store.load('bob').views.length, 0);
    const restart = createSavedViewStore(() => dir);
    const saved = restart.load('ALICE');
    assert.equal(saved.activeId, created.activeId);
    assert.equal(activeViewFilters(saved).status, 'draft');
    assert.equal(saved.views[0].filters.repo, 'org/repo');
    assert.ok(viewIsModified(saved.views[0]));
    assert.equal(restart.load('bob').views.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
