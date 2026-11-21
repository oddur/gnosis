import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { parseDiffFromFile, type DiffLineAnnotation, type FileDiffMetadata, type FileDiffOptions } from '@pierre/diffs';
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
  isCompareWith,
  type CompareWith,
  type ConflictCompareRows,
} from '../lib/conflict-diff';
import { blockVerdict, type Verdict } from '../lib/conflict-verify';
import {
  shortBranch,
  type BlockChoice,
  type BlockPicks,
  type ConflictLabels,
  type ConflictModel,
} from '../lib/conflict-blocks';
import type { ConflictProposal } from '../lib/conflict-resolution';
import type { PrFileContents } from '../lib/pr-changes';
import type { Preferences } from '../lib/types';
import { ChangesDiff } from './ChangesDiff';
import { Button } from './ui/button';
import { DiffFileHeader } from './DiffFileHeader';
import { useDiffFileModel } from './useDiffFileModel';
import { Block, DiffColumns, WholeFile, useConflictChoices, type ConflictViewHandle } from './ConflictBlocks';

/** Conflict diffs mounted so far: each mount numbers its drafts on its own. */
let mounts = 0;
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
}: {
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
}) {
  const before = patch ? '' : beforeText;
  const after = patch ? '' : afterText;
  const status = patch ? patchStatus(patch) : 'modified';
  const sectionRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const appearance = useDiffAppearance(preferences?.diffAppearance);
  const layout = useDiffLayout(preferences?.diffLayout);
  // A Compare with: both row hides nothing and cannot expand: context as long as the row puts all its lines in one hunk.
  const context = bare ? compareRowContext(before, after) : diffContextLines(appearance);
  const codeSettings = useMemo(() => codeIntelligenceSettings(preferences), [preferences?.codeIntelligence]);
  const { hunks, annotations, additions, deletions } = useMemo(() => {
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
    };
  }, [name, before, after, context, pins, annotate, bare, patch]);
  const contents = useMemo(
    (): PrFileContents | undefined =>
      patch ? undefined : { before: { kind: 'text', content: before }, after: { kind: 'text', content: after } },
    [before, after, patch]
  );
  // Parsed definitions are cached by revision: each draft this mount shows is one, numbered as it changes.
  const lineCount = useMemo(() => afterLines(after).length, [after]);
  const [mount] = useState(() => ++mounts);
  const [revision, setRevision] = useState({ before, after, n: 0 });
  if (revision.before !== before || revision.after !== after) setRevision({ before, after, n: revision.n + 1 });
  const model = useDiffFileModel({
    fileKey: `${fileKey}:${mount}.${revision.n}`,
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
  };
  const quiet = model.noise?.file;
  return (
    <section
      ref={sectionRef}
      className="commit-stream-file conflict-diff-file"
      aria-label={bare ? undefined : name}
      data-code-theme={theme}
    >
      {!bare && (
        <DiffFileHeader
          headerRef={headerRef}
          path={name}
          previousPath={patch?.prevName}
          status={status}
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
            file={{ name, prevName: patch?.prevName, status }}
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
}: {
  value: CompareWith;
  onChange: (value: CompareWith) => void;
  baseName: string;
  baseLabel: string;
  /** No conflicts are left to compare side by side: both is off, and says why. */
  bothDisabled?: boolean;
}) {
  const names: Record<CompareWith, string> = { pr: 'PR', main: baseName, both: 'both' };
  const titles: Record<CompareWith, string> = {
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
}: {
  name: string;
  label: string;
  side: 'ours' | 'theirs' | 'result';
  base: string;
  text: string;
  fileKey: string;
  preferences?: Preferences | null;
}) {
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
}: {
  name: string;
  fileKey: string;
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
        stats={`${total} ${total === 1 ? 'conflict' : 'conflicts'} · each side against ${labels.base.toLowerCase()}`}
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
            />
          )}
          <div className="conflict-diff-cards">{card(row.index)}</div>
        </section>
      ))}
    </section>
  );
}

const ConflictCards = createContext<(index: number) => ReactNode>(() => null);
function Cards({ indexes }: { indexes: number[] }) {
  const card = useContext(ConflictCards);
  return <div className="conflict-diff-cards">{indexes.map(card)}</div>;
}
const renderCards = ({ metadata }: DiffLineAnnotation<{ indexes: number[] }>) => <Cards indexes={metadata.indexes} />;

