import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Popover } from 'radix-ui';
import { ArrowLeft, CornerDownLeft } from 'lucide-react';
import { ReviewDiff } from './ReviewDiff';
import { Button } from './ui/button';
import { treeIconSvg } from './tree-symbol-icons';
import { DIFF_STAT_COLORS } from './DiffStats';
import { peekHunks, type Caller, type CallersResult } from '../lib/review-peek';
import { itemCounts } from '../lib/tree-symbol-review';
import type { TreeRowIcon } from '../lib/tree-symbol-paths';
import type { PrChangeFile, PrChanges } from '../lib/pr-changes';
import type { DiffAppearance } from '../lib/review-diff';
import type { DiffHunk } from '../lib/types';

/** What a peek shows: an item of a file, its look in the tree, and which of the file's lines are its own. */
export interface PeekView {
  key: string;
  id: string;
  name: string;
  icon: TreeRowIcon;
  snapshot: PrChanges;
  file: PrChangeFile;
  added: number;
  deleted: number;
  /** Its state as its row reads it: Viewed, Changed, Moved, Reading N%; empty when unviewed. */
  state: { text: string; color?: string };
  /** Which hunks are its own (lib/review-peek.ts `peekHunks`). */
  hunks: Parameters<typeof peekHunks>[1];
}

/**
 * A peek at an item of the Changes tree (Space on its row, or a hover): its own hunks, drawn by Changes' own diff
 * (ReviewDiff, as Explanation topics and chat answers show a subset of a file), and the changed symbols of the PR that
 * call it. It never moves the review on, the diff, or the light: Enter goes there, V marks it, Esc closes.
 */
