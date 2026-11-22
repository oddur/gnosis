import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { EditProvider, File, MultiFileDiff } from '@pierre/diffs/react';
import { Editor, type EditorFactory } from '@pierre/diffs/edit';
import { Bot, Check, CheckCheck, ChevronsUpDown, CircleAlert, CircleHelp, Pencil, Undo2 } from 'lucide-react';
import { Button } from './ui/button';
import {
  applyChoices,
  chosenText,
  conflictModel,
  editConflict,
  editOpen,
  pickText,
  type BlockChoice,
  type BlockEdit,
  type BlockEdits,
  type BlockPick,
  type BlockPicks,
  type ConflictBlock,
  type ConflictLabels,
  type ModelChoice,
} from '../lib/conflict-blocks';
import type { ConflictProposal } from '../lib/conflict-resolution';
import type { ModelCard } from '../lib/conflict-model';
import { keptMarks, writtenFileLines, writtenLabel, writtenLines, type CompareWith } from '../lib/conflict-diff';
import { WRITTEN_CSS, WRITTEN_SWATCH, markWritten } from '../lib/diff-here';
import { blockVerdict, SAME_CHANGE, type BlockVerdict, type Verdict } from '../lib/conflict-verify';

/** What the proposal is. A Merged one the same-change rule decided is the PR's version, whoever proposed it. */
export const proposalWhat = (proposal: ConflictProposal, verdict?: BlockVerdict) =>
  proposal.source === 'model'
    ? `Proposed by ${proposal.by ?? 'a model'}`
    : proposal.source === 'rerere'
    ? 'Same as you resolved before'
    : proposal.source === 'union'
      ? 'Kept both sides’ additions'
      : proposal.source === 'same' || (verdict?.merged && verdict.note.startsWith(SAME_CHANGE))
        ? 'Kept the PR’s version'
        : 'Combined both sides’ changes';
/** A Check label says where the proposal came from only when that is a fact; why to check it is the note beside it. */
const checkLabel = (proposal: ConflictProposal) =>
  proposal.source === 'rerere'
    ? `Check · ${proposalWhat(proposal)}`
    : proposal.source === 'model'
      ? `Check · ${proposalWhat(proposal)}`
      : 'Check';

/** A conflict's model request while it has no proposal (lib/conflict-model.ts `ModelCard`). */
function ModelLine({ card }: { card: ModelCard }) {
  return (
    <p className="conflict-model-line" data-model={card.status} role="status">
      <Bot size={13} aria-hidden="true" />
      {card.status === 'asking' ? (
        <span>Asking {card.by} for a proposal… You can decide now.</span>
      ) : card.status === 'question' ? (
        <span>
          {card.by} asks: {card.text}
        </span>
      ) : (
        <span>{card.text}</span>
      )}
    </p>
  );
}
/** What the model said each side meant, and how its proposal keeps both: its words, not a check. */
function ModelIntents({ proposal, labels }: { proposal: ConflictProposal; labels: ConflictLabels }) {
  if (proposal.source !== 'model' || !proposal.intents) return null;
  return (
    <dl className="conflict-model-intents" aria-label={`What ${proposal.by ?? 'the model'} says`}>
      <dt>{labels.ours}</dt>
      <dd>{proposal.intents.pr}</dd>
      <dt>{labels.theirs}</dt>
      <dd>{proposal.intents.main}</dd>
      {proposal.note && (
        <>
          <dt>Proposal</dt>
          <dd>{proposal.note}</dd>
        </>
      )}
    </dl>
  );
}

const baseOptions = {
  theme: { dark: 'pierre-dark', light: 'pierre-light' },
  overflow: 'wrap',
  expandUnchanged: false,
} as const;
/** Pierre options that follow the app theme. */
export function useCodeOptions() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return useMemo(() => ({ ...baseOptions, themeType: dark ? ('dark' as const) : ('light' as const) }), [dark]);
}
export const createEditor: EditorFactory<undefined, undefined> = (type, opts, key) => new Editor(type, opts, key);

