import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
import { proposalWriter, writtenLabel, type CompareWith } from '../lib/conflict-diff';
import { WRITTEN_SWATCH } from '../lib/diff-here';
import { SIDE_COLORS, type SideTone } from '../lib/conflict-sides';
import { SAME_CHANGE, type BlockVerdict } from '../lib/conflict-verify';

/*
 * A conflict's card in the Conflicts view's diff (components/ConflictDiff.tsx), under its lines: Merged, Check or
 * Decide, your Keep or your edit, with the actions that change it (Keep, Use the proposal, Undo and Edit), and the
 * in-place editor (#445 items 8 and 11).
 */

/**
 * One row per source: what a proposal did once it is in the draft (`done`: Merged, or used by you; past tense only
 * there), and how a proposal nobody chose is offered (`offer`: Check, not in the draft, #507). `check` says whether the
 * Check label names it, only where that is a fact.
 */
const PROPOSAL_WORDS: Record<
  ConflictProposal['source'],
  { done: (by: string) => string; offer: (by: string) => string; check: boolean }
> = {
  model: { done: (by) => `Proposed by ${by}`, offer: (by) => `Proposal from ${by}`, check: true },
  rerere: {
    done: () => 'Same as you resolved before',
    offer: () => 'Proposal from your earlier merge: resolve it the same way',
    check: true,
  },
  union: {
    done: () => 'Gnosis’s rule kept both sides’ additions',
    offer: () => 'Proposal from Gnosis’s rule: keep both sides’ additions',
    check: false,
  },
  same: {
    done: () => 'Gnosis’s rule kept the PR’s version',
    offer: () => 'Proposal from Gnosis’s rule: the PR’s version',
    check: false,
  },
  mergiraf: {
    done: () => 'Structural merge combined both sides’ changes',
    offer: () => 'Proposal from structural merge: combine both sides’ changes',
    check: false,
  },
  layout: {
    done: () => 'Gnosis’s rule kept the edit in the reformatted layout',
    offer: () => 'Proposal from Gnosis’s rule: keep the edit in the reformatted layout',
    check: false,
  },
  moved: {
    done: () => 'Gnosis’s rule applied the edit where the code moved',
    offer: () => 'Proposal from Gnosis’s rule: apply the edit where the code moved',
    check: false,
  },
};
/** What the proposal did, in the draft. A Merged one the same-change rule decided is the PR's version, whoever proposed it. */
export const proposalWhat = (proposal: ConflictProposal, verdict?: BlockVerdict) =>
  PROPOSAL_WORDS[
    proposal.source !== 'model' && proposal.source !== 'rerere' && verdict?.merged && verdict.note.startsWith(SAME_CHANGE)
      ? 'same'
      : proposal.source
  ].done(proposalWriter(proposal));