export function SymbolPeek({
  view,
  anchor,
  focus,
  callers,
  coverage,
  onLookAll,
  canBack,
  onBack,
  onPeek,
  onGo,
  onTick,
  onClose,
  onPointerEnter,
  onPointerLeave,
  theme,
  appearance,
}: {
  view: PeekView;
  /** The row it opened from: it sits beside it, over the diff. */
  anchor: { getBoundingClientRect: () => DOMRect };
  /** Opened from the keyboard: it takes focus. A hover leaves focus where it is. */
  focus: boolean;
  callers: CallersResult;
  coverage: { checked: number; total: number };
  onLookAll: () => void;
  canBack: boolean;
  onBack: () => void;
  onPeek: (caller: Caller) => void;
  onGo: (target?: Caller) => void;
  onTick: () => void;
  onClose: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  theme: string;
  appearance?: DiffAppearance;
}) {
  const anchorRef = useRef(anchor);
  const contentRef = useRef<HTMLDivElement>(null);
  anchorRef.current = anchor;
  const [active, setActive] = useState(-1);
  const list = callers.kind === 'callers' ? callers.callers : [];
  const hunks = useMemo<DiffHunk[]>(
    () => peekHunks(view.file.patch, view.hunks).map((hunk) => ({ filePath: view.file.path, hunkHeader: hunk.header, content: hunk.content, language: '', renderedHtml: '' })),
    [view.file.patch, view.file.path, view.hunks]
  );
  const counts = itemCounts(view.added, view.deleted);
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    const key = event.key;
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      handled();
      if (list.length) setActive((index) => (key === 'ArrowDown' ? Math.min(list.length - 1, index + 1) : Math.max(-1, index - 1)));
    } else if (key === 'Enter') {
      handled();
      const caller = list[active] as Caller | undefined;
      // On a caller: peek at it, or with Alt go there. Else: go to the item.
      if (caller && !event.altKey) onPeek(caller);
      else onGo(caller);
    } else if ((key === 'v' || key === 'V') && !event.metaKey && !event.ctrlKey && !event.altKey) {
      handled();
      onTick();
    } else if (key === ' ') {
      handled();
      onClose();
    } else if (key === 'Backspace' && canBack) {
      handled();
      onBack();
    }
  };
  return (
    <Popover.Root open onOpenChange={(open) => !open && onClose()}>
      <Popover.Anchor virtualRef={anchorRef} />
      <Popover.Portal>
        <Popover.Content
          side="right"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          aria-label={`Peek: ${view.name}`}
          className="symbol-peek"
          ref={contentRef}
          tabIndex={-1}
          // The keyboard goes to the peek itself, not its first button (a caller's Go): Enter there goes to the peeked
          // item, as the footer says, and ↑↓ choose a caller. Opened by hover, it takes nothing.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (focus) contentRef.current?.focus({ preventScroll: true });
          }}
          // Back to the tree row, which the tree does itself (it knows the row).
          onCloseAutoFocus={(event) => event.preventDefault()}
          onKeyDown={onKeyDown}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
        >
          <header className="symbol-peek-header">
            {canBack && (
              <Button variant="ghost" size="icon-xs" aria-label="Back" title="Back (Backspace)" onClick={onBack}>
                <ArrowLeft size={14} aria-hidden="true" />
              </Button>
            )}
            <span className="symbol-peek-icon" dangerouslySetInnerHTML={{ __html: treeIconSvg(view.icon) }} />
            <strong className="symbol-peek-name">{view.name}</strong>
            <span className="symbol-peek-file">{view.file.path}</span>
            <span className="symbol-peek-counts">
              {counts.parts.map((part) => (
                <span key={part.sign} style={{ color: part.sign === '+' ? DIFF_STAT_COLORS.added : DIFF_STAT_COLORS.removed }}>
                  {part.sign}
                  {part.count}
                </span>
              ))}
            </span>
            {view.state.text && (
              <span className="symbol-peek-state" style={{ color: view.state.color }}>
                {view.state.text}
              </span>
            )}
          </header>
          <div className="symbol-peek-body">
            {hunks.length ? (
              <ReviewDiff
                filePath={view.file.path}
                hunks={hunks}
                diffLayout="unified"
                appearance={appearance}
                slideIndex={-1}
                keyScope={`peek:${view.snapshot.url}`}
                expandable={false}
                plainGaps
                theme={theme}
                source={{
                  url: view.snapshot.url,
                  path: view.file.path,
                  previousPath: view.file.previousPath,
                  baseSha: view.snapshot.metadata.baseSha,
                  headSha: view.snapshot.metadata.headSha,
                }}
              />
            ) : (
              <p className="symbol-peek-note">Loading…</p>
            )}
            <section className="symbol-peek-callers" aria-label="Called by, in this PR">
              <h3>Called by, in this PR</h3>
              {callers.kind === 'none' ? null : callers.kind === 'ambiguous' ? (
                <p className="symbol-peek-note">Name used by several symbols; not matched</p>
              ) : list.length ? (
                <ul role="listbox" aria-label="Callers" aria-activedescendant={active >= 0 ? `peek-caller-${active}` : undefined}>
                  {list.map((caller, index) => (
                    <li
                      key={`${caller.key}:${caller.id}`}
                      id={`peek-caller-${index}`}
                      role="option"
                      aria-selected={index === active}
                      className="symbol-peek-caller"
                      onClick={() => onPeek(caller)}
                    >
                      <span className="symbol-peek-caller-name">{caller.node.definition.name}</span>
                      <span className="symbol-peek-file">{caller.key.slice(caller.key.lastIndexOf('/') + 1)}</span>
                      <code className="symbol-peek-call">{caller.call.text}</code>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Go to ${caller.node.definition.name}`}
                        title="Go there (Alt+Enter)"
                        onClick={(event) => {
                          event.stopPropagation();
                          onGo(caller);
                        }}
                      >
                        <CornerDownLeft size={12} aria-hidden="true" />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="symbol-peek-note">No changed callers in this PR</p>
              )}
              {callers.kind !== 'none' && coverage.checked < coverage.total && (
                <p className="symbol-peek-note">
                  Checked {coverage.checked} of {coverage.total} changed files.{' '}
                  <button type="button" className="symbol-peek-link" onClick={onLookAll}>
                    Look in all files
                  </button>
                </p>
              )}
            </section>
          </div>
          <footer className="symbol-peek-footer">Enter to go · V to mark viewed · Esc to close</footer>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