/** Width of an element, for layouts that CSS alone cannot switch (split or unified diffs). */
export function useElementWidth(ref: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export function revealElement(element: HTMLElement | null | undefined) {
  if (!element) return;
  element.focus({ preventScroll: true });
  element.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
}

// Excerpts wrap, so they never need a horizontal scrollbar or its reserved gutter.
const SNIPPET_CSS =
  '[data-code]{scrollbar-width:none;--diffs-scrollbar-gutter-override:0px}[data-code]::-webkit-scrollbar{display:none}';
/** A highlighted excerpt without a header or line numbers. */
function CodeSnippet({ name, text }: { name: string; text: string }) {
  const options = useCodeOptions();
  const file = useMemo(() => ({ name, contents: text }), [name, text]);
  const snippetOptions = useMemo(
    () => ({ ...options, disableFileHeader: true, disableLineNumbers: true, unsafeCSS: SNIPPET_CSS }),
    [options]
  );
  return <File className="conflict-snippet" file={file} options={snippetOptions} />;
}

const CONTEXT_LINES = 3;
/** Unchanged text between blocks: a few lines next to each block, the rest behind one control. */
function ContextText({ name, text, before, after }: { name: string; text: string; before: boolean; after: boolean }) {
  const [open, setOpen] = useState(false);
  const lines = text.split(/(?<=\n)/);
  const head = before ? CONTEXT_LINES : 0;
  const tail = after ? CONTEXT_LINES : 0;
  if (open || lines.length <= head + tail + 2) return <CodeSnippet name={name} text={text} />;
  const hidden = lines.length - head - tail;
  return (
    <>
      {head > 0 && <CodeSnippet name={name} text={lines.slice(0, head).join('')} />}
      <button type="button" className="conflict-context-toggle" onClick={() => setOpen(true)}>
        <ChevronsUpDown size={14} aria-hidden="true" />
        Show {hidden} unchanged {hidden === 1 ? 'line' : 'lines'}
      </button>
      {tail > 0 && <CodeSnippet name={name} text={lines.slice(lines.length - tail).join('')} />}
    </>
  );
}

function Side({ name, label, text, side }: { name: string; label: string; text: string; side: 'ours' | 'theirs' }) {
  return (
    <div className="conflict-side" data-side={side}>
      <h4 className="conflict-side-label">{label}</h4>
      {text ? <CodeSnippet name={name} text={text} /> : <p className="conflict-side-empty">No lines on this side</p>}
    </div>
  );
}

const choiceKeys: Record<BlockChoice, string> = { ours: '1', theirs: '2', both: '3' };

export function Block({
  inDiff = false,
  name,
  block,
  index,
  total,
  choice,
  labels,
  shortcuts,
  disabled,
  onChoose,
  onUndo,
  proposal,
  verdict,
  note,
  compare = 'pr',
  model,
  written = 0,
  edit,
  onEdit,
  editor,
}: {
  /** Your in-place edit of this conflict, when `choice` is `edit` (#445 item 11). */
  edit?: BlockEdit;
  /** Opens the in-place editor on this conflict's lines; undefined where the draft can't be edited conflict by conflict. */
  onEdit?: () => void;
  /** The in-place editor, while it is open: it takes the card's place. */
  editor?: ReactNode;
  /** This conflict's model request while it has no proposal. */
  model?: ModelCard;
  /** In the Conflicts view's diff (components/ConflictDiff.tsx): the diff shows the code, the card the decision. */
  inDiff?: boolean;
  /** What the diff around the card compares the result with (#445 item 9), so the legend names its sides right. */
  compare?: CompareWith;
  name: string;
  block: ConflictBlock;
  index: number;
  total: number;
  choice: ModelChoice | undefined;
  labels: ConflictLabels;
  shortcuts: boolean;
  disabled: boolean;
  onChoose: (choice: BlockPick) => void;
  onUndo?: () => void;
  proposal?: ConflictProposal | null;
  /** This conflict's checks; undefined while they run. */
  verdict?: BlockVerdict;
  /** Why structural merge proposed nothing for this file, shown on its Decide conflicts. */
  note?: string;
  /** How many of the proposal's lines neither side had (#445 item 10): the diff marks them, the card counts them. */
  written?: number;
}) {
  const title = `Conflict ${index + 1} of ${total}`;
  if (editor)
    return (
      <section
        className="conflict-block"
        data-state="editing"
        data-conflict-index={index}
        tabIndex={-1}
        aria-label={`${title}. Editing its lines.`}
      >
        {editor}
      </section>
    );
  const wrote = written > 0 && (choice === 'proposal' ? !!proposal : choice === 'edit');
  const writtenNote = wrote && <WrittenLegend count={written} />;
  const writtenText = wrote ? ` ${writtenLabel(written)}.` : '';
  // Edit sits with the Keep actions on an open card, and on the line of a decided one.
  const editAction = (size: 'xs' | 'sm') =>
    onEdit && (
      <Button
        size={size}
        variant="ghost"
        disabled={disabled}
        data-conflict-edit=""
        onClick={onEdit}
        aria-label={`Edit conflict ${index + 1}`}
      >
        <Pencil aria-hidden="true" />
        Edit
      </Button>
    );
  const editButton = editAction('xs');
  const actions = (
    <div className="conflict-block-actions" role="group" aria-label={`Choose for conflict ${index + 1}`}>
      {(['ours', 'theirs', 'both'] as const).map((value) => (
        <Button
          key={value}
          size="sm"
          variant="outline"
          disabled={disabled}
          data-choice={value}
          aria-keyshortcuts={shortcuts ? choiceKeys[value] : undefined}
          title={value === 'both' ? `${labels.ours} first, then ${labels.theirs}. Check for duplicates.` : undefined}
          onClick={() => onChoose(value)}
        >
          {labels.keep[value]}
          {shortcuts && (
            <kbd className="kbd" aria-hidden="true">
              {choiceKeys[value]}
            </kbd>
          )}
        </Button>
      ))}
      {proposal && choice !== 'proposal' && (
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          data-choice="proposal"
          onClick={() => onChoose('proposal')}
        >
          Use the proposal
        </Button>
      )}
      {editAction('sm')}
    </div>
  );
  const undo = onUndo && (
    <Button
      size="xs"
      variant="ghost"
      disabled={disabled}
      onClick={onUndo}
      aria-label={`Undo and decide conflict ${index + 1} yourself`}
    >
      <Undo2 aria-hidden="true" />
      Undo
    </Button>
  );
  if (choice === 'proposal' && proposal) {
    // A model proposal is never Merged, whatever a verdict says.
    const merged = !!verdict?.merged && proposal.source !== 'model';
    const note = verdict?.note ?? 'Checking the result…';
    const what = proposalWhat(proposal, verdict);
    // Merged: one line, collapsed. Check: the proposal and both sides, with the Keep actions to override it.
    return merged ? (
      <section
        className="conflict-block"
        data-state="proposal"
        data-bucket="merged"
        data-conflict-index={index}
        tabIndex={-1}
        aria-label={`${title}. Merged: ${what}. ${note}${writtenText}`}
      >
        <div className="conflict-kept">
          <CheckCheck size={14} aria-hidden="true" />
          <span>Merged · {what}</span>
          {undo && <span aria-hidden="true">·</span>}
          {undo}
          {editButton}
        </div>
        {inDiff ? (
          <>
            <p className="conflict-block-note-line">{note}</p>
            {writtenNote}
          </>
        ) : (
          <details className="conflict-ancestor conflict-merged-detail">
            <summary>{note} Show the result</summary>
            <CodeSnippet name={name} text={proposal.text} />
          </details>
        )}
      </section>
    ) : (
      <section
        className="conflict-block"
        data-state="proposal"
        data-bucket="check"
        data-conflict-index={index}
        tabIndex={0}
        aria-label={`${title}, line ${block.line}. ${checkLabel(proposal)}. ${note}${writtenText}`}
      >
        <header className="conflict-block-header">
          <strong>{title}</strong>
          <span className="conflict-bucket" data-bucket="check">
            <CircleHelp size={13} aria-hidden="true" />
            {checkLabel(proposal)}
          </span>
          <span>{note}</span>
          {undo}
        </header>
        <ModelIntents proposal={proposal} labels={labels} />
        {inDiff && writtenNote}
        {inDiff ? null : proposal.text ? (
          <CodeSnippet name={name} text={proposal.text} />
        ) : (
          <p className="conflict-side-empty">No lines</p>
        )}
        <details className="conflict-ancestor">
          <summary>Both sides</summary>
          <div className="conflict-sides">
            <Side name={name} side="ours" label={labels.ours} text={block.ours} />
            <Side name={name} side="theirs" label={labels.theirs} text={block.theirs} />
          </div>
        </details>
        {actions}
      </section>
    );
  }
  // Undo of your edit: back to the choice it replaced.
  const undoEdit = onUndo && (
    <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={onUndo}
            aria-label={`Undo your edit of conflict ${index + 1}`}
          >
            <Undo2 aria-hidden="true" />
            Undo
          </Button>
  );
  // Your edit, with a conflict marker left in it: the conflict is still open, in Decide (#445 item 11).
  if (choice === 'edit' && editOpen(edit))
    return (
      <section
        className="conflict-block"
        data-state="open"
        data-edited=""
        data-conflict-index={index}
        tabIndex={0}
        aria-label={`${title}, line ${block.line}. Your edit still has a conflict marker.`}
      >
        <header className="conflict-block-header">
          <strong>{title}</strong>
          <span className="conflict-bucket" data-bucket="decide">
            <CircleAlert size={13} aria-hidden="true" />
            Decide
          </span>
          <span>Your edit still has a conflict marker. Remove it, or choose a side.</span>
          {undoEdit}
        </header>
        {actions}
      </section>
    );
  if (choice === 'edit')
    return (
      <section
        className="conflict-block"
        data-state="edited"
        data-conflict-index={index}
        tabIndex={-1}
        aria-label={`${title}. Edited by you.${writtenText}`}
      >
        <div className="conflict-kept">
          <Pencil size={14} aria-hidden="true" />
          <span>Edited by you</span>
          {undoEdit && <span aria-hidden="true">·</span>}
          {undoEdit}
          {editButton}
        </div>
        {writtenNote}
      </section>
    );
  if (choice && choice !== 'proposal')
    return (
      <section
        className="conflict-block"
        data-state="kept"
        data-conflict-index={index}
        tabIndex={-1}
        aria-label={`${title}. ${labels.kept[choice]}.`}
      >
        <div className="conflict-kept">
          <Check size={14} aria-hidden="true" />
          <span>{labels.kept[choice]}</span>
          {onUndo && (
            <>
              <span aria-hidden="true">·</span>
              <Button
                size="xs"
                variant="ghost"
                disabled={disabled}
                onClick={onUndo}
                aria-label={`Undo: ${labels.kept[choice]} in conflict ${index + 1}`}
              >
                <Undo2 aria-hidden="true" />
                Undo
              </Button>
            </>
          )}
          {editButton}
        </div>
        {inDiff ? null : chosenText(block, choice) ? (
          <CodeSnippet name={name} text={chosenText(block, choice)} />
        ) : (
          <p className="conflict-side-empty">No lines kept</p>
        )}
      </section>
    );
  return (
    <section
      className="conflict-block"
      data-state="open"
      data-conflict-index={index}
      tabIndex={0}
      aria-label={`${title}, line ${block.line}. ${labels.ours} or ${labels.theirs}.`}
    >
      <header className="conflict-block-header">
        <strong>{title}</strong>
        <span className="conflict-bucket" data-bucket="decide">
          <CircleAlert size={13} aria-hidden="true" />
          Decide
        </span>
        <span>Line {block.line}</span>
        {note && <span className="conflict-block-note">{note}</span>}
      </header>
      {model && <ModelLine card={model} />}
      {inDiff ? (
        // The diff above shows the two sides: against the PR, its lines removed and the base branch's added; against
        // main, the other way round. In both, the rows above name them. Neither is chosen.
        <p className="conflict-diff-legend">
          {compare !== 'both' && (
            <>
              <span
                className="conflict-side-label"
                data-side={compare === 'main' ? 'theirs' : 'ours'}
                data-mark="removed"
              >
                {compare === 'main' ? labels.theirs : labels.ours}
              </span>
              <span
                className="conflict-side-label"
                data-side={compare === 'main' ? 'ours' : 'theirs'}
                data-mark="added"
              >
                {compare === 'main' ? labels.ours : labels.theirs}
              </span>
            </>
          )}
          <span>Nothing is chosen yet.</span>
        </p>
      ) : (
        <div className="conflict-sides">
          <Side name={name} side="ours" label={labels.ours} text={block.ours} />
          <Side name={name} side="theirs" label={labels.theirs} text={block.theirs} />
        </div>
      )}
      {block.base !== undefined && (
        <details className="conflict-ancestor">
          <summary>{labels.base}</summary>
          {block.base ? <CodeSnippet name={name} text={block.base} /> : <p className="conflict-side-empty">No lines</p>}
        </details>
      )}
      {actions}
    </section>
  );
}

/**
 * "3 lines written by Gnosis (neither side had them)" (#445 item 10), with a swatch of the diff's steady mark, so the
 * card says what the marked lines in the diff are.
 */
export function WrittenLegend({ count }: { count: number }) {
  return (
    <p className="conflict-block-note-line conflict-written-legend" data-written={count}>
      <span className="conflict-written-swatch" style={{ background: WRITTEN_SWATCH }} aria-hidden="true" />
      {writtenLabel(count)}
    </p>
  );
}

export interface ConflictViewHandle {
  /** Focus the next (1) or previous (-1) open conflict. Returns false when none is open. */
  move: (direction: 1 | -1) => boolean;
  /** Apply a choice to the focused open conflict, or to the first open one. */
  choose: (choice: BlockChoice) => boolean;
  focusFirst: () => boolean;
}

/**
 * Conflicts as labelled versions with Keep actions. A kept block stays visible with Undo, as long
 * as the draft still derives from the original conflict.
 */
/**
 * Choices, focus and the J/K handle for a file's conflict cards, shared by ConflictView and the Conflicts view's diff
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

/**
 * The in-place editor for one conflict (#445 item 11): the conflict's lines only, in the editor Edit result used. Save
 * puts your text into that conflict's span and nowhere else; Cancel, or Escape, leaves the draft as it was. Cmd+Enter
 * (Ctrl+Enter) saves.
 */
export function InlineEdit({
  name,
  index,
  initial,
  start,
  hint,
  theme,
  disabled,
  onType,
  onSave,
  onCancel,
}: {
  name: string;
  index: number;
  /** The text to show: what you typed so far, or `start`. */
  initial: string;
  /** The text the editor started from: Save stays off until you change it. */
  start: string;
  hint?: string;
  /** The diff's code theme (diffThemeName). */
  theme: string;
  disabled: boolean;
  onType: (text: string) => void;
  /** False when the edit can't be kept to the conflict: the editor stays open and says so. */
  onSave: (text: string) => boolean;
  onCancel: () => void;
}) {
  const [file] = useState(() => ({ name, contents: initial }));
  const [text, setText] = useState(initial);
  const [refused, setRefused] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  // This editor's instance, so focus can put the caret at the start of the conflict's first line.
  const editor = useRef<Pick<Editor, 'focus'>>(undefined);
  const factory = useCallback<EditorFactory<undefined, undefined>>((type, opts, key) => {
    const instance = new Editor(type, opts, key);
    editor.current = instance;
    return instance;
  }, []);
  // The diff's own code theme, as the rows above it: the editor is part of the code tier, whatever the app's theme.
  const editorOptions = useMemo(
    () => ({
      theme,
      themeType: 'dark' as const,
      overflow: 'wrap' as const,
      disableFileHeader: true,
      disableLineNumbers: true,
      unsafeCSS: SNIPPET_CSS,
    }),
    [theme]
  );
  // Focus goes into the editor, at the start of its first line, once it has rendered; unless you moved it meanwhile.
  useEffect(() => {
    let frame = 0;
    let tries = 0;
    // Focus where Edit was chosen from counts as unmoved: the editor is what you asked for.
    const opened = document.activeElement;
    const attempt = () => {
      const target = host.current
        ?.querySelector('diffs-container')
        ?.shadowRoot?.querySelector<HTMLElement>('[contenteditable=true]');
      const active = document.activeElement;
      const free =
        !active ||
        active === opened ||
        active === document.body ||
        !!host.current?.closest('.conflict-block')?.contains(active);
      if (target && free) {
        // The editor places a caret only on lines it has rendered, so the editor comes into view first.
        if (tries === 0) host.current?.closest('.conflict-block')?.scrollIntoView({ block: 'nearest' });
        editor.current?.focus({ lineNumber: 1, character: 0, preventScroll: true });
        if ((target.getRootNode() as ShadowRoot).activeElement === target) return;
      }
      if (++tries < 300) frame = requestAnimationFrame(attempt);
    };
    frame = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(frame);
  }, []);
  const save = () => {
    if (disabled || text === start) return;
    const ok = onSave(text);
    setRefused(!ok);
  };
  return (
    <div
      className="conflict-inline-edit"
      data-conflict-inline-edit={index}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          event.stopPropagation();
          save();
        }
      }}
    >
      <header className="conflict-block-header">
        <strong>Conflict {index + 1} · Edit</strong>
        <span>Only this conflict’s lines change.{hint ? ` ${hint}` : ''}</span>
      </header>
      <div ref={host} className="conflict-inline-editor">
        <EditProvider createEditor={factory}>
          <File
            file={file}
            edit
            options={editorOptions}
            onEditChange={(event) => {
              setText(event.file.contents);
              setRefused(false);
              onType(event.file.contents);
            }}
          />
        </EditProvider>
      </div>
      {refused && (
        <p className="conflict-block-note-line" role="alert" data-conflict-edit-refused="">
          Gnosis couldn’t keep this edit to this conflict’s lines, so nothing changed. Edit only the conflict’s own
          lines.
        </p>
      )}
      <div className="conflict-block-actions">
        <Button size="sm" disabled={disabled || text === start} data-conflict-edit-save="" onClick={save}>
          Save edit
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function ConflictView({
  name,
  original,
  contents,
  labels,
  onChange,
  disabled = false,
  shortcuts = false,
  handle,
  onAllResolved,
  proposals,
  verdict,
  note,
  wholeFile,
  picks,
  onPick,
}: {
  name: string;
  original: string;
  contents: string;
  /** What preparation resolved, per block, and its checks (lib/conflict-verify.ts). */
  proposals?: readonly (ConflictProposal | null)[];
  verdict?: Verdict;
  note?: string;
  /** Structural merge's whole-file result, shown first as one thing to check. */
  /** `shown`: you asked to see the conflicts too. */
  wholeFile?: {
    proposal: ConflictProposal;
    ours: string;
    theirs: string;
    onUse: () => void;
    shown: boolean;
    onShow: () => void;
  };
  labels: ConflictLabels;
  onChange: (contents: string) => void;
  disabled?: boolean;
  shortcuts?: boolean;
  handle?: Ref<ConflictViewHandle>;
  /** Called after the last open conflict is resolved, to move focus to the next action. */
  onAllResolved?: () => void;
  /** Your Keep choices, so one that equals the proposal still reads as yours (withPicks). */
  picks?: BlockPicks;
  onPick?: (index: number, choice: BlockPick | undefined) => void;
}) {
  const { root, model, total, choose } = useConflictChoices({
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
  });
  // A whole-file proposal that passed, or is still being checked, stands in for the conflicts until you ask for them.
  const hideBlocks = !!wholeFile && !wholeFile.shown && (!verdict || !!verdict.passed);
  return (
    <div ref={root} className="conflict-view" data-undoable={model.undoable || undefined}>
      {wholeFile && <WholeFile name={name} {...wholeFile} verdict={verdict} labels={labels} disabled={disabled} />}
      {hideBlocks ? (
        <button type="button" className="conflict-context-toggle" onClick={wholeFile.onShow}>
          Resolve conflict by conflict instead ({total})
        </button>
      ) : (
        model.segments.map((segment, i) =>
          segment.kind === 'text' ? (
            <ContextText
              key={`text-${i}`}
              name={name}
              text={segment.text}
              before={model.segments[i - 1]?.kind === 'conflict'}
              after={model.segments[i + 1]?.kind === 'conflict'}
            />
          ) : (
            <Block
              key={`block-${segment.index}`}
              name={name}
              block={segment.block}
              index={segment.index}
              total={total}
              choice={model.choices[segment.index]}
              labels={labels}
              shortcuts={shortcuts}
              disabled={disabled}
              onChoose={(choice) => choose(segment.index, choice)}
              proposal={proposals?.[segment.index]}
              verdict={blockVerdict(verdict, segment.index)}
              note={note}
              onUndo={model.undoable ? () => choose(segment.index, undefined) : undefined}
            />
          )
        )
      )}
    </div>
  );
}

