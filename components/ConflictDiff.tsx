import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { parseDiffFromFile, type DiffLineAnnotation, type FileDiffMetadata, type FileDiffOptions } from '@pierre/diffs';
import { CircleHelp } from 'lucide-react';
import { DIFF_HIGHLIGHTER } from '../lib/diff-highlighter';
import { diffThemeName } from '../lib/diff-worker-pool';
import { applyCodePalette } from '../lib/diff-code-palette';
import { useDiffAppearance } from '../lib/use-diff-appearance';
import { useDiffLayout } from '../lib/use-diff-layout';
import { diffContextLines } from '../lib/review-diff';
import { NO_NOISE_FILTER } from '../lib/semantic-noise';
import { quietHeader } from '../lib/quiet-changes-header';
import { afterLines, hunksFromDiff, withPins, type GapHunk } from '../lib/diff-gaps';
import { codeIntelligenceSettings } from '../lib/code-intelligence';
import {
  COMPARE_MODES,
  cardAnchors,
  compareRowContext,
  compareRowPins,
  conflictCompareRows,
  conflictDiffText,
  conflictWritten,
  draftWritten,
  isCompareWith,
  resolverBaseline,
  shownWritten,
  fileWriter,
  proposalWriter,
  writtenFileLines,
  type CompareWith,
  type ConflictCompareRows,
} from '../lib/conflict-diff';
import { blockVerdict, type Verdict } from '../lib/conflict-verify';
import {
  shortBranch,
  type BlockEdits,
  type BlockPick,
  type BlockPicks,
  type ConflictLabels,
  type ConflictModel,
} from '../lib/conflict-blocks';
import type { ConflictFile, ConflictProposal } from '../lib/conflict-resolution';
import { blockFingerprints } from '../lib/conflict-stats';
import { nextCompare } from '../lib/conflict-shortcuts';
import type { PrFileContents } from '../lib/pr-changes';
import type { Preferences } from '../lib/types';
import { ChangesDiff, diffHosts } from './ChangesDiff';
import { Button } from './ui/button';
import { DiffFileHeader } from './DiffFileHeader';
import { useDiffFileModel } from './useDiffFileModel';
import type { ModelCard } from '../lib/conflict-model';
import { ConflictCard, InlineEdit, WrittenLegend } from './ConflictCard';
import { useConflictChoices, type ConflictViewHandle } from './useConflictChoices';
import { SIDES_CSS, conflictSideRows, markSides, prSideOf, type SideRange, type SideTone } from '../lib/conflict-sides';

/** Each diff key's latest text and its number: a mount with the same text reuses it, other text takes a new one. */
const revisions = new Map<string, { before: string; after: string; patch?: FileDiffMetadata; n: number }>();
let revisionCount = 0;
const KEPT_REVISIONS = 200;
function revisionOf(key: string, before: string, after: string, patch: FileDiffMetadata | undefined) {
  const known = revisions.get(key);
  if (known && known.before === before && known.after === after && known.patch === patch) return known.n;
  const n = ++revisionCount;
  revisions.delete(key);
  revisions.set(key, { before, after, patch, n });
  for (const old of revisions.keys()) {
    if (revisions.size <= KEPT_REVISIONS) break;
    revisions.delete(old);
  }
  return n;
}
/** Whether a hunk shows a new line. */
const showsLine = (hunks: readonly GapHunk[], line: number) =>
  hunks.some(
    (hunk) => line >= hunk.newStart && line < hunk.newStart + hunk.rows.filter((row) => row.type !== '-').length
  );

/**
 * One file of the Conflicts view as Changes shows a file (#445 item 8): DiffFileHeader over ChangesDiff, through
 * useDiffFileModel, so breadcrumbs, show scope and the code palette are the same. Quiet changes never apply.
 * `before` is the PR's version; `pins` keep lines in view that do not change, so a card can sit under them. With
 * `patch` (a file of the push confirmation that Git merged on its own) the hunks come from the patch and cannot expand.
 */
