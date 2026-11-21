import { useMemo } from 'react';
import { createChoiceCounter } from './conflict-stats';

/** Resolve conflicts' Undo and re-choice counts (lib/conflict-stats.ts), sent without a reply so a choice never waits. */
export function useConflictChoiceStats() {
  return useMemo(() => createChoiceCounter((events) => window.electronAPI.recordConflictChoices?.(events)), []);
}
