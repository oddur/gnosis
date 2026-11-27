/**
 * Enter comments on the item the reader is reviewing (lib/tree-symbol-review.ts `currentItem`, as V uses): the inline
 * composer opens over the item's lines, and saving or cancelling returns the keyboard to where the reader was, so V
 * and n go on. ⌘⇧↩ in that composer saves and then does what V does.
 */

/** Where a GitHub line comment goes: a line, or a range on one side (`startLine`..`line`). */
export interface CommentAnchor {
  line: number;
  startLine?: number;
  side: 'LEFT' | 'RIGHT';
}
type Hunk = { oldStart: number; newStart: number; rows: readonly { type: ' ' | '+' | '-' }[] };

/**
 * Where a comment on an item goes:
 * - a symbol or a Body: its changed lines on its side (the new file's, or the old file's for a removed symbol, whose
 *   lines are all deleted ones), from the first to the last of them in the first hunk that has any, since a GitHub
 *   range cannot span hunks;
 * - the top level (`first`): its first changed line;
 * - a file without symbols (no lines): the file's first changed line.
 * Undefined when there is nowhere to put it.
 */
export function commentAnchor({ lines, first, hunks }: { lines?: readonly string[]; first?: boolean; hunks: readonly Hunk[] | undefined }): CommentAnchor | undefined {
  if (!hunks?.length) return undefined;
  // Each changed line's hunk, in the diff's order.
  const order: { key: string; hunk: number }[] = [];
  hunks.forEach((hunk, index) => {
    let oldLine = hunk.oldStart,
      newLine = hunk.newStart;
    for (const row of hunk.rows) {
      if (row.type === '+') order.push({ key: `a${newLine}`, hunk: index });
      else if (row.type === '-') order.push({ key: `b${oldLine}`, hunk: index });
      if (row.type !== '+') oldLine++;
      if (row.type !== '-') newLine++;
    }
  });
  const at = (key: string) => ({ line: Number(key.slice(1)), side: key[0] === 'b' ? ('LEFT' as const) : ('RIGHT' as const) });
  if (!lines) return order.length ? at(order[0].key) : undefined;
  const mine = new Set(lines);
  const own = order.filter((item) => mine.has(item.key));
  if (!own.length) return undefined;
  if (first) return at(own[0].key);
  // Its side: the new file's lines when it has any, else the old file's (a removed symbol, or one only deleted from).
  const side = own.some((item) => item.key[0] === 'a') ? 'a' : 'b';
  const onSide = own.filter((item) => item.key[0] === side);
  const hunk = onSide[0].hunk;
  const numbers = onSide.filter((item) => item.hunk === hunk).map((item) => Number(item.key.slice(1)));
  const start = Math.min(...numbers),
    end = Math.max(...numbers);
  return { line: end, ...(start !== end ? { startLine: start } : {}), side: side === 'b' ? 'LEFT' : 'RIGHT' };
}

/** How a composer opened for an item closed: saved, saved and on to the next item (⌘⇧↩), or cancelled. */
export type CommentClose = 'saved' | 'next' | 'cancelled';
let session: ((how: CommentClose) => void) | undefined;
/** A composer opened for the item under review: `onClose` puts the keyboard back, or goes on as V does. */
export function openReviewComment(onClose: (how: CommentClose) => void) {
  session = onClose;
}
/** Whether the open composer was opened for the item under review (⌘⇧↩ then saves and goes on). */
export const reviewCommentOpen = () => !!session;
/** The composer closed: the review that opened it hears how, once. */
export function closeReviewComment(how: CommentClose) {
  const close = session;
  session = undefined;
  close?.(how);
}

/** The lines the reader selected in each file's diff (its gutter selection), by file revision key: Enter comments on those. */
type LineSelection = { start: number; end: number; side?: 'deletions' | 'additions'; endSide?: 'deletions' | 'additions' };
const selections = new Map<string, LineSelection>();
export function setLineSelection(fileKey: string, range: LineSelection | null | undefined) {
  if (range) selections.set(fileKey, range);
  else selections.delete(fileKey);
}
export const peekLineSelection = (fileKey: string) => selections.get(fileKey);
