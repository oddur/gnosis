import { useCallback } from 'react';
import { choiceEvent, type StatsBlockRef } from './conflict-stats';
import type { BlockPick } from './conflict-blocks';

/**
 * Resolve conflicts' Undo and re-choice counts (lib/conflict-stats.ts). The main process looks up the conflict's bucket
 * and counts it once; this sends the choice without a reply, so a choice never waits.
 */
export function useConflictChoiceStats() {
  return useCallback(
    (
      id: string,
      path: string,
      block: StatsBlockRef | undefined,
      before: BlockPick | undefined,
      after: BlockPick | undefined,
      picked: BlockPick | undefined
    ) => {
      const count = choiceEvent(before, after, picked);
      if (!count || !block) return;
      try {
        window.electronAPI.recordConflictChoice?.({ id, path, key: block.key, index: block.index, count });
      } catch {
        // A count never stops the choice.
      }
    },
    []
  );
}
