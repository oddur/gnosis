import { useEffect, useImperativeHandle, useMemo, useRef, type Ref } from 'react';
import {
  applyChoices,
  chosenText,
  conflictModel,
  editConflict,
  pickText,
  type BlockChoice,
  type BlockEdit,
  type ConflictModel,
  type BlockEdits,
  type BlockPick,
  type BlockPicks,
} from '../lib/conflict-blocks';
import { keptMarks, writtenLines } from '../lib/conflict-diff';
import type { ConflictProposal } from '../lib/conflict-resolution';
import type { Verdict } from '../lib/conflict-verify';
import { nextNeedingYou } from '../lib/conflict-shortcuts';

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
 * distill): J lands on a decision with both sides on screen. When they don't fit together, the card is in view, with as
 * many of the conflict's lines above it as fit.
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
  // The file header pins at the scroller's top, and the hunk header under it: both measured.
  const file = element.closest('.conflict-diff-file');
  const pinned =
    (file?.querySelector('.changes-file-header')?.getBoundingClientRect().height ?? 0) +
    (file?.querySelector('.diff-gap')?.getBoundingClientRect().height ?? 0);
  const view = scroller.getBoundingClientRect();
  const from = view.top + pinned;
  const to = view.bottom - 8;
  const first = top.getBoundingClientRect().top;
  const card = element.getBoundingClientRect();
  const delta =
    card.bottom - first <= to - from
      ? first < from
        ? first - from
        : card.bottom > to
          ? card.bottom - to
          : 0
      : card.height <= to - from
        ? card.bottom - to
        : card.top - from;
  if (Math.abs(delta) > 1) scroller.scrollBy({ top: delta, behavior });
}

