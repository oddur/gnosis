import { useId, useSyncExternalStore } from 'react';
import { Check, ChevronRight, RefreshCw, SquareDot, SquareMinus, SquarePlus } from 'lucide-react';
import { useFileProgress } from '../lib/file-view-progress';
import { markReviewSymbols, useSymbolFileSync } from '../lib/symbol-file-sync';
import { isUpdated, useCarry } from '../lib/symbol-carry';
import { isBody, isPseudo, isTopLevel, outlineSummary, spokenSymbol, type ChangedSymbol, type SymbolChange } from '../lib/symbol-outline';
import { definitionNoun } from '../lib/hunk-scopes';

/**
 * A file's outline of changed symbols (#394), right under its header, in Changes and in Explanation topics: what the
 * changes touch ("Changes 2 functions and a class") with each symbol named and marked added, modified or removed.
 * Choosing a symbol takes the reader to it as a pinned crumb does (ChangesDiff's navigator). Expanded, each symbol has
 * a Viewed tick, kept beside the file's own (lib/file-view-progress.ts); once every symbol is ticked, the outline
 * offers to mark the file Viewed. It never marks the file itself: Viewed collapses the file, which would take the code
 * away from under the reader.
 *
 * The bar is one code line tall whether it is waiting for the file's structure or shows the outline, so nothing below
 * it moves when the structure arrives; a file without a grammar has no outline at all.
 */
export interface OutlineProps {
  /** The symbols, once the file is parsed; undefined while it is not. */
  symbols?: readonly ChangedSymbol[];
  /** The file has a grammar and its structure is on its way. */
  pending?: boolean;
  /** The file's revision key: symbol ticks are kept under it. */
  fileKey: string;
  /** The file's name, for labels. */
  fileName: string;
  fileViewed?: boolean;
  onMarkFileViewed?: () => void;
  /** The mark button's words: "Mark this part seen" with Focused sections' parts (#564). */
  markFileLabel?: string;
  /** Takes the reader to the symbol. */
  onGo: (symbol: ChangedSymbol) => void;
  /** Symbols left out because their every change is formatting or comments the reader hides (#396). */
  quiet?: number;
}

/** Collapsed, the bar names this many symbols, then "+N more". */
const SHOWN_COLLAPSED = 4;

// One expanded state for every outline: a reviewer who reads outlines wants them all open.
let expanded = false;
const listeners = new Set<() => void>();
const setExpanded = (value: boolean) => {
  expanded = value;
  for (const listener of listeners) listener();
};
const useExpanded = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => expanded
  );

const MARKERS: Record<SymbolChange, { Icon: typeof SquarePlus; label: string }> = {
  added: { Icon: SquarePlus, label: 'Added' },
  modified: { Icon: SquareDot, label: 'Modified' },
  removed: { Icon: SquareMinus, label: 'Removed' },
};

function Marker({ change }: { change: SymbolChange }) {
  const { Icon } = MARKERS[change];
  return <Icon className="diff-outline-marker" data-change={change} size={13} strokeWidth={2} aria-hidden="true" />;
}

/**
 * A symbol in words: "function merge". The file's top-level changes (TOP_LEVEL_ID) lead the list as one more entry,
 * "Imports" or "Top level", ticked and counted like a symbol (lib/tree-symbol-review.ts), so this bar's "x/y viewed"
 * and the Changes tree's count agree. A container's own lines are its body, "Store · body"; the container itself is
 * no entry, as it is no review item.
 */
const named = (symbol: ChangedSymbol) =>
  isTopLevel(symbol)
    ? `${symbol.definition.name.toLowerCase()} changes`
    : isBody(symbol)
      ? symbol.definition.crumb
      : `${definitionNoun(symbol.definition)} ${symbol.definition.name}`;

/** An item that changed since the reader viewed it in an earlier revision (lib/symbol-carry.ts). */
function Updated() {
  return (
    <span className="diff-outline-updated" title="Changed since you viewed it">
      <RefreshCw size={12} aria-hidden="true" />
      <span className="sr-only">Changed since you viewed it</span>
    </span>
  );
}

/** A symbol's name as its crumb shows it: the kind word tinted as the syntax theme tints keywords. */
function SymbolName({ symbol }: { symbol: ChangedSymbol }) {
  const { crumb, crumbKeyword } = symbol.definition;
  if (!crumbKeyword || !crumb.startsWith(`${crumbKeyword} `)) return <code>{crumb}</code>;
  return (
    <code>
      <span className="diff-gap-kind">{crumbKeyword}</span> {crumb.slice(crumbKeyword.length + 1)}
    </code>
  );
}