export function ConflictFileDiff<A>({
  name,
  before: beforeText = '',
  after: afterText = '',
  fileKey,
  pins = [],
  annotate,
  renderAnnotation = () => null,
  preferences,
  label,
  actions,
  bare = false,
  patch,
  previousPath,
  note,
  written,
  landmark = true,
  sides,
  sideLabels,
}: {
  /** Open conflicts' lines (lib/conflict-sides.ts): each side wears its neutral tint and its name, not −/+. */
  sides?: readonly SideRange[];
  sideLabels?: Record<SideTone, string>;
  name: string;
  before?: string;
  after?: string;
  /** The session and file: reveals and shown scopes stay under it while the draft changes. */
  fileKey: string;
  pins?: readonly (readonly [number, number])[];
  /** The annotations for the diff's hunks, before pins: an additions-side line no hunk shows is pinned. */
  annotate?: (hunks: readonly GapHunk[]) => DiffLineAnnotation<A>[];
  renderAnnotation?: (annotation: DiffLineAnnotation<A>) => ReactNode;
  preferences?: Preferences | null;
  /** What the counts compare, for the header: "against this PR". */
  label?: string;
  /** In the file header, after the counts: the Compare with switch. */
  actions?: ReactNode;
  /**
   * A row of Compare with: both (#445 item 9): one side of one conflict, without a file header, line numbers or hidden
   * lines. Its numbers would count from the conflict, not the file.
   */
  bare?: boolean;
  /** The file's change as a parsed patch, in place of `before` and `after`. */
  patch?: FileDiffMetadata;
  /** The file's path before a rename. */
  previousPath?: string;
  /** What changes besides lines, in the header: "Binary file changed", "Mode 100644 → 100755". */
  note?: string;
  /** Lines of `after` a resolver wrote, which neither side had (#445 item 10): each keeps a steady mark. */
  written?: ReadonlySet<number>;
  /** Off for a diff inside a card that names the file already: no second region with the same name. */
  landmark?: boolean;
}) {
  const before = patch ? '' : beforeText;
  const after = patch ? '' : afterText;
  const status = patch ? patchStatus(patch) : previousPath ? 'renamed' : 'modified';
  const oldPath = patch?.prevName ?? previousPath;
  const sectionRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const appearance = useDiffAppearance(preferences?.diffAppearance);
  const layout = useDiffLayout(preferences?.diffLayout);
  // A Compare with: both row hides nothing and cannot expand: context as long as the row puts all its lines in one hunk.
  const context = bare ? compareRowContext(before, after) : diffContextLines(appearance);
  const codeSettings = useMemo(() => codeIntelligenceSettings(preferences), [preferences?.codeIntelligence]);
  const { hunks, annotations, additions, deletions, sideRows } = useMemo(() => {
    let base: GapHunk[] = [];
    try {
      base = hunksFromDiff(
        patch ?? parseDiffFromFile({ name, contents: before }, { name, contents: after }, { context }, true)
      );
    } catch {
      /* Shown as the pinned lines alone. */
    }
    const lines = afterLines(after);
    // A both row with no hunks (the same as the ancestor, or a diff that didn't parse) still shows every line.
    const pinned = withPins(base, bare ? [...pins, ...compareRowPins(base, after)] : pins, lines);
    const annotations = annotate?.(base) ?? [];
    // A card's line that no hunk or pin shows yet: pinned on its own.
    const missing = annotations
      .filter((annotation) => annotation.side === 'additions' && !showsLine(pinned, annotation.lineNumber))
      .map((annotation) => [annotation.lineNumber, annotation.lineNumber] as const);
    const rows = base.flatMap((hunk) => hunk.rows);
    return {
      hunks: missing.length ? withPins(pinned, missing, lines) : pinned,
      annotations,
      additions: rows.filter((row) => row.type === '+').length,
      deletions: rows.filter((row) => row.type === '-').length,
      sideRows: sides?.length ? conflictSideRows(base, sides) : undefined,
    };
  }, [name, before, after, context, pins, annotate, bare, patch, sides]);
  const marks = useRef({ sideRows, sideLabels });
  marks.current = { sideRows, sideLabels };
  useEffect(() => {
    if (!sideLabels) return;
    if (sectionRef.current) for (const host of diffHosts(sectionRef.current)) markSides(host, sideRows, sideLabels);
  }, [sideRows, sideLabels]);
  const contents = useMemo(
    (): PrFileContents | undefined =>
      patch ? undefined : { before: { kind: 'text', content: before }, after: { kind: 'text', content: after } },
    [before, after, patch]
  );
  // Parsed definitions are cached by revision: the same text under the same key keeps its number, so a diff that mounts
  // again, as a virtualized list scrolls it back into view, keeps its parse (#491).
  const lineCount = useMemo(() => afterLines(after).length, [after]);
  const revision = useMemo(() => revisionOf(fileKey, before, after, patch), [fileKey, before, after, patch]);
  const model = useDiffFileModel({
    fileKey: `${fileKey}:${revision}`,
    // Revealed lines and pins are line numbers: a choice that changes the draft's length drops them, never misplaces them.
    revealKey: `${fileKey}:${lineCount}`,
    path: name,
    hunks,
    contents,
    expandable: !bare && !patch,
    active: true,
    readStructure: false,
    codeSettings,
    sectionRef,
    status,
    // Quiet changes never apply here: a whitespace or formatting difference between the sides is part of the decision.
    noiseFilter: NO_NOISE_FILTER,
  });
  const theme = diffThemeName(preferences?.codeTheme);
  // The file header is code-tier: its colours come from the diff's theme (lib/code-palette.ts).
  useLayoutEffect(() => applyCodePalette(theme), [theme]);
  const options: FileDiffOptions<A, undefined> = {
    preferredHighlighter: DIFF_HIGHLIGHTER,
    theme,
    themeType: 'dark',
    diffStyle: layout,
    disableFileHeader: true,
    hunkSeparators: 'simple',
    diffIndicators: appearance.indicators,
    lineDiffType: appearance.inline,
    disableBackground: !appearance.backgrounds,
    disableLineNumbers: bare || !appearance.lineNumbers,
    overflow: appearance.wrap ? 'wrap' : 'scroll',
    ...(sideLabels && {
      unsafeCSS: SIDES_CSS,
      onPostRender: (node: HTMLElement) => {
        const { sideRows: rows, sideLabels: labels } = marks.current;
        if (labels) markSides(node, rows, labels);
      },
    }),
  };
  const quiet = model.noise?.file;
  return (
    <section
      ref={sectionRef}
      className="commit-stream-file conflict-diff-file"
      aria-label={bare || !landmark ? undefined : name}
      data-code-theme={theme}
    >
      {!bare && (
        <DiffFileHeader
          headerRef={headerRef}
          path={name}
          previousPath={oldPath}
          status={status}
          stats={note && !hunks.length ? `${status} · ${note}` : undefined}
          tags={note && hunks.length ? <span className="changes-file-noise">{note}</span> : undefined}
          additions={additions}
          deletions={deletions}
          countsLabel={label}
          noise={quiet && (quiet.added || quiet.deleted) ? quietHeader(quiet, additions, deletions) : undefined}
          actions={actions}
        />
      )}
      <div className="changes-code selectable">
        {model.parts && model.parts.length > 0 && (
          <ChangesDiff
            parts={model.parts}
            file={{ name, prevName: oldPath, status }}
            layout={layout}
            options={options}
            annotations={annotations}
            renderAnnotation={renderAnnotation}
            status={model.gapStatus}
            onReveal={model.gaps ? (part, direction) => model.revealLines(part.gap, direction) : undefined}
            canReveal={model.canReveal}
            onRetry={model.retry}
            scopes={model.scopes}
            structure={model.structure}
            scopeNote={model.scopeNote}
            scopeAt={model.scopeAt}
            onShowDefinition={model.showDefinition}
            rails={model.rails}
            onCollapseScope={model.collapseScope}
            noise={model.noise}
            moves={model.moves}
            stickyUnder={bare ? undefined : headerRef}
            lineCount={model.lineCount}
            written={written}
          />
        )}
      </div>
    </section>
  );
}

