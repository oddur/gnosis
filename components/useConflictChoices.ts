import { useEffect, useImperativeHandle, useMemo, useRef, type Ref } from 'react';
import {
  applyChoices,
  chosenText,
  conflictModel,
  editConflict,
  pickText,
  type BlockChoice,
  type BlockEdits,
  type BlockPick,
  type BlockPicks,
} from '../lib/conflict-blocks';
import { keptMarks, writtenLines } from '../lib/conflict-diff';
import type { ConflictProposal } from '../lib/conflict-resolution';
import type { Verdict } from '../lib/conflict-verify';

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
/**
 * The first row of a card's conflict in the diff above it (ConflictDiff's annotation, `data-conflict-rows`): back from
 * the card's annotation row in the diff's shadow root, over the shown version's lines of the conflict and the other
 * version's removed lines with them. In Compare with: both, the conflict's group.
 */
function conflictTop(card: HTMLElement): Element | undefined {
  const group = card.closest('.conflict-compare-group');
  if (group) return group;
  const cards = card.closest<HTMLElement>('[data-conflict-rows]');
  const slotted = card.closest('[slot]');
  const name = slotted?.getAttribute('slot');
  const root = slotted?.parentElement?.shadowRoot;
  if (!cards || !name || !root) return undefined;
  const annotation = root.querySelector(`slot[name="${CSS.escape(name)}"]`)?.closest('[data-line-annotation]');
  let left = Number(cards.dataset.conflictRows) || 0;
  let top: Element | undefined;
  for (let at = annotation?.previousElementSibling; at; at = at.previousElementSibling) {
    if (!(at instanceof HTMLElement) || !at.hasAttribute('data-line')) continue;
    const removed = at.dataset.lineType === 'change-deletion';
    if (left <= 0 && !removed) break;
    if (!removed) left--;
    top = at;
  }
  return top;
}
/**
 * Focuses a card and scrolls so its conflict's lines show with it, under the pinned file and hunk headers (#445
 * distill): J lands on a decision with both sides on screen. When they don't fit together, the lines' top comes first.
 */
function revealElement(element: HTMLElement | null | undefined) {
  if (!element) return;
  element.focus({ preventScroll: true });
  const behavior = reducedMotion() ? 'auto' : 'smooth';
  const scroller = element.closest<HTMLElement>('[data-diff-scroller]');
  const top = conflictTop(element);
  if (!scroller || !top) {
    element.scrollIntoView({ block: 'nearest', behavior });
    return;
  }
  const header = element.closest('.conflict-diff-file')?.querySelector('.changes-file-header');
  // The file header pins at the scroller's top, a hunk header under it.
  const pinned = (header?.getBoundingClientRect().height ?? 48) + 40;
  const view = scroller.getBoundingClientRect();
  const from = view.top + pinned;
  const to = view.bottom - 8;
  const first = top.getBoundingClientRect().top;
  const last = element.getBoundingClientRect().bottom;
  const delta = first < from || last - first > to - from ? first - from : last > to ? last - to : 0;
  if (Math.abs(delta) > 1) scroller.scrollBy({ top: delta, behavior });
}

export interface ConflictViewHandle {
  /** Focus the next (1) or previous (-1) open conflict. Returns false when none is open. */
  move: (direction: 1 | -1) => boolean;
  /** Apply a choice to the focused open conflict, or to the first open one. */
  choose: (choice: BlockChoice) => boolean;
  focusFirst: () => boolean;
}

/**
 * Choices, edits in place, focus and the J/K handle for a file's conflict cards in the Conflicts view's diff
 * (components/ConflictDiff.tsx). `root` holds the cards.
 */