export function DiffOutline({ symbols, pending, fileKey, fileName, fileViewed = false, onMarkFileViewed, markFileLabel, onGo, quiet = 0 }: OutlineProps) {
  const open = useExpanded();
  const synced = useSymbolFileSync(fileKey);
  useCarry();
  const progress = useFileProgress();
  const listId = useId();
  if (!symbols) {
    if (!pending) return null;
    return (
      <section className="diff-outline" data-pending="" aria-label={`Changed symbols in ${fileName}`}>
        <div className="diff-outline-bar">
          <span className="diff-outline-summary diff-outline-quiet">Reading structure…</span>
        </div>
      </section>
    );
  }
  const viewed = symbols.map((symbol) => fileViewed || progress.isSymbolViewed(fileKey, symbol.id));
  const done = viewed.filter(Boolean).length;
  const all = symbols.length > 0 && done === symbols.length;
  // Symbols whose changes are all hidden as noise are left out, and counted, so the outline stays honest.
  const quietNote = quiet > 0 ? `${quiet} ${quiet === 1 ? 'symbol' : 'symbols'} with quiet changes only` : undefined;
  const summary = !symbols.some((symbol) => !isPseudo(symbol)) && quietNote ? 'No functions or classes changed beyond quiet changes' : outlineSummary(symbols);
  // Through the file's sync (lib/symbol-file-sync.ts): in symbol mode the last tick marks the file, and an untick of
  // a Viewed file's symbol makes it unviewed. Elsewhere the ticks stay apart from the file, as before.
  const tick = (symbol: ChangedSymbol, on: boolean) => void markReviewSymbols(fileKey, [symbol.id], on);
  const go = (symbol: ChangedSymbol) => (
    <button
      type="button"
      className="diff-outline-go"
      data-symbol={symbol.id}
      aria-label={`Go to ${isPseudo(symbol) ? named(symbol) : spokenSymbol(symbol)}`}
      title={`Go to ${named(symbol)}`}
      onClick={() => onGo(symbol)}
    >
      <SymbolName symbol={symbol} />
    </button>
  );
  // Collapsed, the bar previews the definitions the summary names; the top-level entry, with its tick, is in the list
  // (and counts in "x/y viewed"), and is a chip only when the file changes nothing else.
  const definitions = symbols.filter((symbol) => !isTopLevel(symbol));
  const chips = (definitions.length ? definitions : symbols).slice(0, SHOWN_COLLAPSED);
  const rest = (definitions.length || symbols.length) - SHOWN_COLLAPSED;
  return (
    <section
      className="diff-outline"
      data-expanded={open || undefined}
      data-empty={symbols.length ? undefined : ''}
      aria-label={`Changed symbols in ${fileName}`}
    >
      <div className="diff-outline-bar">
        {symbols.length ? (
          <button
            type="button"
            className="diff-outline-toggle"
            aria-expanded={open}
            aria-controls={listId}
            title={open ? 'Hide the outline' : 'Show the outline, with a Viewed tick for each symbol'}
            onClick={() => setExpanded(!open)}
          >
            <ChevronRight className="diff-outline-chevron" size={14} aria-hidden="true" />
            <span className="diff-outline-summary">{summary}</span>
          </button>
        ) : (
          <span className="diff-outline-summary diff-outline-quiet">{summary}</span>
        )}
        {!open && symbols.length > 0 && (
          <ul className="diff-outline-chips" aria-label="Symbols">
            {chips.map((symbol) => {
              const seen = viewed[symbols.indexOf(symbol)];
              return (
                <li key={symbol.id} className="diff-outline-chip" data-change={symbol.change} data-viewed={seen || undefined}>
                  <Marker change={symbol.change} />
                  {go(symbol)}
                  {seen && <Check className="diff-outline-check" size={12} aria-label="Viewed" />}
                  {!seen && isUpdated(fileKey, symbol.id) && <Updated />}
                </li>
              );
            })}
            {rest > 0 && (
              <li className="diff-outline-chip">
                <button type="button" className="diff-outline-more" aria-expanded={false} aria-controls={listId} onClick={() => setExpanded(true)}>
                  +{rest} more
                </button>
              </li>
            )}
          </ul>
        )}
        {quietNote && (
          <span className="diff-outline-quiet diff-outline-noise" data-outline-quiet={quiet} title="Their changes are formatting or comments that Diff appearance hides; the diff shows each as a bar.">
            {quietNote}
          </span>
        )}
        {symbols.length > 0 && (
          <span className="diff-outline-end">
            {all && !fileViewed && synced ? (
              // The file follows its ticks: no offer to mark it. All ticked and not Viewed is a file the reader
              // unviewed by hand; its header's checkbox marks it again, as does the next tick.
              <span className="diff-outline-progress">All viewed</span>
            ) : all && !fileViewed && onMarkFileViewed ? (
              <>
                <span className="diff-outline-progress">All viewed</span>
                <button type="button" className="diff-outline-mark" onClick={onMarkFileViewed}>
                  {markFileLabel ?? 'Mark file viewed'}
                </button>
              </>
            ) : (
              <span className="diff-outline-progress" aria-label={`${done} of ${symbols.length} symbols viewed`}>
                {done}/{symbols.length} viewed
              </span>
            )}
          </span>
        )}
      </div>
      {open && symbols.length > 0 && (
        <ul id={listId} className="diff-outline-list" aria-label="Symbols">
          {symbols.map((symbol, index) => (
            <li key={symbol.id} className="diff-outline-row" data-change={symbol.change} data-viewed={viewed[index] || undefined}>
              <label className="diff-outline-tick-target">
                <input
                  type="checkbox"
                  className="diff-outline-tick"
                  checked={viewed[index]}
                  // A Viewed file's symbols untick when the file follows them, which unviews the file.
                  disabled={fileViewed && !synced}
                  aria-label={`Viewed ${named(symbol)}`}
                  onChange={(event) => tick(symbol, event.target.checked)}
                />
              </label>
              <Marker change={symbol.change} />
              <span className="sr-only">{MARKERS[symbol.change].label}</span>
              {go(symbol)}
              {!viewed[index] && isUpdated(fileKey, symbol.id) && <Updated />}
              {symbol.parents.length > 0 && (
                <span className="diff-outline-parents" aria-hidden="true">
                  in {symbol.parents.map((parent) => parent.crumb).join(' › ')}
                </span>
              )}
              <span className="diff-outline-counts" aria-hidden="true">
                {symbol.added > 0 && <span className="diff-gap-added">+{symbol.added}</span>}
                {symbol.deleted > 0 && <span className="diff-gap-deleted">−{symbol.deleted}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