/** A proposal nobody chose yet, named as an offer with its writer, never as something done. */
export const proposalOffer = (proposal: ConflictProposal) => PROPOSAL_WORDS[proposal.source].offer(proposalWriter(proposal));
/** A Check label says where the proposal came from only when that is a fact; why to check it is the note beside it. */
const checkLabel = (proposal: ConflictProposal) =>
  PROPOSAL_WORDS[proposal.source].check ? `Check · ${proposalWhat(proposal)}` : 'Check';

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
  prSide = 'ours',
  model,
  written = 0,
  edit,
  onEdit,
  editor,
  picked,
}: {
  /** Your pick for this conflict: `proposal` when you chose Use the proposal, which makes the proposal yours. */
  picked?: BlockPick;
  /** Your in-place edit of this conflict, when `choice` is `edit` (#445 item 11). */
  edit?: BlockEdit;
  /** Opens the in-place editor on this conflict's lines; undefined where the draft can't be edited conflict by conflict. */
  onEdit?: () => void;
  /** The in-place editor, while it is open: it takes the card's place. */
  editor?: ReactNode;
  /** This conflict's model request while it has no proposal. */
  model?: ModelCard;
  /** What the diff around the card compares the result with (#445 item 9): in both, the rows name the sides. */
  compare?: CompareWith;
  /** Which version is the PR's: ours in a merge, theirs in a restack. The legend names it first, in its tint. */
  prSide?: 'ours' | 'theirs';
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
  const baseSide = prSide === 'ours' ? 'theirs' : 'ours';
  // Each side's swatch is its tint in the code (lib/conflict-sides.ts), from the one list of colours.
  const swatch = (tone: SideTone) => ({ '--conflict-side-swatch': SIDE_COLORS[tone] }) as CSSProperties;
  // The writer is the proposal's, also for its lines you left as they were in your edit.
  const by = proposal ? proposalWriter(proposal) : undefined;
  const writtenNote = wrote && <WrittenLegend count={written} by={by} />;
  const writtenText = wrote ? ` ${writtenLabel(written, by)}.` : '';
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
      {proposal && !(choice === 'proposal' && picked === 'proposal') && (
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
  // Each Undo says what it does: undo your Use the proposal, or take a proposal back so you decide yourself.
  const undoAs = (label: string, aria: string) =>
    onUndo && (
      <Button
        size="xs"
        variant="ghost"
        disabled={disabled}
        onClick={onUndo}
        aria-keyshortcuts={shortcuts ? 'U' : undefined}
        aria-label={aria}
      >
        <Undo2 aria-hidden="true" />
        {label}
      </Button>
    );
  const undo = undoAs('Undo', `Undo: Used the proposal in conflict ${index + 1}`);
  if (choice === 'proposal' && proposal && picked === 'proposal')
    // Use the proposal, chosen by you: your decision, with Undo and Edit like a Keep.
    return (
      <section
        className="conflict-block"
        data-state="proposal"
        data-bucket="decided"
        data-conflict-index={index}
        tabIndex={-1}
        aria-label={`${title}. You used the proposal: ${proposalWhat(proposal)}.${writtenText}`}
      >
        <div className="conflict-kept">
          <Check size={14} aria-hidden="true" />
          <span>Used the proposal · {proposalWhat(proposal)}</span>
          {undo && <span aria-hidden="true">·</span>}
          {undo}
          {editButton}
        </div>
        {writtenNote}
      </section>
    );
  if (choice === 'proposal' && proposal) {
    // A model proposal is never Merged, whatever a verdict says.
    const merged = !!verdict?.merged && proposal.source !== 'model';
    const note = verdict?.note ?? 'Checking the result…';
    const what = proposalWhat(proposal, verdict);
    // Merged: one line, collapsed. Check (a proposal in the draft nobody chose): the proposal and both sides, with Use
    // the proposal and the Keep actions; nothing is accepted until you choose.
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
          {onUndo && <span aria-hidden="true">·</span>}
          {undoAs('Decide myself', `Remove the merged result and decide conflict ${index + 1} yourself`)}
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
          {undoAs('Remove proposal', `Remove the proposal and decide conflict ${index + 1} yourself`)}
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
  // Open with a proposal: Check. The draft keeps the conflict's markers; the proposal is one of its choices, shown here.
  const checking = !!proposal;
  return (
    <section
      className="conflict-block"
      data-state="open"
      data-bucket={checking ? 'check' : undefined}
      data-conflict-index={index}
      tabIndex={0}
      aria-label={
        proposal
          ? `${title}, line ${block.line}. ${checkLabel(proposal)}. ${verdict?.note ?? 'Checking the proposal…'} Nothing is chosen yet.`
          : `${title}, line ${block.line}. ${labels.ours} or ${labels.theirs}.`
      }
    >
      <header className="conflict-block-header">
        <strong>{title}</strong>
        {proposal ? (
          <span className="conflict-bucket" data-bucket="check">
            <CircleHelp size={13} aria-hidden="true" />
            {checkLabel(proposal)}
          </span>
        ) : (
          <span className="conflict-bucket" data-bucket="decide">
            <CircleAlert size={13} aria-hidden="true" />
            Decide
          </span>
        )}
        <span>{proposal ? (verdict?.note ?? 'Checking the proposal…') : `Line ${block.line}`}</span>
        {note && !proposal && <span className="conflict-block-note">{note}</span>}
      </header>
      {model && !proposal && <ModelLine card={model} />}
      {proposal && (
        <>
          <ModelIntents proposal={proposal} labels={labels} />
          <div className="conflict-proposal-preview" data-conflict-proposal="">
            <h4 className="conflict-side-label">{proposalOffer(proposal)}</h4>
            {proposal.text ? <CodeSnippet name={name} text={proposal.text} /> : <p className="conflict-side-empty">No lines</p>}
          </div>
        </>
      )}
      {/* The diff above shows the two sides, each in its own neutral tint (lib/conflict-sides.ts), the PR's first. In
          both, the rows above name them. Neither is chosen. */}
      <p className="conflict-diff-legend">
        {compare !== 'both' && (
          <>
            <span className="conflict-side-label" data-side={prSide} data-tone="pr" style={swatch('pr')}>
              {labels[prSide]}
            </span>
            <span className="conflict-side-label" data-side={baseSide} data-tone="base" style={swatch('base')}>
              {labels[baseSide]}
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
 * "3 lines written by structural merge (neither side had them)" (#445 item 10), with a swatch of the diff's steady mark, so the
 * card says what the marked lines in the diff are.
 */
export function WrittenLegend({ count, by }: { count: number; by?: string }) {
  return (
    <p className="conflict-block-note-line conflict-written-legend" data-written={count}>
      <span className="conflict-written-swatch" style={{ background: WRITTEN_SWATCH }} aria-hidden="true" />
      {writtenLabel(count, by)}
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
