import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EditProvider, File } from '@pierre/diffs/react';
import { Editor, type EditorFactory } from '@pierre/diffs/edit';
import { Bot, Check, CheckCheck, CircleAlert, CircleHelp, Pencil, Undo2 } from 'lucide-react';
import { Button } from './ui/button';
import { useCodeOptions } from '../lib/use-code-options';
import {
  editOpen,
  type BlockChoice,
  type BlockEdit,
  type BlockPick,
  type ConflictBlock,
  type ConflictLabels,
  type ModelChoice,
} from '../lib/conflict-blocks';
import type { ConflictProposal } from '../lib/conflict-resolution';
import type { ModelCard } from '../lib/conflict-model';
import { writtenLabel, type CompareWith } from '../lib/conflict-diff';
import { WRITTEN_SWATCH } from '../lib/diff-here';
import { SAME_CHANGE, type BlockVerdict } from '../lib/conflict-verify';

/*
 * A conflict's card in the Conflicts view's diff (components/ConflictDiff.tsx), under its lines: Merged, Check or
 * Decide, your Keep or your edit, with the actions that change it (Keep, Use the proposal, Undo and Edit), and the
 * in-place editor (#445 items 8 and 11).
 */

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

function Side({ name, label, text, side }: { name: string; label: string; text: string; side: 'ours' | 'theirs' }) {
  return (
    <div className="conflict-side" data-side={side}>
      <h4 className="conflict-side-label">{label}</h4>
      {text ? <CodeSnippet name={name} text={text} /> : <p className="conflict-side-empty">No lines on this side</p>}
    </div>
  );
}

const choiceKeys: Record<BlockChoice, string> = { ours: '1', theirs: '2', both: '3' };

export function ConflictCard({
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
          aria-keyshortcuts={shortcuts ? 'A' : undefined}
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
      aria-keyshortcuts={shortcuts ? 'U' : undefined}
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
        <p className="conflict-block-note-line">{note}</p>
        {writtenNote}
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
        {writtenNote}
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
      aria-keyshortcuts={shortcuts ? 'U' : undefined}
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
                aria-keyshortcuts={shortcuts ? 'U' : undefined}
                aria-label={`Undo: ${labels.kept[choice]} in conflict ${index + 1}`}
              >
                <Undo2 aria-hidden="true" />
                Undo
              </Button>
            </>
          )}
          {editButton}
        </div>
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
      {/* The diff above shows the two sides: against the PR, its lines removed and the base branch's added; against
          main, the other way round. In both, the rows above name them. Neither is chosen. */}
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
            <span className="conflict-side-label" data-side={compare === 'main' ? 'ours' : 'theirs'} data-mark="added">
              {compare === 'main' ? labels.ours : labels.theirs}
            </span>
          </>
        )}
        <span>Nothing is chosen yet.</span>
      </p>
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

/**
 * The in-place editor for one conflict (#445 item 11): the conflict's lines only, in Pierre's editor. Save
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