export interface ConflictViewHandle {
  /** Focus the next (1) or previous (-1) open conflict. Returns false when none is open. */
  move: (direction: 1 | -1) => boolean;
  /** Apply a choice to the focused open conflict, or to the first open one. */
  choose: (choice: BlockChoice) => boolean;
  focusFirst: () => boolean;
  /**
   * A (#445 item 13): use the focused conflict's proposal, then focus the next conflict that needs you, else the next
   * action. False, and nothing changes, when the conflict needs you but has no proposal of its own.
   */
  accept: () => boolean;
  /** U: right after A, undoes that accept; otherwise the focused conflict's Undo. False when there is nothing to undo. */
  undo: () => boolean;
  /** Any other key, a click or a focus move of yours: U no longer undoes the last accept. */
  forgetAccept: () => void;
  /** V: the next Compare with mode. False while no switch shows. */
  cycleCompare: () => boolean;
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
  cycleCompare,
}: {
  /** The diff's Compare with step, for V; it reads the mode on screen when called. */
  cycleCompare?: { current: (() => boolean) | undefined };
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
  const pendingFocus = useRef<{ after?: number; at?: number; accepted?: boolean }>(undefined);
  // Conflicts whose proposal you accepted with A while it stays in Check: Accept's focus passes over them.
  const accepted = useRef(new Set<number>());
  // The conflict card that last had focus: A and U act on it while focus is on the view's own controls (V's switch,
  // G's checkbox, the next action: `data-conflict-control`).
  const lastCard = useRef<number>(undefined);
  // The last A, with what it replaced, until another key, a click or a focus move of yours: U then undoes it.
  const lastAccept = useRef<{
    index: number;
    choice: ConflictModel['choices'][number];
    pick: BlockPick | undefined;
    edit: BlockEdit | null | undefined;
  }>(undefined);
  // True while Gnosis moves focus itself (A's next conflict, a check that finishes, a card mounting again): that focus
  // move isn't yours, and U still undoes the last A (#508).
  const movingFocus = useRef(false);
  function focusCard(run: () => void) {
    movingFocus.current = true;
    try {
      run();
    } finally {
      movingFocus.current = false;
    }
  }
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
      if (index && Number(index) >= 0) lastCard.current = Number(index);
      if (!movingFocus.current) lastAccept.current = undefined;
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
      focusCard(() =>
        element
          .querySelector<HTMLElement>(`.conflict-block[data-conflict-index="${index}"]`)
          ?.focus({ preventScroll: true })
      );
    });
    // A click anywhere is yours: U no longer undoes the last accept.
    const onPointerDown = () => (lastAccept.current = undefined);
    element.addEventListener('focusin', onFocusIn);
    element.addEventListener('focusout', onFocusOut);
    document.addEventListener('pointerdown', onPointerDown, true);
    observer.observe(element, { childList: true, subtree: true });
    return () => {
      element.removeEventListener('focusin', onFocusIn);
      element.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('pointerdown', onPointerDown, true);
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
        focusCard(() => revealElement(target));
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
    accepted.current.delete(index);
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
    accepted.current.delete(index);
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
      if (pending.accepted) {
        focusAfterAccept(pending.after ?? -1);
        return;
      }
      const blocks = openBlocks();
      const target = blocks.find((block) => indexOf(block) > (pending.after ?? -1)) ?? blocks.at(0);
      if (target) reveal(target);
      else onAllResolved?.();
    });
  }, [model]);
  function focusAfterAccept(from: number) {
    const next = nextNeedingYou(openBlocks().map(indexOf).filter((index) => index >= 0), from, accepted.current);
    if (next === undefined) onAllResolved?.();
    else reveal(root.current?.querySelector<HTMLElement>(`.conflict-block[data-conflict-index="${next}"]`));
  }
  /** The conflict card with focus, in this file. */
  const focusedCard = () => {
    const card = document.activeElement?.closest<HTMLElement>('.conflict-block');
    if (card && root.current?.contains(card) && indexOf(card) >= 0) return card;
    // Focus is on the view's own controls: the card you were on. Anywhere else (the page, the file list) no card has
    // focus, and A takes the first conflict that needs you (#508).
    return lastCard.current === undefined || !document.activeElement?.closest('[data-conflict-control]')
      ? undefined
      : (root.current?.querySelector<HTMLElement>(`.conflict-block[data-conflict-index="${lastCard.current}"]`) ?? undefined);
  };
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
      accept() {
        if (disabled) return false;
        // The focused conflict, or the first that needs you with a proposal of its own; never the whole-file proposal,
        // which Use this result takes.
        const card =
          focusedCard() ?? openBlocks().find((block) => indexOf(block) >= 0 && !!proposals?.[indexOf(block)]);
        const index = indexOf(card ?? null);
        if (!card || index < 0 || !card.matches(pendingSelector) || !proposals?.[index]) return false;
        const before = {
          index,
          choice: model.choices[index],
          pick: picks?.[index],
          edit: model.edits?.[index],
        };
        if (model.choices[index] === 'proposal' && picks?.[index] === 'proposal') {
          // You chose this proposal already: only focus moves on, and U brings it back.
          lastAccept.current = before;
          accepted.current.add(index);
          whenCards(() => focusAfterAccept(index));
          return true;
        }
        // The same handler as the card's Use the proposal: one way to apply a proposal, as your explicit choice.
        choose(index, 'proposal');
        lastAccept.current = before;
        accepted.current.add(index);
        pendingFocus.current = { after: index, accepted: true };
        return true;
      },
      undo() {
        if (disabled) return false;
        const last = lastAccept.current;
        lastAccept.current = undefined;
        if (last) {
          // Back to what A replaced: its choice, your pick and your edit, with focus on that conflict again.
          accepted.current.delete(last.index);
          const next = [...model.choices];
          next[last.index] = last.choice;
          const edits = [...(model.edits ?? [])];
          edits[last.index] = last.edit;
          pendingFocus.current = { at: last.index };
          if (next[last.index] === model.choices[last.index] && last.pick === picks?.[last.index]) {
            reveal(root.current?.querySelector<HTMLElement>(`.conflict-block[data-conflict-index="${last.index}"]`));
            return true;
          }
          if (last.edit !== model.edits?.[last.index]) onEdits?.(edits);
          onPick?.(last.index, last.pick);
          onChange(applyChoices(model.segments, next, proposals, edits));
          return true;
        }
        const card = focusedCard();
        if (!card || !model.undoable) return false;
        const index = indexOf(card);
        if (model.choices[index] === undefined) return false;
        undo(index);
        return true;
      },
      forgetAccept() {
        lastAccept.current = undefined;
      },
      cycleCompare: () => cycleCompare?.current?.() ?? false,
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
