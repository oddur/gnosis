import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fresherPrCopy, prState, prStateName, type PrStateSource } from '../lib/pr-state';
import { knownPrCopy, notePrCopy, resetPrCopies } from '../lib/pr-state-store';

void test('derives GitHub states from REST copies: merged wins, draft only applies to open PRs', () => {
  assert.equal(prState({ state: 'open', merged: false, isDraft: false }), 'open');
  assert.equal(prState({ state: 'open', merged: false, isDraft: true }), 'draft');
  assert.equal(prState({ state: 'closed', merged: true, isDraft: false }), 'merged');
  assert.equal(prState({ state: 'closed', merged: false, isDraft: false }), 'closed');
  // A draft that was closed, or merged, shows its lifecycle, not the draft flag.
  assert.equal(prState({ state: 'closed', merged: false, isDraft: true }), 'closed');
  assert.equal(prState({ state: 'closed', merged: true, isDraft: true }), 'merged');
});

void test('accepts GraphQL states and the labels search documents store', () => {
  assert.equal(prState({ state: 'OPEN' }), 'open');
  assert.equal(prState({ state: 'MERGED' }), 'merged');
  assert.equal(prState({ state: 'CLOSED' }), 'closed');
  assert.equal(prState({ state: 'Draft' }), 'draft');
  assert.equal(prState({ state: 'Merged' }), 'merged');
});

void test('an unknown state is undefined, never a guess', () => {
  assert.equal(prState(undefined), undefined);
  assert.equal(prState(null), undefined);
  assert.equal(prState({}), undefined);
  assert.equal(prState({ url: 'https://github.com/o/r/pull/1' }), undefined);
  // A draft flag alone, without a lifecycle, does not say the PR is still open.
  assert.equal(prState({ isDraft: true }), undefined);
  assert.equal(prState({ state: 'unknown' }), undefined);
});

void test('accessible names do not read as an action', () => {
  assert.equal(prStateName('open'), 'PR state: Open');
  assert.equal(prStateName('draft'), 'PR state: Draft');
  assert.equal(prStateName('merged'), 'PR state: Merged');
  assert.equal(prStateName('closed'), 'PR state: Closed');
  assert.equal(prStateName(undefined), 'Pull request');
});

const open: PrStateSource = { state: 'open', merged: false, isDraft: false, updatedAt: '2026-11-14T09:00:00Z' };
const merged: PrStateSource = { state: 'closed', merged: true, isDraft: false, updatedAt: '2026-11-14T10:00:00Z' };

void test('the fresher copy wins by updatedAt, and a tie never reopens a merged or closed PR', () => {
  assert.equal(fresherPrCopy(open, merged), merged);
  assert.equal(fresherPrCopy(merged, open), merged);
  const tiedMerged = { ...merged, updatedAt: open.updatedAt };
  assert.equal(fresherPrCopy(open, tiedMerged), tiedMerged);
  assert.equal(fresherPrCopy(tiedMerged, open), tiedMerged);
  // On a tie between open copies the copy on hand wins, so an optimistic draft change shows where it was made.
  const draft = { ...open, isDraft: true };
  assert.equal(fresherPrCopy(draft, open), draft);
  assert.equal(fresherPrCopy(open, draft), open);
});

void test('a copy with no state never replaces a known one, and a known one fills an unknown copy', () => {
  const loading: PrStateSource = { url: 'https://github.com/o/r/pull/1' };
  assert.equal(fresherPrCopy(open, loading), open);
  assert.equal(fresherPrCopy(loading, open), open);
  assert.equal(fresherPrCopy(null, open), open);
  assert.equal(fresherPrCopy(open, undefined), open);
});

void test('the window store keeps the freshest copy of each PR, so older copies elsewhere follow a merge', () => {
  resetPrCopies();
  const url = 'https://github.com/o/r/pull/2';
  notePrCopy(url, open);
  assert.equal(prState(knownPrCopy(url)), 'open');
  notePrCopy(url, merged);
  assert.equal(prState(knownPrCopy(url)), 'merged');
  // A stale saved copy shown later does not reopen it.
  notePrCopy(url, open);
  assert.equal(prState(knownPrCopy(url)), 'merged');
  // A stale tab copy resolves to the merge.
  assert.equal(prState(fresherPrCopy(open, knownPrCopy(url))), 'merged');
  // A draft change with the same updatedAt, reported last, reaches older copies.
  const other = 'https://github.com/o/r/pull/3';
  notePrCopy(other, open);
  notePrCopy(other, { ...open, isDraft: true });
  assert.equal(prState(knownPrCopy(other)), 'draft');
  resetPrCopies();
});