/**
 * Structural merge's result for the whole file. It also changes lines outside the conflicts, so it is never Merged:
 * you read it next to the PR and use it, or choose each conflict below yourself.
 */
export function WholeFile({
  name,
  proposal,
  ours,
  theirs,
  onUse,
  verdict,
  labels,
  disabled,
}: {
  name: string;
  proposal: ConflictProposal;
  ours: string;
  /** main's whole file: with the PR's, what the proposal's lines are compared with for their marks (#445 item 10). */
  theirs: string;
  onUse: () => void;
  verdict?: Verdict;
  labels: ConflictLabels;
  disabled: boolean;
}) {
  const note = verdict?.note ?? 'Checking the result…';
  // The proposal's lines neither side had are marked before you use it, as they are after (#445 item 10).
  const written = useMemo(
    () => writtenFileLines(proposal.text, ours, theirs, proposal.text),
    [proposal.text, ours, theirs]
  );
  return (
    <section
      className="conflict-block conflict-whole-file"
      data-state="whole-file"
      data-bucket="check"
      data-conflict-index={-1}
      tabIndex={0}
      aria-label={`Whole file. Check: ${proposal.source === 'moved' ? 'one side moved this code and the other edited it' : 'structural merge combined both sides'}. ${note}`}
    >
      <header className="conflict-block-header">
        <strong>Whole file</strong>
        <span className="conflict-bucket" data-bucket="check">
          <CircleHelp size={13} aria-hidden="true" />
          Check
        </span>
      </header>
      <p>{note}</p>
      {written.size > 0 && <WrittenLegend count={written.size} />}
      <ResultDiff
        name={name}
        before={ours}
        after={proposal.text}
        beforeLabel={labels.ours}
        afterLabel="Proposed result"
        quiet
        written={written}
      />
      <div className="conflict-block-actions">
        <Button size="sm" disabled={disabled} data-choice="whole-file" onClick={onUse}>
          Use this result
        </Button>
      </div>
    </section>
  );
}