export function useConflictChoices({
  original,
  contents,
  proposals,
  picks,
  onPick,
  onChange,
  disabled,
  handle,
  onAllResolved,
  verdict,
  onChoice,
  edits,
  onEdits,
}: {
  original: string;
  contents: string;
  proposals?: readonly (ConflictProposal | null)[];
  picks?: BlockPicks;
  /** Your in-place edits (#445 item 11), and where a change to them goes. Without `onEdits` nothing is edited in place. */
  edits?: BlockEdits;
  onEdits?: (edits: BlockEdits) => void;
  onPick?: (index: number, choice: BlockPick | undefined) => void;
  onChange: (contents: string) => void;
  disabled: boolean;
  handle?: Ref<ConflictViewHandle>;
  onAllResolved?: () => void;
  verdict?: Verdict;
  /**
   * Each choice with the one it replaces and your saved pick for it, for the local stats (lib/conflict-stats.ts).
   * Undefined is Undo.
   */
  onChoice?: (
    index: number,
    before: BlockPick | undefined,
    after: BlockPick | undefined,
    picked: BlockPick | undefined
  ) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const model = useMemo(
    () => conflictModel(original, contents, proposals, picks, edits),
    [original, contents, proposals, picks, edits]
  );
  const total = model.segments.filter((s) => s.kind === 'conflict').length;
  const pendingFocus = useRef<{ after?: number; at?: number }>(undefined);
  // Conflicts that need you: no proposal, or a proposal to check. J and K move between them; 1, 2 and 3 apply to them.
  const pendingSelector = '.conflict-block:is([data-state=open],[data-bucket=check])';
  const openBlocks = () => [...(root.current?.querySelectorAll<HTMLElement>(pendingSelector) ?? [])];
  const indexOf = (element: Element | null) =>
    Number(element?.closest('[data-conflict-index]')?.getAttribute('data-conflict-index') ?? -1);
  // The Conflicts view's diff mounts its cards with its hunks, a moment after the draft changes: a focus move waits
  // until every card is in place (or the whole-file proposal stands in for them).
  const waiting = useRef<MutationObserver>(undefined);
  useEffect(() => () => waiting.current?.disconnect(), []);
  const cardsIn = () =>
    (root.current?.querySelectorAll('.conflict-block:not([data-conflict-index="-1"])').length ?? 0) >= total ||
    !!root.current?.querySelector(':scope > .conflict-context-toggle');
  function whenCards(run: () => void) {
    waiting.current?.disconnect();
    const element = root.current;
    if (!element || cardsIn()) {
      run();
      return;
    }
    const observer = new MutationObserver(() => {
      if (!cardsIn()) return;
      observer.disconnect();
      run();
    });
    observer.observe(element, { childList: true, subtree: true });
    waiting.current = observer;
  }
  // A card can mount again as the diff around it changes (a scope shown whole, a hunk joined): the conflict that had
  // focus keeps it.
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let focused: { index: string; card: Element } | undefined;
    const onFocusIn = (event: FocusEvent) => {
      const card = (event.target as Element).closest('.conflict-block');
      const index = card?.getAttribute('data-conflict-index');
      focused = card && index ? { index, card } : undefined;
    };
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget) focused = undefined;
    };
    // Only when the focused card itself was removed or replaced: focus you moved elsewhere stays where you put it.
    const observer = new MutationObserver(() => {
      const active = document.activeElement;
      if (!focused || focused.card.isConnected) return;
      const index = focused.index;
      focused = undefined;
      if (active && active !== document.body && !active.contains(element)) return;
      element
        .querySelector<HTMLElement>(`.conflict-block[data-conflict-index="${index}"]`)
        ?.focus({ preventScroll: true });
    });
    element.addEventListener('focusin', onFocusIn);
    element.addEventListener('focusout', onFocusOut);
    observer.observe(element, { childList: true, subtree: true });
    return () => {
      element.removeEventListener('focusin', onFocusIn);
      element.removeEventListener('focusout', onFocusOut);
      observer.disconnect();
    };
  }, []);
  // A card in the diff shows once its hunk has rendered (ConflictDiff): until then it cannot take focus. Try again each
  // frame while it is not shown and nothing else has taken focus.
  function reveal(target: HTMLElement | null | undefined) {
    let frames = 0;
    const attempt = () => {
      if (!target?.isConnected) return;
      if (target.checkVisibility()) {
        revealElement(target);
        return;
      }
      const active = document.activeElement;
      if (++frames < 300 && (!active || active === document.body || (!!root.current && active.contains(root.current))))
        requestAnimationFrame(attempt);
    };
    attempt();
  }
  /** The edits the draft reads after conflict `index` gets another choice: its own edit goes. */
  const editsWithout = (index: number) => {
    const next = [...(model.edits ?? [])];
    next[index] = undefined;
    return next;
  };
  function choose(index: number, choice: BlockPick | undefined) {
    const next = [...model.choices];
    const before = next[index];
    next[index] = choice;
    pendingFocus.current = choice ? { after: index } : { at: index };
    // Replacing your edit is not a choice between Gnosis's options: the stats count none.
    if (before !== 'edit') onChoice?.(index, before, choice, picks?.[index]);
    else onEdits?.(editsWithout(index));
    // Use the proposal after another choice is yours too (#445 item 12): only an untouched proposal has no pick.
    onPick?.(index, choice);
    onChange(applyChoices(model.segments, next, proposals, model.edits));
  }
  /** Undo: a Keep or a proposal opens the conflict again; your edit returns to the choice it replaced (#445 item 11). */
  function undo(index: number) {
    const edit = model.choices[index] === 'edit' ? model.edits?.[index] : undefined;
    if (!edit) {
      choose(index, undefined);
      return;
    }
    const next = [...model.choices];
    next[index] = edit.before ?? undefined;
    pendingFocus.current = { at: index };
    onEdits?.(editsWithout(index));
    onPick?.(index, edit.pick ?? undefined);
    onChange(applyChoices(model.segments, next, proposals, model.edits));
  }
  /** The text the in-place editor starts from: the conflict's lines, or both sides while it is open. */
  function editStart(index: number) {
    const segment = model.segments.find((s) => s.kind === 'conflict' && s.index === index);
    if (segment?.kind !== 'conflict') return '';
    const choice = model.choices[index];
    return choice ? pickText(segment, choice, proposals, model.edits) : chosenText(segment.block, 'both');
  }
  /**
   * Your text for conflict `index`, into that conflict's span only (editConflict). False, and nothing changes, when the
   * edit can't be kept to the conflict. The resolver's lines you left as they were keep their mark; lines you typed
   * never get one.
   */
  function saveEdit(index: number, typed: string) {
    if (disabled || !onEdits) return false;
    const result = editConflict(model, contents, index, typed, proposals, picks);
    const segment = model.segments.find((s) => s.kind === 'conflict' && s.index === index);
    if (!result || segment?.kind !== 'conflict') return false;
    const choice = model.choices[index];
    const from = choice ? pickText(segment, choice, proposals, model.edits) : '';
    const proposal = proposals?.[index];
    const marked =
      choice === 'proposal' && proposal
        ? writtenLines(proposal.text, segment.block.ours, segment.block.theirs)
        : choice === 'edit'
          ? (model.edits?.[index]?.written ?? [])
          : [];
    const written = keptMarks(from, marked, result.edit.text);
    if (written.length) result.edits[index] = { ...result.edit, written };
    pendingFocus.current = { at: index };
    onEdits(result.edits);
    // An edit is yours: your pick for the conflict is cleared, and the service saves the file as your edit.
    onPick?.(index, undefined);
    onChange(result.contents);
    return true;
  }
  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    pendingFocus.current = undefined;
    whenCards(() => {
      if (pending.at !== undefined) {
        reveal(root.current?.querySelector<HTMLElement>(`[data-conflict-index="${pending.at}"]`));
        return;
      }
      const blocks = openBlocks();
      const target = blocks.find((block) => indexOf(block) > (pending.after ?? -1)) ?? blocks.at(0);
      if (target) reveal(target);
      else onAllResolved?.();
    });
  }, [model]);
  // A proposal is Check while its checks run. If it had focus and turns Merged, focus moves on to the next conflict that
  // needs you. With none, it stays put: never onto a button that commits a review while you may be pressing keys. J
  // then goes to the next action.
  useEffect(() => {
    const active = document.activeElement?.closest<HTMLElement>('.conflict-block');
    if (!active || !root.current?.contains(active) || active.matches(pendingSelector)) return;
    if (active.dataset.state !== 'proposal') return;
    const target = openBlocks().find((block) => indexOf(block) > indexOf(active)) ?? openBlocks().at(0);
    if (target) reveal(target);
  }, [verdict]);
  useImperativeHandle(
    handle,
    () => ({
      move(direction) {
        const blocks = openBlocks();
        if (!blocks.length) return false;
        const current = indexOf(document.activeElement);
        const ordered = direction === 1 ? blocks : [...blocks].reverse();
        const target =
          ordered.find((block) => (direction === 1 ? indexOf(block) > current : indexOf(block) < current)) ??
          ordered[0];
        reveal(target);
        return true;
      },
      choose(choice) {
        if (disabled) return false;
        // 1, 2 and 3 choose in a conflict, never in the whole-file proposal.
        const blocks = openBlocks().filter((block) => indexOf(block) >= 0);
        const active = document.activeElement?.closest<HTMLElement>(pendingSelector);
        if (active && indexOf(active) < 0) return false;
        const target = active && blocks.includes(active) ? active : blocks.at(0);
        if (!target) return false;
        choose(indexOf(target), choice);
        return true;
      },
      focusFirst() {
        if (!cardsIn()) {
          // Cards still mounting: focus the first that needs you once they are in, else the next action.
          whenCards(() => {
            const target = openBlocks().at(0);
            if (target) reveal(target);
            else onAllResolved?.();
          });
          return true;
        }
        const target = openBlocks().at(0);
        if (!target) return false;
        reveal(target);
        return true;
      },
    }),
    [model, disabled]
  );
  return { root, model, total, choose, undo, editStart, saveEdit };
}
