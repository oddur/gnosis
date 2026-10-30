import { useState } from 'react';
import {
  contextSelection,
  emptySelection,
  selectEntry,
  type EntrySelection,
  type SelectionModifiers,
} from './entry-selection';

/** Selection is local to the current view. Background refreshes retain surviving IDs. */
export function useEntrySelection(order: readonly string[], scope: string, focused?: string | null) {
  const [stored, setStored] = useState<{ scope: string; value: EntrySelection }>({ scope, value: emptySelection() });
  const available = new Set(order);
  const value =
    stored.scope === scope
      ? { ...stored.value, keys: stored.value.keys.filter((key) => available.has(key)) }
      : emptySelection();
  // Commit resets/pruning so returning to an old filter cannot restore hidden targets.
  if (stored.scope !== scope || value.keys.length !== stored.value.keys.length) {
    setStored({ scope, value });
  }
  const update = (next: EntrySelection) => setStored({ scope, value: next });
  return {
    keys: new Set(value.keys),
    select: (key: string, modifiers?: SelectionModifiers) => update(selectEntry(value, order, key, modifiers, focused)),
    context: (key: string) => update(contextSelection(value, key)),
    all: () => update({ keys: [...order], anchor: focused ?? order.at(0) ?? null }),
    clear: () => update(emptySelection()),
  };
}