export function ResultEditor({
  name,
  initial,
  onChange,
}: {
  name: string;
  initial: string;
  onChange: (contents: string) => void;
}) {
  const options = useCodeOptions();
  const [file] = useState(() => ({ name, contents: initial }));
  return <File file={file} edit options={options} onEditChange={(event) => onChange(event.file.contents)} />;
}

/** The result next to a reference version, with named columns. */
export function ResultDiff({
  name,
  before,
  after,
  beforeLabel,
  afterLabel,
  quiet = false,
  written,
}: {
  name: string;
  before: string;
  after: string;
  beforeLabel: string;
  afterLabel: string;
  /** No change icon in the file header, for a diff inside a panel that already says what it is. */
  quiet?: boolean;
  /** Lines of `after` a resolver wrote, which neither side had (#445 item 10): marked as in the Conflicts view. */
  written?: ReadonlySet<number>;
}) {
  const latestWritten = useRef(written);
  latestWritten.current = written;
  const options = useCodeOptions();
  const root = useRef<HTMLDivElement>(null);
  const width = useElementWidth(root);
  const split = width === 0 || width >= 720;
  const diffOptions = useMemo(
    () => ({
      ...options,
      diffStyle: split ? ('split' as const) : ('unified' as const),
      unsafeCSS: `${WRITTEN_CSS}${quiet ? '\n[data-change-icon]{display:none}' : ''}`,
      // Each render writes the rows anew: the marks go back on them (lib/diff-here.ts).
      onPostRender: (node: HTMLElement) => {
        if (latestWritten.current) markWritten(node, latestWritten.current);
      },
    }),
    [options, split, quiet]
  );
  useEffect(() => {
    for (const host of root.current?.querySelectorAll('diffs-container') ?? []) markWritten(host, written ?? new Set());
  }, [written]);
  const oldFile = useMemo(() => ({ name, contents: before }), [name, before]);
  const newFile = useMemo(() => ({ name, contents: after }), [name, after]);
  return (
    <div ref={root} className="conflict-result-diff">
      <DiffColumns split={split} before={beforeLabel} after={afterLabel} />
      {before === after ? (
        <p className="conflict-side-empty">The result is the same as {beforeLabel}.</p>
      ) : (
        <MultiFileDiff oldFile={oldFile} newFile={newFile} options={diffOptions} />
      )}
    </div>
  );
}

/** Column names for a diff, matching its split or unified layout. */
export function DiffColumns({ split, before, after }: { split: boolean; before: string; after: string }) {
  return split ? (
    <div className="conflict-diff-columns" data-layout="split">
      <span>
        <span className="sr-only">Left column: </span>
        {before}
      </span>
      <span>
        <span className="sr-only">Right column: </span>
        {after}
      </span>
    </div>
  ) : (
    <div className="conflict-diff-columns" data-layout="unified">
      <span>
        <span aria-hidden="true">− </span>
        <span className="sr-only">Removed lines: </span>
        {before}
      </span>
      <span>
        <span aria-hidden="true">+ </span>
        <span className="sr-only">Added lines: </span>
        {after}
      </span>
    </div>
  );
}
