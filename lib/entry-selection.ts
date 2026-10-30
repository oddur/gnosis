export interface EntrySelection {
  keys: string[];
  anchor: string | null;
}
export interface SelectionModifiers {
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}
export const emptySelection = (): EntrySelection => ({ keys: [], anchor: null });

/** Ranges use displayed order, including virtual rows, never DOM position. */
export function selectEntry(
  previous: EntrySelection,
  order: readonly string[],
  key: string,
  modifiers: SelectionModifiers = {},
  fallbackAnchor?: string | null
): EntrySelection {
  const available = new Set(order);
  if (!available.has(key)) return previous;
  const additive = !!(modifiers.metaKey || modifiers.ctrlKey);
  const keys = new Set(previous.keys.filter((id) => available.has(id)));
  const anchor = previous.anchor && available.has(previous.anchor) ? previous.anchor : fallbackAnchor;
  if (modifiers.shiftKey && anchor && available.has(anchor)) {
    const from = order.indexOf(anchor),
      to = order.indexOf(key);
    const range = order.slice(Math.min(from, to), Math.max(from, to) + 1);
    return { keys: additive ? [...new Set([...keys, ...range])] : [...range], anchor };
  }
  if (additive) {
    if (keys.has(key)) keys.delete(key);
    else keys.add(key);
    return { keys: [...keys], anchor: key };
  }
  return { keys: [key], anchor: key };
}

/** Keep the group on right-click; a different entry gets its own menu. */
export function contextSelection(previous: EntrySelection, key: string): EntrySelection {
  return previous.keys.includes(key) ? previous : { keys: [key], anchor: key };
}

/** Bound network/start requests, preserve successful work, and report every failed target. */
export async function runSelectionTasks<T>(
  targets: readonly T[],
  run: (target: T) => Promise<unknown>,
  concurrency = 2
): Promise<{ succeeded: T[]; failed: { target: T; error: unknown }[] }> {
  const succeeded: T[] = [],
    failed: { target: T; error: unknown }[] = [];
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(targets.length, Math.max(1, concurrency)) }, async () => {
      while (index < targets.length) {
        const target = targets[index++];
        try {
          await run(target);
          succeeded.push(target);
        } catch (error) {
          failed.push({ target, error });
        }
      }
    })
  );
  return { succeeded, failed };
}