/**
 * A file's conflicts in the shared diff (#445 item 8): the PR's version against the draft, with each conflict's card
 * under its lines. The cards are ConflictView's: Merged, Check and Decide read the same, with the same actions.
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
}: {
  name: string;
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
  wholeFile?: { proposal: ConflictProposal; ours: string; onUse: () => void; shown: boolean; onShow: () => void };
  labels: ConflictLabels;
  onChange: (contents: string) => void;
  disabled?: boolean;
  shortcuts?: boolean;
  handle?: Ref<ConflictViewHandle>;
  onAllResolved?: () => void;
  picks?: BlockPicks;
  onPick?: (index: number, choice: BlockChoice | undefined) => void;
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
  const hideBlocks = !!wholeFile && !wholeFile.shown && (!verdict || !!verdict.passed);
  const [compare, setCompare] = useCompareWith();
  // Both with no conflict left to show (a draft edited past its conflicts) is not offered, and the view shows PR: the
  // switch never names a mode that isn't on screen.
  const hasConflicts = model.segments.some((s) => s.kind === 'conflict');
  const mode: CompareWith = compare === 'both' && !hasConflicts ? 'pr' : compare;
  const rows = useMemo(() => (mode === 'both' ? conflictCompareRows(model, proposals) : []), [mode, model, proposals]);
  const card = (index: number) => {
    const segment = model.segments.find((s) => s.kind === 'conflict' && s.index === index);
    if (segment?.kind !== 'conflict') return null;
    return (
      <Block
        key={`block-${index}`}
        inDiff
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
        onUndo={model.undoable ? () => choose(index, undefined) : undefined}
        compare={mode}
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
  const switcher = (
    <CompareSwitch
      value={mode}
      onChange={switchTo}
      baseName={baseName}
      baseLabel={labels.theirs}
      bothDisabled={!hasConflicts}
    />
  );
  const diff = { name, model, proposals, fileKey, preferences, labels, card };
  return (
    <div ref={root} className="conflict-view conflict-diff-view" data-undoable={model.undoable || undefined}>
      {wholeFile && <WholeFile name={name} {...wholeFile} verdict={verdict} labels={labels} disabled={disabled} />}
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
}: {
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
}) {
  const last = useRef({ model, proposals });
  if (live) last.current = { model, proposals };
  const draft = last.current;
  const shown = useMemo(
    () => conflictDiffText(draft.model, draft.proposals, against),
    [draft.model, draft.proposals, against]
  );
  const pins = useMemo(
    () => shown.blocks.filter((b) => b.end >= b.start).map((b) => [b.start, b.end] as const),
    [shown]
  );
  // Annotations only place the cards. The cards read their state from context, so a check result or a busy state
  // updates them in place: a card that kept its DOM keeps its focus and its open details.
  const annotate = useCallback(
    (hunks: readonly GapHunk[]) => {
      const byPlace = new Map<string, DiffLineAnnotation<{ indexes: number[] }>>();
      for (const anchor of cardAnchors(shown.blocks, hunks)) {
        const place = `${anchor.side}:${anchor.line}`;
        const existing = byPlace.get(place);
        if (existing) existing.metadata.indexes.push(anchor.index);
        else byPlace.set(place, { side: anchor.side, lineNumber: anchor.line, metadata: { indexes: [anchor.index] } });
      }
      return [...byPlace.values()];
    },
    [shown]
  );
  return (
    <div className="conflict-compare-diff" data-compare={against === 'theirs' ? 'main' : 'pr'} hidden={!live}>
      {/* A file with no lines left has nowhere to put a card: its cards come first. */}
      {live && shown.blocks.filter((b) => b.anchor === undefined).map((b) => card(b.index))}
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
        />
      </ConflictCards.Provider>
    </div>
  );
}

/** The result next to the PR's version, in the shared diff, with named columns (Review result). */
export function ConflictResult({
  name,
  before,
  after,
  beforeLabel,
  afterLabel,
  fileKey,
  preferences,
}: {
  name: string;
  before: string;
  after: string;
  beforeLabel: string;
  afterLabel: string;
  fileKey: string;
  preferences?: Preferences | null;
}) {
  const layout = useDiffLayout(preferences?.diffLayout);
  return (
    <div className="conflict-result-diff">
      <DiffColumns split={layout === 'split'} before={beforeLabel} after={afterLabel} />
      {before === after ? (
        <p className="conflict-side-empty">The result is the same as {beforeLabel}.</p>
      ) : (
        <ConflictFileDiff name={name} before={before} after={after} fileKey={fileKey} preferences={preferences} />
      )}
    </div>
  );
}
