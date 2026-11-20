import { createMovesStore } from './moved-symbols-core';
import { readMoves, readSymbols, symbolReadTotals, syntaxWorkerParses } from './syntax-scope-client';
import { onInspectionForget, onInspectionUses } from './inspection-cache';
import { addDiagnosticsSource } from './diagnostics-sources';

export { MOVES_MAX_FILES, type FileMoves, type MoveMark } from './moved-symbols-core';

/**
 * The app's one store of moved and renamed symbols (#398, lib/moved-symbols-core.ts), fingerprinted and matched in the
 * tree-sitter worker. Its PRs leave with the rest of their inspection data, and count as used for the idle sweep, as
 * the definitions and the noise comparisons do (#355).
 */
const store = createMovesStore({ readSymbols, readMoves });
export const trackMoves: typeof store.track = (...args) => store.track(...args);
export const noteMovesText: typeof store.noteText = (...args) => store.noteText(...args);
export const noteMovesFailure: typeof store.noteFailure = (...args) => store.noteFailure(...args);
export const onMoves: typeof store.onMoves = (listener) => store.onMoves(listener);
export const movesRevision = () => store.revision();
export const peekFileMoves: typeof store.peek = (fileKey) => store.peek(fileKey);
export const failMovesKey: typeof store.failKey = (key, reason) => store.failKey(key, reason);

onInspectionForget((urls) => store.forget(urls));
onInspectionUses((into) => store.uses(into));

/** What the store holds and how long its work took, for the diagnostics export and the browser checks. */
export const movedSymbolsStats = () => ({
  ...store.stats(),
  reads: { ...symbolReadTotals, ms: Math.round(symbolReadTotals.ms), waitMs: Math.round(symbolReadTotals.waitMs) },
  parses: syntaxWorkerParses(),
});
addDiagnosticsSource('movedSymbols', movedSymbolsStats);
