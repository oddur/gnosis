import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeReviewComment, commentAnchor, openReviewComment, reviewCommentOpen } from '../lib/review-comment';

/** Enter comments on the item under review (lib/review-comment.ts). */

// Two hunks: lines 3–4 replaced in the first, 20–22 added in the second; old line 30 deleted in the third.
const hunks = [
  { oldStart: 1, newStart: 1, rows: [{ type: ' ' }, { type: ' ' }, { type: '-' }, { type: '+' }, { type: '+' }, { type: ' ' }] as const },
  { oldStart: 18, newStart: 19, rows: [{ type: ' ' }, { type: '+' }, { type: '+' }, { type: '+' }, { type: ' ' }] as const },
  { oldStart: 29, newStart: 33, rows: [{ type: ' ' }, { type: '-' }, { type: ' ' }] as const },
];

void test("a symbol's comment covers its changed lines on its side, in its first hunk with changes", () => {
  // Its new lines in one hunk: the range from the first to the last.
  assert.deepEqual(commentAnchor({ lines: ['b3', 'a3', 'a4'], hunks }), { line: 4, startLine: 3, side: 'RIGHT' });
  // Across two hunks: a GitHub range cannot span them, so the first hunk's.
  assert.deepEqual(commentAnchor({ lines: ['a3', 'a4', 'a20', 'a21'], hunks }), { line: 4, startLine: 3, side: 'RIGHT' });
  // One line: no range.
  assert.deepEqual(commentAnchor({ lines: ['a21'], hunks }), { line: 21, side: 'RIGHT' });
});

void test('a removed symbol comments on the old side; the top level on its first line; a file on its first change', () => {
  assert.deepEqual(commentAnchor({ lines: ['b30'], hunks }), { line: 30, side: 'LEFT' }, 'Removed: the LEFT side');
  assert.deepEqual(commentAnchor({ lines: ['a20', 'a21', 'a22'], first: true, hunks }), { line: 20, side: 'RIGHT' }, 'Top level: its first changed line');
  assert.deepEqual(commentAnchor({ hunks }), { line: 3, side: 'LEFT' }, "A file without symbols: its first changed line, as the diff orders them");
  assert.equal(commentAnchor({ lines: ['a99'], hunks }), undefined, 'Nothing of it in the diff: nowhere to comment');
  assert.equal(commentAnchor({ hunks: undefined }), undefined, 'No patch');
});

void test('a composer opened for the item under review hands back how it closed, once', () => {
  const closed: string[] = [];
  assert.equal(reviewCommentOpen(), false);
  openReviewComment((how) => closed.push(how));
  assert.equal(reviewCommentOpen(), true);
  closeReviewComment('next');
  closeReviewComment('cancelled');
  assert.deepEqual(closed, ['next'], 'A composer opened elsewhere closes without it');
});