/** A parsed patch's change type in Changes' words. */
const patchStatus = (patch: FileDiffMetadata) =>
  patch.type === 'new'
    ? 'added'
    : patch.type === 'deleted'
      ? 'deleted'
      : patch.type === 'change'
        ? 'modified'
        : 'renamed';

const COMPARE_KEY = 'gnosis-conflict-compare';
/** The last Compare with choice, in sessionStorage: every file and PR opens with it while the window stays open. */
function readCompare(): CompareWith {
  try {
    const saved = sessionStorage.getItem(COMPARE_KEY);
    return isCompareWith(saved) ? saved : 'pr';
  } catch {
    return 'pr';
  }
}
function useCompareWith() {
  const [value, setValue] = useState(readCompare);
  const set = useCallback((next: CompareWith) => {
    setValue(next);
    try {
      sessionStorage.setItem(COMPARE_KEY, next);
    } catch {
      /* Remembered for this file only. */
    }
  }, []);
  return [value, set] as const;
}

/** "Compare with: PR · main · both", in the file header (#445 item 9). */
function CompareSwitch({
  value,
  onChange,
  baseName,
  baseLabel,
  bothDisabled = false,
  kind = 'merge',
  shortcut = false,
}: {
  /** V cycles the modes (lib/conflict-shortcuts.ts). */
  shortcut?: boolean;
  value: CompareWith;
  onChange: (value: CompareWith) => void;
  baseName: string;
  baseLabel: string;
  /** No conflicts are left to compare side by side: both is off, and says why. */
  bothDisabled?: boolean;
  /** A paused restack compares with the updated parent and with the PR's commit, not with the PR and main. */
  kind?: 'merge' | 'restack';
}) {
  const names: Record<CompareWith, string> =
    kind === 'restack' ? { pr: 'Parent', main: 'This PR', both: 'both' } : { pr: 'PR', main: baseName, both: 'both' };
  const titles: Record<CompareWith, string> =
    kind === 'restack'
      ? {
          pr: 'What the replayed commit changes on the updated parent',
          main: 'What the updated parent changes in this PR’s commit',
          both: 'Each conflict’s two sides, with the result under them',
        }
      : {
          pr: 'What the author sees change on their branch',
          main: `What this PR still changes in ${baseLabel} after the merge`,
          both: 'Each conflict’s two sides, with the result under them',
        };
  return (
    <div className="conflict-compare" role="group" aria-label="Compare result with">
      <span className="conflict-compare-label" aria-hidden="true">
        Compare with
      </span>
      <div className="conflict-compare-switch">
        {COMPARE_MODES.map((mode) => (
          <Button
            key={mode}
            variant={value === mode ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={value === mode}
            data-compare={mode}
            title={mode === 'both' && bothDisabled ? 'No conflicts left to compare' : titles[mode]}
            // aria-disabled, not disabled: a disabled button takes no pointer events, so its tooltip could not show.
            aria-disabled={(mode === 'both' && bothDisabled) || undefined}
            aria-keyshortcuts={shortcut ? 'V' : undefined}
            onClick={() => {
              if (!(mode === 'both' && bothDisabled)) onChange(mode);
            }}
          >
            {names[mode]}
          </Button>
        ))}
      </div>
    </div>
  );
}

/** One row of Compare with: both: one version of the conflict against the ancestor, every line shown. */
function CompareRow({
  name,
  label,
  side,
  base,
  text,
  fileKey,
  preferences,
  written,
}: {
  name: string;
  label: string;
  side: 'ours' | 'theirs' | 'result';
  base: string;
  text: string;
  fileKey: string;
  preferences?: Preferences | null;
  /** The result's lines neither side had, 0-based (conflictWritten). */
  written?: readonly number[];
}) {
  const marks = useMemo(() => (written?.length ? new Set(written.map((i) => i + 1)) : undefined), [written]);
  return (
    <div className="conflict-compare-row" data-side={side}>
      <h4 className="conflict-side-label" data-side={side}>
        {label}
      </h4>
      {text && text === base && <p className="conflict-side-note">Same as before both changes</p>}
      {base || text ? (
        <ConflictFileDiff
          bare
          name={name}
          before={base}
          after={text}
          fileKey={fileKey}
          preferences={preferences}
          written={marks}
        />
      ) : (
        <p className="conflict-side-empty">No lines on this side</p>
      )}
    </div>
  );
}

/**
 * Compare with: both (#445 item 9). Each conflict as three rows, the PR's side, main's side and the result, each against
 * the ancestor, with its card under them. Only the conflicts show: PR and main show the whole file.
 */
function ConflictCompareBoth({
  name,
  fileKey,
  rows,
  total,
  labels,
  preferences,
  actions,
  card,
  written,
}: {
  name: string;
  fileKey: string;
  /** Each conflict's lines neither side had (conflictWritten): marked in its result row. */
  written: ReadonlyMap<number, readonly number[]>;
  rows: readonly ConflictCompareRows[];
  total: number;
  labels: ConflictLabels;
  preferences?: Preferences | null;
  actions: ReactNode;
  card: (index: number) => ReactNode;
}) {
  const theme = diffThemeName(preferences?.codeTheme);
  useLayoutEffect(() => applyCodePalette(theme), [theme]);
  return (
    <section
      className="commit-stream-file conflict-diff-file conflict-compare-both"
      aria-label={name}
      data-code-theme={theme}
    >
      <DiffFileHeader
        path={name}
        status="modified"
        stats={`${total} ${total === 1 ? 'conflict' : 'conflicts'} · both sides and the result, each against the version ${labels.base.toLowerCase()}`}
        actions={actions}
      />
      {rows.map((row) => (
        <section
          key={row.index}
          className="conflict-compare-group"
          aria-label={`Conflict ${row.index + 1} of ${total}`}
        >
          <CompareRow
            name={name}
            label={labels.ours}
            side="ours"
            base={row.base}
            text={row.ours}
            fileKey={`${fileKey}:both:${row.index}:ours`}
            preferences={preferences}
          />
          <CompareRow
            name={name}
            label={labels.theirs}
            side="theirs"
            base={row.base}
            text={row.theirs}
            fileKey={`${fileKey}:both:${row.index}:theirs`}
            preferences={preferences}
          />
          {row.result === undefined ? (
            <div className="conflict-compare-row" data-side="result">
              <h4 className="conflict-side-label" data-side="result">
                Result
              </h4>
              <p className="conflict-side-empty">Nothing is chosen yet.</p>
            </div>
          ) : (
            <CompareRow
              name={name}
              label="Result"
              side="result"
              base={row.base}
              text={row.result}
              fileKey={`${fileKey}:both:${row.index}:result`}
              preferences={preferences}
              written={written.get(row.index)}
            />
          )}
          <div className="conflict-diff-cards">{card(row.index)}</div>
        </section>
      ))}
    </section>
  );
}

const ConflictCards = createContext<(index: number) => ReactNode>(() => null);
/** The cards under one line, with how many of the shown version's lines above them are their conflict's (J reveals them). */
interface CardsPlace {
  indexes: number[];
  rows: number;
}
function Cards({ indexes, rows }: CardsPlace) {
  const card = useContext(ConflictCards);
  return (
    <div className="conflict-diff-cards" data-conflict-rows={rows}>
      {indexes.map(card)}
    </div>
  );
}
const renderCards = ({ metadata }: DiffLineAnnotation<CardsPlace>) => <Cards {...metadata} />;

/**
 * A file's conflicts in the shared diff (#445 item 8): the PR's version against the draft, with each conflict's card
 * under its lines (components/ConflictCard.tsx): Merged, Check or Decide, with Keep, Use the proposal, Undo and Edit
 * in place (#445 item 11).
 */
export function ConflictDiff({
  name,
  ours,
  theirs,
  fileKey,
  preferences,
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
  resolverText,
  writer,
  onChoice,
  models,
  edits,
  onEdits,
  kind = 'merge',
  onEditorDirty,
}: {
  /** The in-place editor is open with text you haven't saved (true), or not any more (false). */
  onEditorDirty?: (dirty: boolean) => void;
  /** A paused restack's file (components/RestackReview.tsx): its versions are the updated parent and the PR's commit. */
  kind?: 'merge' | 'restack';
  /** Each open conflict's model request, by index (#445 item 7). */
  models?: Readonly<Record<number, ModelCard>>;
  /**
   * Your in-place edits (#445 item 11), kept by the view so Undo survives switching files. With `onEdits`, each card has
   * Edit: the conflict's lines open in an editor under them, and Save changes that conflict's span only.
   */
  edits?: BlockEdits;
  onEdits?: (edits: BlockEdits) => void;
  name: string;
  /**
   * The text a resolver wrote for this file (resolverBaseline): where the draft's conflicts can't be told apart, its
   * lines that neither side had are marked when they are this text's, never when you typed them (#445 item 10).
   */
  resolverText?: string;
  /** Who wrote `resolverText` (writerOf), for its legend: "2 lines written by structural merge". */
  writer?: string;
  /** The PR's version of the file: the diff's old side in Compare with: PR. */
  ours: string;
  /** The base branch's version of the file: the diff's old side in Compare with: main. */
  theirs: string;
  fileKey: string;
  preferences?: Preferences | null;
  original: string;
  contents: string;
  proposals?: readonly (ConflictProposal | null)[];
  verdict?: Verdict;
  note?: string;
  wholeFile?: {
    proposal: ConflictProposal;
    ours: string;
    theirs: string;
    onUse: () => void;
    /** Use the proposal for this file on the card too: off while the footer's primary is the same action. */
    inlineUse?: boolean;
    shown: boolean;
    onShow: () => void;
  };
  labels: ConflictLabels;
  onChange: (contents: string) => void;
  disabled?: boolean;
  shortcuts?: boolean;
  handle?: Ref<ConflictViewHandle>;
  onAllResolved?: () => void;
  picks?: BlockPicks;
  onPick?: (index: number, choice: BlockPick | undefined) => void;
  /** Each choice with the one it replaces and the conflict's fingerprint, for the local stats. Undefined is Undo. */
  onChoice?: (key: string | undefined, before: BlockPick | undefined, after: BlockPick | undefined, picked: BlockPick | undefined) => void;
}) {
  // Once per file version, never on a click.
  const statsKeys = useMemo(() => (onChoice ? blockFingerprints(original) : undefined), [original, !onChoice]);
  const cycleCompare = useRef<() => boolean>(undefined);
  const { root, model, total, choose, undo, editStart, saveEdit } = useConflictChoices({
    cycleCompare,
    onChoice: onChoice && ((index, before, after, picked) => onChoice(statsKeys?.[index], before, after, picked)),
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
    edits,
    onEdits,
  });
  // The conflict open in the in-place editor, and what you typed in it: kept here, not in the draft, until you save.
  const [editing, setEditing] = useState<number>();
  const typed = useRef(new Map<number, string>());
  // Told only when it changes, never per keystroke.
  const dirtyShown = useRef(false);
  const reportDirty = (dirty: boolean) => {
    if (dirtyShown.current === dirty) return;
    dirtyShown.current = dirty;
    onEditorDirty?.(dirty);
  };
  const dirtyReport = useRef(reportDirty);
  dirtyReport.current = reportDirty;
  useEffect(() => () => dirtyReport.current(false), []);
  const closeEditor = (index: number) => {
    typed.current.delete(index);
    reportDirty(false);
    setEditing(undefined);
    // Focus returns to the conflict's card once it is back.
    requestAnimationFrame(() =>
      root.current?.querySelector<HTMLElement>(`.conflict-block[data-conflict-index="${index}"]`)?.focus({ preventScroll: true })
    );
  };
  const hideBlocks = !!wholeFile && !wholeFile.shown && (!verdict || !!verdict.passed);
  const [compare, setCompare] = useCompareWith();
  // Both with no conflict left to show (a draft edited past its conflicts) is not offered, and the view shows PR: the
  // switch never names a mode that isn't on screen.
  const hasConflicts = model.segments.some((s) => s.kind === 'conflict');
  const mode: CompareWith = compare === 'both' && !hasConflicts ? 'pr' : compare;
  const rows = useMemo(() => (mode === 'both' ? conflictCompareRows(model, proposals) : []), [mode, model, proposals]);
  // The lines a resolver wrote, which neither side had (#445 item 10): per conflict, or over the whole draft when its
  // conflicts can't be told apart and a resolver wrote it.
  const written = useMemo(() => conflictWritten(model, proposals), [model, proposals]);
  const wholeWritten = resolverText !== undefined && !model.undoable;
  const card = (index: number) => {
    const segment = model.segments.find((s) => s.kind === 'conflict' && s.index === index);
    if (segment?.kind !== 'conflict') return null;
    const start = editing === index ? editStart(index) : '';
    return (
      <ConflictCard
        picked={picks?.[index]}
        edit={model.edits?.[index] ?? undefined}
        // Only a draft that is exactly its choices can be edited conflict by conflict.
        onEdit={
          onEdits && model.undoable
            ? () => {
                typed.current.delete(index);
                setEditing(index);
              }
            : undefined
        }
        editor={
          editing === index ? (
            <InlineEdit
              name={name}
              index={index}
              theme={diffThemeName(preferences?.codeTheme)}
              start={start}
              initial={typed.current.get(index) ?? start}
              hint={
                model.choices[index] === undefined
                  ? `It starts with both sides: ${labels.ours}, then ${labels.theirs}.`
                  : undefined
              }
              disabled={disabled}
              onType={(text) => {
                typed.current.set(index, text);
                reportDirty(text !== start);
              }}
              onSave={(text) => {
                const saved = saveEdit(index, text);
                if (saved) closeEditor(index);
                return saved;
              }}
              onCancel={() => closeEditor(index)}
            />
          ) : undefined
        }
        key={`block-${index}`}
        name={name}
        block={segment.block}
        index={index}
        total={total}
        choice={model.choices[index]}
        labels={labels}
        shortcuts={shortcuts}
        disabled={disabled}
        onChoose={(choice) => choose(index, choice)}
        proposal={proposals?.[index]}
        verdict={blockVerdict(verdict, index)}
        note={note}
        model={models?.[index]}
        onUndo={model.undoable ? () => undo(index) : undefined}
        compare={mode}
        prSide={prSideOf(kind)}
        written={written.get(index)?.length ?? 0}
      />
    );
  };
  const baseName = shortBranch(labels.theirs, 16);
  // Each mode's header has its own switch: after a switch, focus moves to the new one's active button, not to the body.
  const focusSwitch = useRef(false);
  const switchTo = useCallback(
    (next: CompareWith) => {
      focusSwitch.current = true;
      setCompare(next);
    },
    [setCompare]
  );
  useLayoutEffect(() => {
    if (!focusSwitch.current) return;
    focusSwitch.current = false;
    root.current?.querySelector<HTMLElement>(`.conflict-compare [data-compare=${mode}]`)?.focus();
  }, [mode, root]);
  // V steps through the modes, as a click on the switch would (lib/conflict-shortcuts.ts).
  cycleCompare.current = hideBlocks
    ? undefined
    : () => {
        switchTo(nextCompare(mode, !hasConflicts));
        return true;
      };
  const switcher = (
    <CompareSwitch
      value={mode}
      onChange={switchTo}
      baseName={baseName}
      baseLabel={labels.theirs}
      bothDisabled={!hasConflicts}
      kind={kind}
      shortcut={shortcuts}
    />
  );
  const sides = useMemo(
    () => (wholeWritten ? { ours, theirs, resolver: resolverText, by: writer } : undefined),
    [wholeWritten, ours, theirs, resolverText, writer]
  );
  // The sides' names in the code (lib/conflict-sides.ts): the PR's, and main's or the updated parent's.
  const sideLabels = useMemo(
    (): Record<SideTone, string> => ({ pr: 'PR', base: kind === 'restack' ? 'parent' : baseName }),
    [kind, baseName]
  );
  const diff = { name, model, proposals, fileKey, preferences, labels, card, written, sides, kind, sideLabels };
  return (
    <div ref={root} className="conflict-view conflict-diff-view" data-undoable={model.undoable || undefined}>
      {wholeFile && (
        <WholeFile
          name={name}
          {...wholeFile}
          verdict={verdict}
          labels={labels}
          disabled={disabled}
          fileKey={fileKey}
          preferences={preferences}
        />
      )}
      {hideBlocks ? (
        <button type="button" className="conflict-context-toggle" onClick={wholeFile.onShow}>
          Resolve conflict by conflict instead ({total})
        </button>
      ) : (
        <>
          {mode === 'both' && (
            <ConflictCompareBoth
              name={name}
              fileKey={fileKey}
              rows={rows}
              total={total}
              labels={labels}
              preferences={preferences}
              actions={switcher}
              card={card}
              written={written}
            />
          )}
          {mode === 'main' && <CompareDiff {...diff} against="theirs" before={theirs} live actions={switcher} />}
          {/* PR stays mounted, hidden, in the other modes: its revealed lines and shown scopes survive a round trip. */}
          <CompareDiff
            {...diff}
            against="ours"
            before={ours}
            live={mode === 'pr'}
            actions={mode === 'pr' ? switcher : undefined}
          />
        </>
      )}
    </div>
  );
}

const NO_CARDS = () => null;
/** Line numbers as runs of consecutive lines, for pins: a marked line is never hidden in a gap. */
export function lineRuns(lines: ReadonlySet<number>): (readonly [number, number])[] {
  const runs: [number, number][] = [];
  for (const line of [...lines].sort((a, b) => a - b)) {
    const last = runs.at(-1);
    if (last && line === last[1] + 1) last[1] = line;
    else runs.push([line, line]);
  }
  return runs;
}
/**
 * One mode's diff of the draft (#445 items 8 and 9), with each conflict's card under its lines: against the PR's version
 * (`against` 'ours') or main's ('theirs'). A diff that isn't `live` is hidden and keeps the draft it last showed: it
 * computes nothing and shows no cards while another mode is on screen.
 */
function CompareDiff({
  name,
  model,
  proposals,
  against,
  before,
  live,
  fileKey,
  preferences,
  labels,
  card,
  actions,
  written,
  sides,
  kind,
  sideLabels,
}: {
  /** A restack's PR is the conflict's second side (theirs), a merge's the first (ours). */
  kind: 'merge' | 'restack';
  sideLabels: Record<SideTone, string>;
  name: string;
  model: ConflictModel;
  proposals?: readonly (ConflictProposal | null)[];
  against: 'ours' | 'theirs';
  before: string;
  live: boolean;
  fileKey: string;
  preferences?: Preferences | null;
  labels: ConflictLabels;
  card: (index: number) => ReactNode;
  actions?: ReactNode;
  /** Each conflict's lines neither side had (conflictWritten). */
  written: ReadonlyMap<number, readonly number[]>;
  /** Both whole versions, when the draft is a resolver's whole file: its lines neither had are marked instead. */
  sides?: { ours: string; theirs: string; resolver?: string; by?: string };
}) {
  const last = useRef({ model, proposals, written, sides });
  if (live) last.current = { model, proposals, written, sides };
  const draft = last.current;
  const shown = useMemo(
    () => conflictDiffText(draft.model, draft.proposals, against),
    [draft.model, draft.proposals, against]
  );
  // The lines a resolver wrote, by line of the shown text (#445 item 10).
  const marks = useMemo(
    () =>
      draft.sides
        ? writtenFileLines(shown.after, draft.sides.ours, draft.sides.theirs, draft.sides.resolver)
        : shownWritten(shown.blocks, draft.written),
    [shown, draft.written, draft.sides]
  );
  // Each open conflict's two sides (lib/conflict-sides.ts): the shown lines are the version not compared with.
  const sideRanges = useMemo(() => {
    const pr = prSideOf(kind);
    const tone = (side: 'ours' | 'theirs'): SideTone => (side === pr ? 'pr' : 'base');
    const shownSide = against === 'ours' ? 'theirs' : 'ours';
    return shown.blocks
      .filter((block) => draft.model.choices[block.index] === undefined)
      .map((block): SideRange => ({ start: block.start, end: block.end, added: tone(shownSide), removed: tone(against) }));
  }, [shown, draft.model, against, kind]);
  // A conflict's lines stay in view, and so does every marked line: the mark never sits in a hidden gap, even where
  // the diff reads the line as unchanged context (a moved line in a resolver's whole file).
  const pins = useMemo(
    () => [
      ...shown.blocks.filter((b) => b.end >= b.start).map((b) => [b.start, b.end] as const),
      ...lineRuns(marks),
    ],
    [shown, marks]
  );
  // Annotations only place the cards. The cards read their state from context, so a check result or a busy state
  // updates them in place: a card that kept its DOM keeps its focus and its open details.
  const annotate = useCallback(
    (hunks: readonly GapHunk[]) => {
      const byPlace = new Map<string, DiffLineAnnotation<CardsPlace>>();
      for (const anchor of cardAnchors(shown.blocks, hunks)) {
        const place = `${anchor.side}:${anchor.line}`;
        const block = shown.blocks.find((b) => b.index === anchor.index);
        // A card under its conflict's last line has the conflict's lines above it; one placed elsewhere has none.
        const rows = block && anchor.side === 'additions' && anchor.line === block.end ? block.end - block.start + 1 : 0;
        const existing = byPlace.get(place);
        if (existing) {
          existing.metadata.indexes.push(anchor.index);
          existing.metadata.rows = Math.max(existing.metadata.rows, rows);
        } else byPlace.set(place, { side: anchor.side, lineNumber: anchor.line, metadata: { indexes: [anchor.index], rows } });
      }
      return [...byPlace.values()];
    },
    [shown]
  );
  return (
    <div className="conflict-compare-diff" data-compare={against === 'theirs' ? 'main' : 'pr'} hidden={!live}>
      {/* A file with no lines left has nowhere to put a card: its cards come first. */}
      {live && shown.blocks.filter((b) => b.anchor === undefined).map((b) => card(b.index))}
      {/* A resolver's whole file has no card per conflict: the count of its marked lines heads the diff. */}
      {live && draft.sides && marks.size > 0 && <WrittenLegend count={marks.size} by={draft.sides.by} />}
      <ConflictCards.Provider value={live ? card : NO_CARDS}>
        <ConflictFileDiff
          name={name}
          before={before}
          after={shown.after}
          // Each mode is its own diff: reveals and shown scopes are line numbers of the version it compares with. PR keeps
          // the keys it always had.
          fileKey={against === 'theirs' ? `${fileKey}:main` : fileKey}
          pins={pins}
          annotate={annotate}
          renderAnnotation={renderCards}
          preferences={preferences}
          label={`Against ${against === 'theirs' ? labels.theirs : labels.ours}`}
          actions={actions}
          written={marks}
          sides={sideRanges}
          sideLabels={sideLabels}
        />
      </ConflictCards.Provider>
    </div>
  );
}

/** The result next to the PR's version, in the shared diff, with named columns: a file whose conflict Git wrote no markers for. */
export function ConflictResult({
  name,
  before,
  after,
  beforeLabel,
  afterLabel,
  fileKey,
  preferences,
  file,
  picks,
  written: marked,
  by,
  landmark,
}: {
  name: string;
  before: string;
  after: string;
  beforeLabel: string;
  afterLabel: string;
  fileKey: string;
  preferences?: Preferences | null;
  /** The conflicted file the result is the draft of: its lines a resolver wrote are marked (#445 item 10). */
  file?: Pick<ConflictFile, 'original' | 'ours' | 'theirs' | 'proposals' | 'wholeFile' | 'resolverText' | 'source'>;
  picks?: BlockPicks;
  /** The marked lines, when the caller knows them (a whole-file proposal), in place of the file's. */
  written?: ReadonlySet<number>;
  /** Who wrote the marked lines (writerOf), when the caller knows: else the file's writer. */
  by?: string;
  landmark?: boolean;
}) {
  const layout = useDiffLayout(preferences?.diffLayout);
  const written = useMemo(
    () => marked ?? (file ? draftWritten(file, after, resolverBaseline(file, after), picks) : undefined),
    [marked, file, after, picks]
  );
  const pins = useMemo(() => (written ? lineRuns(written) : []), [written]);
  return (
    <div className="conflict-result-diff">
      <DiffColumns split={layout === 'split'} before={beforeLabel} after={afterLabel} />
      {before === after ? (
        <p className="conflict-side-empty">The result is the same as {beforeLabel}.</p>
      ) : (
        <>
          {written && written.size > 0 && <WrittenLegend count={written.size} by={by ?? (file && fileWriter(file))} />}
          <ConflictFileDiff
            name={name}
            before={before}
            after={after}
            fileKey={fileKey}
            preferences={preferences}
            written={written}
            pins={pins}
            landmark={landmark}
          />
        </>
      )}
    </div>
  );
}

/**
 * Structural merge's result for the whole file. It also changes lines outside the conflicts, so it is never Merged:
 * you read it next to the PR and use it, or choose each conflict below yourself.
 */
function WholeFile({
  name,
  proposal,
  ours,
  theirs,
  onUse,
  inlineUse = true,
  verdict,
  labels,
  disabled,
  fileKey,
  preferences,
}: {
  name: string;
  fileKey: string;
  preferences?: Preferences | null;
  proposal: ConflictProposal;
  ours: string;
  /** main's whole file: with the PR's, what the proposal's lines are compared with for their marks (#445 item 10). */
  theirs: string;
  onUse: () => void;
  inlineUse?: boolean;
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
      aria-label={`Whole file. Check: ${proposal.source === 'moved' ? 'one side moved this code and the other edited it' : `${proposalWriter(proposal)} combined both sides`}. ${note}`}
    >
      <header className="conflict-block-header">
        <strong>Whole file</strong>
        <span className="conflict-bucket" data-bucket="check">
          <CircleHelp size={13} aria-hidden="true" />
          Check
        </span>
      </header>
      <p>{note}</p>
      {/* The proposal against the PR's version, with named columns, in the same diff as the conflicts below it. Inside
          this card it is no region of its own: the card names it. */}
      <ConflictResult
        name={name}
        before={ours}
        after={proposal.text}
        beforeLabel={labels.ours}
        afterLabel="Proposed result"
        fileKey={`${fileKey}:whole-file`}
        preferences={preferences}
        written={written}
        by={proposalWriter(proposal)}
        landmark={false}
      />
      {inlineUse && (
        <div className="conflict-block-actions">
          <Button size="sm" disabled={disabled} data-choice="whole-file" onClick={onUse}>
            Use the proposal for this file
          </Button>
        </div>
      )}
    </section>
  );
}

/** Column names for a diff, matching its split or unified layout. */
function DiffColumns({ split, before, after }: { split: boolean; before: string; after: string }) {
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
