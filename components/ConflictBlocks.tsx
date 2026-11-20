import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
  type RefObject,
} from 'react';
import { File, MultiFileDiff } from '@pierre/diffs/react';
import { Editor, type EditorFactory } from '@pierre/diffs/edit';
import { Check, CheckCheck, ChevronsUpDown, CircleAlert, CircleHelp, Undo2 } from 'lucide-react';
import { Button } from './ui/button';
import {
  applyChoices,
  chosenText,
  conflictModel,
  type BlockChoice,
  type BlockPick,
  type ConflictBlock,
  type ConflictLabels,
} from '../lib/conflict-blocks';
import type { ConflictProposal } from '../lib/conflict-resolution';
import type { Verdict } from '../lib/conflict-verify';

const proposalWhat = (proposal: ConflictProposal) =>
  proposal.source === 'rerere' ? 'Same as you resolved before' : 'Combined both sides’ changes';

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

function Block({
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
}: {
  name: string;
  block: ConflictBlock;
  index: number;
  total: number;
  choice: BlockPick | undefined;
  labels: ConflictLabels;
  shortcuts: boolean;
  disabled: boolean;
  onChoose: (choice: BlockChoice) => void;
  onUndo?: () => void;
  proposal?: ConflictProposal | null;
  /** The file's checks; undefined while they run. */
  verdict?: Verdict;
}) {
  const title = `Conflict ${index + 1} of ${total}`;
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
    const merged = !!verdict?.merged;
    const note = verdict?.note ?? 'Checking the result…';
    const what = proposalWhat(proposal);
    // Merged: one line, collapsed. Check: the proposal and both sides, with the Keep actions to override it.
    return merged ? (
      <section
        className="conflict-block"
        data-state="proposal"
        data-bucket="merged"
        data-conflict-index={index}
        tabIndex={-1}
        aria-label={`${title}. Merged: ${what}. ${note}`}
      >
        <div className="conflict-kept">
          <CheckCheck size={14} aria-hidden="true" />
          <span>Merged · {what}</span>
          {undo && <span aria-hidden="true">·</span>}
          {undo}
        </div>
        <details className="conflict-ancestor conflict-merged-detail">
          <summary>{note} Show the result</summary>
          <CodeSnippet name={name} text={proposal.text} />
        </details>
      </section>
    ) : (
      <section
        className="conflict-block"
        data-state="proposal"
        data-bucket="check"
        data-conflict-index={index}
        tabIndex={0}
        aria-label={`${title}, line ${block.line}. Check: ${what}. ${note}`}
      >
        <header className="conflict-block-header">
          <strong>{title}</strong>
          <span className="conflict-bucket" data-bucket="check">
            <CircleHelp size={13} aria-hidden="true" />
            Check · {what}
          </span>
          <span>{note}</span>
          {undo}
        </header>
        {proposal.text ? (
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
        </div>
        {chosenText(block, choice) ? (
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
      </header>
      <div className="conflict-sides">
        <Side name={name} side="ours" label={labels.ours} text={block.ours} />
        <Side name={name} side="theirs" label={labels.theirs} text={block.theirs} />
      </div>
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
}: {
  name: string;
  original: string;
  contents: string;
  /** What preparation resolved, per block, and its checks (lib/conflict-verify.ts). */
  proposals?: readonly (ConflictProposal | null)[];
  verdict?: Verdict;
  labels: ConflictLabels;
  onChange: (contents: string) => void;
  disabled?: boolean;
  shortcuts?: boolean;
  handle?: Ref<ConflictViewHandle>;
  /** Called after the last open conflict is resolved, to move focus to the next action. */
  onAllResolved?: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const model = useMemo(() => conflictModel(original, contents, proposals), [original, contents, proposals]);
  const total = model.segments.filter((s) => s.kind === 'conflict').length;
  const pendingFocus = useRef<{ after?: number; at?: number }>(undefined);
  // Conflicts that need you: no proposal, or a proposal to check. J and K move between them; 1, 2 and 3 apply to them.
  const pendingSelector = '.conflict-block:is([data-state=open],[data-bucket=check])';
  const openBlocks = () => [...(root.current?.querySelectorAll<HTMLElement>(pendingSelector) ?? [])];
  const indexOf = (element: Element | null) =>
    Number(element?.closest('[data-conflict-index]')?.getAttribute('data-conflict-index') ?? -1);
  function choose(index: number, choice: BlockChoice | undefined) {
    const next = [...model.choices];
    next[index] = choice;
    pendingFocus.current = choice ? { after: index } : { at: index };
    onChange(applyChoices(model.segments, next, proposals));
  }
  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    pendingFocus.current = undefined;
    if (pending.at !== undefined) {
      revealElement(root.current?.querySelector<HTMLElement>(`[data-conflict-index="${pending.at}"]`));
      return;
    }
    const blocks = openBlocks();
    const target = blocks.find((block) => indexOf(block) > (pending.after ?? -1)) ?? blocks.at(0);
    if (target) revealElement(target);
    else onAllResolved?.();
  }, [model]);
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
        revealElement(target);
        return true;
      },
      choose(choice) {
        if (disabled) return false;
        const blocks = openBlocks();
        const active = document.activeElement?.closest<HTMLElement>(pendingSelector);
        const target = active && blocks.includes(active) ? active : blocks.at(0);
        if (!target) return false;
        choose(indexOf(target), choice);
        return true;
      },
      focusFirst() {
        const target = openBlocks().at(0);
        if (!target) return false;
        revealElement(target);
        return true;
      },
    }),
    [model, disabled]
  );
  return (
    <div ref={root} className="conflict-view" data-undoable={model.undoable || undefined}>
      {model.segments.map((segment, i) =>
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
            verdict={verdict}
            onUndo={model.undoable ? () => choose(segment.index, undefined) : undefined}
          />
        )
      )}
    </div>
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
}: {
  name: string;
  before: string;
  after: string;
  beforeLabel: string;
  afterLabel: string;
}) {
  const options = useCodeOptions();
  const root = useRef<HTMLDivElement>(null);
  const width = useElementWidth(root);
  const split = width === 0 || width >= 720;
  const diffOptions = useMemo(
    () => ({ ...options, diffStyle: split ? ('split' as const) : ('unified' as const) }),
    [options, split]
  );
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
