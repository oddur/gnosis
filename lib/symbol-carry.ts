import { useSyncExternalStore } from 'react';
import { carryTicks, earlierTicks, filePrint, isFileViewed, isRegistered, isSymbolViewed } from './file-view-progress';
import { planCarry } from './review-prints';
import { FILE_STOP, countedIds } from './tree-symbol-review';
import type { FileSymbols } from './tree-symbol-paths';

/**
 * Re-review only what changed (lib/review-prints.ts): when a file's new revision shows and its symbols are known, each
 * counted item takes its newest tick from the file's earlier revisions in this PR if it reads the same, and is
 * Updated if it does not. The carried ticks are saved under the new revision, once per revision and session, so an
 * untick here is never undone by carrying again. A file whose every item carried is Viewed, with no hold-open: the
 * reader is not on it. A file without symbols carries by its patch, as one item (`@file`); a file marked Viewed by
 * hand carries the same way, and only that way.
 */

const done = new Set<string>();
const updated = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();
let version = 0;
const notify = () => {
  version++;
  listeners.forEach((listener) => listener());
};

/**
 * Carries the earlier ticks into this revision of a file, once. `symbols` is what the tree knows of it, undefined for
 * a file that lists none; a file whose symbols are not known yet waits (nothing is decided on a guess).
 */
export function ensureCarried(fileKey: string, symbols: FileSymbols | undefined) {
  if (done.has(fileKey)) return;
  // Not known yet, or its revision not registered yet (its path, rename and patch): tried again later.
  if (symbols?.state === 'loading' || !isRegistered(fileKey)) return;
  done.add(fileKey);
  if (isFileViewed(fileKey)) return;
  const whole = filePrint(fileKey);
  const symbolItems = symbols?.state === 'ready' ? countedIds(symbols) : undefined;
  const items = symbolItems ?? [FILE_STOP];
  const prints: Record<string, string> = { ...(symbols?.state === 'ready' ? symbols.prints : {}), ...(whole ? { [FILE_STOP]: whole } : {}) };
  const earlier = earlierTicks(fileKey, [...items, ...(symbolItems ? [FILE_STOP] : [])]);
  // The whole file marked Viewed before, with the same patch: Viewed again, its items with it.
  const file = earlier.get(FILE_STOP);
  if (symbolItems && file?.print && whole && file.print === whole) {
    void carryTicks(fileKey, [], { print: whole });
    notify();
    return;
  }
  const plan = planCarry({ items, prints, earlier, viewed: (id) => (id === FILE_STOP ? isFileViewed(fileKey) : isSymbolViewed(fileKey, id)) });
  const carried = plan.carry.map(({ id, at }) => ({ id, at, print: prints[id] }));
  const carriedIds = new Set(carried.map((item) => item.id));
  const all = items.length > 0 && items.every((id) => carriedIds.has(id) || (id !== FILE_STOP && isSymbolViewed(fileKey, id)));
  if (carried.length) void carryTicks(fileKey, carried, all ? { print: whole } : undefined);
  if (plan.updated.length) updated.set(fileKey, new Set(plan.updated));
  if (carried.length || plan.updated.length) notify();
}

/** Whether an item changed since the reader viewed it in an earlier revision, and is not viewed here yet. */
export function isUpdated(fileKey: string, id: string): boolean {
  if (!updated.get(fileKey)?.has(id) || isFileViewed(fileKey)) return false;
  return id === FILE_STOP || !isSymbolViewed(fileKey, id);
}
/** How many items of these files are Updated. */
export const updatedCount = (fileKeys: readonly string[]) =>
  fileKeys.reduce((sum, fileKey) => sum + [...(updated.get(fileKey) ?? [])].filter((id) => isUpdated(fileKey, id)).length, 0);
/** Renders again when a carry-over lands. */
export function useCarry() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version
  );
}
