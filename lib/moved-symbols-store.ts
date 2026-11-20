import { createMovesStore, movesApi } from './moved-symbols-core';
import { readMoves, readSymbols, setSymbolsWanted, symbolReadTotals, syntaxWorkerParses } from './syntax-scope-client';
import { onInspectionForget, onInspectionUses } from './inspection-cache';
import { addDiagnosticsSource } from './diagnostics-sources';

export { MOVES_MAX_FILES, type FileMoves, type MoveMark } from './moved-symbols-core';

/**
 * The app's one store of moved and renamed symbols (#398, lib/moved-symbols-core.ts), fingerprinted and matched in the
 * tree-sitter worker. Its PRs leave with the rest of their inspection data, and count as used for the idle sweep, as
 * the definitions and the noise comparisons do (#355).
 */
const store = createMovesStore({ readSymbols, readMoves });
export const {
  trackMoves,
  noteMovesText,
  noteMovesFailure,
  failMovesKey,
  movesWanted,
  onMoves,
  movesRevision,
  peekFileMoves,
} = movesApi(store);
// Whole-file comparisons fingerprint symbols only for files the store tracks and still wants.
setSymbolsWanted(movesWanted);

onInspectionForget((urls) => store.forget(urls));
onInspectionUses((into) => store.uses(into));

/** What the store holds and how long its work took, for the diagnostics export and the browser checks. */
export const movedSymbolsStats = () => ({
  ...store.stats(),
  reads: { ...symbolReadTotals, ms: Math.round(symbolReadTotals.ms), waitMs: Math.round(symbolReadTotals.waitMs) },
  parses: syntaxWorkerParses(),
});
addDiagnosticsSource('movedSymbols', movedSymbolsStats);
