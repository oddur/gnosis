import { createContext, useSyncExternalStore } from 'react';
import { onMoves, peekFileMoves, type FileMoves } from './moved-symbols-store';
import { whenSettled } from './use-syntax-contents';

/** Where a move's other end is, for a view to open it: a line of a PR's file, in its side's numbers. */
export interface MoveTarget {
  url: string;
  /** The revision the move was matched in: a newer head opens just the file. */
  headSha: string;
  /** The file's path in the diff: the new path of a renamed file. */
  path: string;
  line: number;
  endLine?: number;
  side: 'before' | 'after';
}
/**
 * Opens a line of another file of the PR (#398): Changes selects the file and scrolls to it; elsewhere the PR's
 * workspace opens Changes there. Without a provider, a move into another file names it without a link.
 */
export const MoveNavigation = createContext<((target: MoveTarget) => void) | undefined>(undefined);

/** Moves land once the view is still, as other structure results do: a label that lands mid-scroll waits. */
function settledMoves(listener: () => void): () => void {
  let pending: (() => void) | undefined;
  const stop = onMoves(() => {
    pending ??= whenSettled(() => {
      pending = undefined;
      listener();
    });
  });
  return () => {
    stop();
    pending?.();
  };
}

/** A file revision's moved symbols (lib/moved-symbols-store.ts), once its PR is matched; undefined until then. */
export function useFileMoves(fileKey: string | undefined, enabled = true): FileMoves | undefined {
  return useSyncExternalStore(settledMoves, () => (enabled && fileKey ? peekFileMoves(fileKey) : undefined));
}
