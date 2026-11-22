import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONFLICT_SHORTCUTS, conflictShortcuts, hasGlyph, isReviewAndPushKey, nextCompare, nextNeedingYou, spokenKeys } from '../lib/conflict-shortcuts';

/** The conflict keyboard map (#445 item 13). */
void test('Accept moves focus to the next conflict that needs you, wrapping round, then to the next action', () => {
  const none = new Set<number>();
  assert.equal(nextNeedingYou([0, 2, 5], 2, none), 5);
  assert.equal(nextNeedingYou([0, 2, 5], 5, none), 0, 'after the last it wraps to the first');
  assert.equal(nextNeedingYou([0, 2, 5], 3, none), 5, 'from a conflict that left the list');
  // A proposal accepted in Check still needs your review of the file, but Accept passes over it.
  assert.equal(nextNeedingYou([0, 2, 5], 2, new Set([5])), 0);
  assert.equal(nextNeedingYou([2], 2, none), undefined, 'never the accepted conflict itself');
  assert.equal(nextNeedingYou([0, 2], 2, new Set([0])), undefined, 'none left: the next action has focus');
  assert.equal(nextNeedingYou([], 0, none), undefined);
});

void test('V cycles Compare with PR, main and both, skipping both while there is nothing to compare', () => {
  assert.equal(nextCompare('pr', false), 'main');
  assert.equal(nextCompare('main', false), 'both');
  assert.equal(nextCompare('both', false), 'pr');
  assert.equal(nextCompare('main', true), 'pr');
  assert.equal(nextCompare('both', true), 'pr');
});

void test('Review and push… takes Cmd+Enter on macOS and Ctrl+Enter elsewhere, and nothing else', () => {
  const key = (extra: Partial<KeyboardEvent>) => ({
    key: 'Enter',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...extra,
  });
  assert.equal(isReviewAndPushKey(key({ metaKey: true }), true), true);
  assert.equal(isReviewAndPushKey(key({ ctrlKey: true }), false), true);
  assert.equal(isReviewAndPushKey(key({}), true), false, 'Enter alone never');
  assert.equal(isReviewAndPushKey(key({ ctrlKey: true }), true), false, 'the other platform’s modifier never');
  assert.equal(isReviewAndPushKey(key({ metaKey: true }), false), false);
  assert.equal(isReviewAndPushKey(key({ metaKey: true, shiftKey: true }), true), false);
  assert.equal(isReviewAndPushKey(key({ metaKey: true, ctrlKey: true }), true), false);
  assert.equal(isReviewAndPushKey(key({ key: 'a', metaKey: true }), true), false);
});

void test('The legend lists every key the view takes', () => {
  const keys = CONFLICT_SHORTCUTS.flatMap((s) => s.keys.split(/\s+/));
  for (const k of ['j', 'k', 'a', '1', '2', '3', 'u', 'v', 'g', 'm', 'n', 'p', '↵', 'Esc'])
    assert.ok(keys.includes(k), `${k} is in the legend`);
});

void test('The legend names its glyphs for screen readers, and U says it undoes the last accept', () => {
  assert.equal(spokenKeys('⌘ ↵'), 'Command Enter');
  assert.equal(hasGlyph('⌘ ↵'), true);
  assert.equal(hasGlyph('Ctrl ↵'), true);
  assert.equal(hasGlyph('j  k'), false);
  assert.match(CONFLICT_SHORTCUTS.find((s) => s.keys === 'u')?.label ?? '', /right after A, that choice/);
  assert.equal(CONFLICT_SHORTCUTS.find((s) => s.keys === 'g')?.label, 'Turn on Review Merged-only files myself');
  // The Keep and Compare labels name the base branch, as the buttons do; the overlay says "the base branch".
  assert.equal(conflictShortcuts('main').find((s) => s.keys === '1  2  3')?.label, 'Keep PR change / main’s change / both');
  assert.equal(conflictShortcuts('main').find((s) => s.keys === 'v')?.label, 'Compare with PR, main or both');
  assert.match(CONFLICT_SHORTCUTS.find((s) => s.keys === '1  2  3')?.label ?? '', /the base branch’s change/);
});
