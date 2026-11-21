import { memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { processFile, type DiffLineAnnotation, type FileDiffOptions } from '@pierre/diffs';
import {
  GAP_STEP,
  SLICE_CHROME,
  estimateSliceHeight,
  hunkSlices,
  type DiffSlice,
  hunkCounts,
  hunkRange,
  placeOfLine,
  newLineAt,
  hiddenBetween,
  type GapDirection,
  type GapPart,
  type HunkCounts,
  type HunkRange,
} from '../lib/diff-gaps';
import { applyCodePalette } from '../lib/diff-code-palette';
import { HERE_CSS, clearHere, markHere, markSection } from '../lib/diff-here';
import { LoadingIndicator } from './LoadingState';
import { KeptFileDiff } from './KeptFileDiff';
import { FLAT_TOKEN_CSS, FLAT_TOKENS } from '../lib/diff-token-flatten';
import { definitionNoun, jumpLabel, revealLabel, spokenChain, type HunkScope, type LinePoint } from '../lib/hunk-scopes';
import type { ScopeRail } from '../lib/show-scope';
import type { ChangedSymbol } from '../lib/symbol-outline';
import { DiffOutline, type OutlineProps } from './DiffOutline';
import { CODE_LINE_HEIGHT, HUNK_SLICE_SIZE } from '../lib/review-diff';
import { definitionLines, type DefinitionReveal, type SyntaxDefinition } from '../lib/syntax-scope';
import { ArrowRightLeft, Brush, Pilcrow, SquareSlash } from 'lucide-react';
import { blockKey, changeBlocks, hunkNoise, noiseLabel, type HunkNoise, type NoiseKind } from '../lib/semantic-noise';
import type { DiffMoves, DiffNoise } from './useDiffFileModel';
import type { MoveMark } from '../lib/moved-symbols-store';
import { MoveNavigation } from '../lib/use-moved-symbols';
import { moveEditsLabel, moveNoteLines, moveWords, movedLineKeys } from '../lib/moved-symbols-view';

type GapBarPart = Extract<GapPart, { kind: 'gap' }>;
export type GapStatus =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  /** The after text no longer matches the patch, and the view cannot refresh it (a local review). */
  | { kind: 'stale' }
  /** The after text did not match the patch: the PR's changes and the file are loading again (useDiffFileModel). */
  | { kind: 'refreshing' }
  /** Still no match after that refresh, at the same revision. The reader can refresh again (`onRetry`). */
  | { kind: 'mismatch' };
/** The statuses a gap bar shows instead of its reveal controls. */
const blocked = (status: GapStatus) =>
  status.kind === 'stale' || status.kind === 'error' || status.kind === 'refreshing' || status.kind === 'mismatch';

const parse = (patch: string) => processFile(patch, { throwOnError: true });
/**
 * Pierre keeps a classic scrollbar's gutter under every diff, so each hunk of a file showed an empty scrollbar track.
 * A hunk scrolls sideways only when its lines overflow, with the app's thin scrollbar, and otherwise ends with the
 * same padding it starts with. Wrapped lines never overflow.
 */
const CHANGES_CSS = `[data-code] {
  overflow-x: auto;
  scrollbar-gutter: auto;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--muted-foreground) 60%, var(--background)) transparent;
  padding-bottom: var(--diffs-gap-block, var(--diffs-gap-fallback));
}
/* A line scrolled to lands below the file header and its hunk's pinned header (#395). */
[data-line] { scroll-margin-top: var(--diff-sticky-offset, 0px); }
/* Where a jump or a review check took the reader (lib/diff-here.ts). */
${HERE_CSS}
/* Show scope (lib/show-scope.ts): a definition shown whole because it is short has a quiet rail beside its line
   numbers, a bracket from its signature to its last line, so its extent reads at a glance while its lines keep their own
   colours. The rail is a background of the gutter cell, under the numbers, so it costs no element and moves nothing. */
[data-column-number][data-scope-rail] {
  --scope-rail: rgb(155 184 255 / 42%);
  background-repeat: no-repeat;
  background-image: linear-gradient(var(--scope-rail), var(--scope-rail)), linear-gradient(var(--scope-rail), var(--scope-rail));
  background-size: 2px 100%, 0 0;
  background-position: 3px 0, 3px 0;
}
[data-column-number][data-scope-rail=start] { background-size: 2px calc(100% - 0.5lh + 1px), 7px 2px; background-position: 3px 100%, 3px calc(0.5lh - 1px); }
[data-column-number][data-scope-rail=end] { background-size: 2px calc(0.5lh + 1px), 7px 2px; background-position: 3px 0, 3px calc(0.5lh - 1px); }
[data-column-number][data-scope-rail=only] { background-size: 7px 2px, 0 0; background-position: 3px calc(0.5lh - 1px), 0 0; }
/* Quiet changes (#396): in a hunk that also changes code, the lines whose change is only formatting or comments, and
   that the reader hides, keep their text and lose most of their change colour, so the code change reads first. */
[data-line][data-noise-line], [data-column-number][data-noise-line] {
  background-image: linear-gradient(color-mix(in srgb, var(--diffs-bg) 62%, transparent), color-mix(in srgb, var(--diffs-bg) 62%, transparent));
}
[data-noise-line] [data-diff-span] { background-color: transparent; }
/* Moved symbols (#398): the lines a move carried over unchanged keep their text and lose most of their change colour,
   so the move's real edits, which keep theirs, read first. */
[data-line][data-moved-line], [data-column-number][data-moved-line] {
  background-image: linear-gradient(color-mix(in srgb, var(--diffs-bg) 70%, transparent), color-mix(in srgb, var(--diffs-bg) 70%, transparent));
}
[data-moved-line] [data-diff-span] { background-color: transparent; }
${FLAT_TOKEN_CSS}`;
const NO_ANNOTATIONS: never[] = [];
const NO_RAILS: readonly ScopeRail[] = [];
const diffStyle = {
  '--diffs-font-family': 'var(--font-mono)',
  '--diffs-font-size': 'var(--type-code)',
  '--diffs-line-height': 'var(--leading-code)',
};
const lines = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'line' : 'lines'}`;


/**
 * Pierre re-renders a diff whenever its options differ, and compares callbacks by identity. Callbacks forward to
 * the latest props, so a parent render that only makes new closures leaves every slice alone.
 */
function useStableOptions<A>(options: FileDiffOptions<A, undefined>): FileDiffOptions<A, undefined> {
  const latest = useRef(options);
  latest.current = options;
  const signature = JSON.stringify(options, (_key, value: unknown) => (typeof value === 'function' ? 'ƒ' : value));
  return useMemo(() => {
    const stable: Record<string, unknown> = { ...options };
    for (const [key, value] of Object.entries(options))
      if (typeof value === 'function')
        stable[key] = (...args: unknown[]) =>
          (latest.current as Record<string, ((...a: unknown[]) => unknown) | undefined>)[key]?.(...args);
    return stable as FileDiffOptions<A, undefined>;
  }, [signature]);
}

const SliceDiff = memo(function SliceDiff<A>({
  slice,
  options,
  annotations,
  renderAnnotation,
  style,
}: {
  slice: DiffSlice;
  options: FileDiffOptions<A, undefined>;
  annotations: DiffLineAnnotation<A>[];
  renderAnnotation: (annotation: DiffLineAnnotation<A>) => ReactNode;
  style: CSSProperties;
}) {
  return (
    <KeptFileDiff
      fileDiff={slice.diff}
      options={options}
      lineAnnotations={annotations}
      renderAnnotation={renderAnnotation}
      style={style}
    />
  );
}) as <A>(props: {
  slice: DiffSlice;
  options: FileDiffOptions<A, undefined>;
  annotations: DiffLineAnnotation<A>[];
  renderAnnotation: (annotation: DiffLineAnnotation<A>) => ReactNode;
  style: CSSProperties;
}) => ReactNode;

/** Mounting waits this long after the last key typed in a field. */
const TYPING_PAUSE_MS = 500;
let lastTyped = -Infinity;
let typingWatched = false;
/** Inserting a diff costs style, layout and, with an accessibility client running, accessibility work. A `:has()`
 * rule in the page can make each insertion restyle far more than the diff: Tailwind's group `has` variants made
 * it restyle the whole document (#366; tests/tailwind-has.test.ts). While someone types a comment, that cost would
 * land on their keys, so background mounting waits for a pause in typing. */
function watchTyping() {
  if (typingWatched) return;
  typingWatched = true;
  const typed = (event: Event) => {
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || target.matches('input, textarea'))) lastTyped = performance.now();
  };
  for (const type of ['keydown', 'beforeinput', 'compositionupdate']) document.addEventListener(type, typed, true);
}
/** Runs `run` in an idle period at least `TYPING_PAUSE_MS` after the last key typed in a field. Returns a cancel. */
function whenIdle(run: () => void): () => void {
  watchTyping();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  const attempt = () => {
    const wait = lastTyped + TYPING_PAUSE_MS - performance.now();
    if (wait > 0) {
      timer = setTimeout(attempt, wait);
      return;
    }
    if (typeof requestIdleCallback === 'function')
      idle = requestIdleCallback(
        () => {
          // A key may have arrived while waiting for idle time.
          if (lastTyped + TYPING_PAUSE_MS > performance.now()) attempt();
          else run();
        },
        { timeout: 1000 }
      );
    else timer = setTimeout(run, 0);
  };
  attempt();
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    if (idle !== undefined) cancelIdleCallback(idle);
  };
}

/** Diffs from `from` up to about `ROWS_PER_TASK` rows, at least one. */
function batch(slices: DiffSlice[], from: number): DiffSlice[] {
  const result: DiffSlice[] = [];
  let rows = 0;
  for (let i = from; i < slices.length && (!result.length || rows + slices[i].unifiedRows <= ROWS_PER_TASK); i++) {
    result.push(slices[i]);
    rows += slices[i].unifiedRows;
  }
  return result;
}

/** A crumb's text: its kind word, tinted as the syntax theme tints keywords, then its name. */
function CrumbText({ crumb, keyword }: { crumb: string; keyword?: string }) {
  if (!keyword || !crumb.startsWith(`${keyword} `)) return <code>{crumb}</code>;
  return (
    <code>
      <span className="diff-gap-kind">{keyword}</span> {crumb.slice(keyword.length + 1)}
    </code>
  );
}

const PROVISIONAL_TITLE = "From GitHub's hunk header; the full location appears once the file is parsed.";

/**
 * Where the hunk below a bar is (#393): a breadcrumb of the definitions around the hunk, such as
 * `impl StoreBridge › fn save`. The file header above already names the file, so the file is only in the tooltip and the
 * accessible label. A long chain keeps the innermost two crumbs, with "…" for the outer ones. Each crumb whose
 * definition is not all on screen reveals it: whole up to the cap, else its signature. The breadcrumb starts at the
 * code's text column, in the code's type, so a provisional crumb resolves in place.
 */
function HunkScopeLabel({
  scope,
  file,
  onShow,
}: {
  scope: HunkScope;
  file: string;
  onShow?: (reveal: DefinitionReveal) => void;
}) {
  const spoken = spokenChain(file, scope.chain);
  const crumbs = scope.chain;
  const innermost = scope.chain.at(-1);
  const separator = (
    <span className="diff-gap-crumb-separator" aria-hidden="true">
      ›
    </span>
  );
  return (
    <span
      className="diff-gap-scope"
      data-scope-kind={scope.provisional ? 'provisional' : scope.definition.kind}
      data-provisional={scope.provisional || undefined}
    >
      <span
        className="diff-gap-symbol"
        role="group"
        aria-label={spoken}
        title={scope.provisional ? `${spoken}\n${PROVISIONAL_TITLE}` : spoken}
      >
        {crumbs.length > 1 && (
          <span className="diff-gap-more" aria-hidden="true">
            …
          </span>
        )}
        {crumbs.map((crumb, index) => {
          const lead = index > 0 && separator;
          const last = crumb === innermost;
          const text = (
            <CrumbText crumb={crumb.definition.crumb} keyword={crumb.provisional ? undefined : crumb.definition.crumbKeyword} />
          );
          const { reveal } = crumb;
          return (
            <span key={index} className="diff-gap-crumb-group" data-last={last || undefined}>
              {lead}
              {reveal && onShow ? (
                <button
                  type="button"
                  className="diff-gap-crumb"
                  data-crumb=""
                  data-innermost={last || undefined}
                  title={revealLabel({ definition: crumb.definition, reveal })}
                  onClick={() => onShow(reveal)}
                >
                  {text}
                </button>
              ) : (
                <span className="diff-gap-crumb" data-crumb="" data-innermost={last || undefined}>
                  {text}
                </span>
              )}
            </span>
          );
        })}
      </span>
    </span>
  );
}

/**
 * "Show whole function": the innermost definition, right after the breadcrumb. Where show scope showed a definition
 * whole (lib/show-scope.ts), "Collapse function" takes the hunk back to plain context.
 */
function ShowDefinition({
  scope,
  onShow,
  onCollapse,
}: {
  scope?: HunkScope;
  onShow?: (reveal: DefinitionReveal) => void;
  onCollapse?: (key: string) => void;
}) {
  // A definition the rule showed offers to collapse, even when a long stretch of it stays hidden between two of its
  // hunks: that stretch's own gap bar shows it.
  if (scope?.shown && onCollapse) {
    const { key, definition } = scope.shown;
    const noun = definitionNoun(definition);
    return (
      <button
        type="button"
        className="diff-context-button diff-gap-text"
        data-collapse-scope=""
        title={`This ${definitionLines(definition).toLocaleString()}-line ${noun} shows whole because it is short. Show only the change and its context.`}
        onClick={() => onCollapse(key)}
      >
        <span className="icon-mask icon-fold-vertical" aria-hidden="true" />
        <span className="diff-gap-label">Collapse {noun}</span>
      </button>
    );
  }
  if (!scope?.reveal || !onShow) return null;
  const signature = scope.reveal.kind === 'signature';
  return (
    <button
      type="button"
      className="diff-context-button diff-gap-text"
      data-show-definition=""
      title={
        signature
          ? `This ${definitionLines(scope.definition).toLocaleString()}-line definition is too long to show whole; this shows its signature.`
          : revealLabel(scope)
      }
      onClick={() => scope.reveal && onShow(scope.reveal)}
    >
      <span className="icon-mask icon-unfold-vertical" aria-hidden="true" />
      <span className="diff-gap-label">{revealLabel(scope)}</span>
    </button>
  );
}

/**
 * A hunk outside every definition (imports, top-level statements): "top level", muted. Shown only once the file is
 * parsed, so it always means "outside every definition", never "not known yet".
 */
function TopLevelLabel({ file }: { file: string }) {
  return (
    <span className="diff-gap-scope" data-scope-kind="file">
      <span className="diff-gap-symbol" role="group" aria-label={`In ${file}, outside any definition`} title={`${file}, outside any definition`}>
        <span className="diff-gap-crumb" data-crumb-file="" data-innermost="" data-top-level="">
          top level
        </span>
      </span>
    </span>
  );
}

/** The hunk's lines, at the bar's end: `L41–58`, or `old L12–20` for a hunk that only deletes. */
function RangeLabel({ range }: { range: HunkRange }) {
  return (
    <span className="diff-gap-range" data-hunk-range="" title={range.spoken}>
      <span aria-hidden="true">{range.label}</span>
      <span className="sr-only">{range.spoken}</span>
    </span>
  );
}

/** What the hunk changes, beside its lines: `+12 −3` in the code's green and red; one side alone when the other is 0. */
function CountsLabel({ counts }: { counts: HunkCounts }) {
  const { added, deleted } = counts;
  if (!added && !deleted) return null;
  const spoken = [added && `${lines(added)} added`, deleted && `${lines(deleted)} deleted`].filter(Boolean).join(', ');
  return (
    <span className="diff-gap-counts" title={spoken}>
      <span aria-hidden="true">
        {added > 0 && <span className="diff-gap-added">+{added}</span>}
        {deleted > 0 && <span className="diff-gap-deleted">−{deleted}</span>}
      </span>
      <span className="sr-only">{spoken}</span>
    </span>
  );
}

/**
 * A hunk header's contents, in DOM order as on screen: the expand chevrons in the line-number gutter, the breadcrumb
 * from the code's text column, the bar's other controls, and what the hunk changes and its lines at the end. Pinned,
 * the breadcrumb and the lines follow the reader: ChangesDiff writes the location of the top line in view into the
 * `-live` slots, which sit over the hunk's own in the same grid cell, so the swap never changes the bar's size. Only
 * the shown one of the two locations is in the tab order and the accessibility tree: pinned, the reader's crumbs are
 * buttons that scroll to their definitions (#417). Nothing is announced as the reader scrolls: there is no live
 * region, and the reader's line stays hidden from screen readers.
 */
function HeaderRow({
  gutter,
  location,
  controls,
  range,
  counts,
  live,
  action,
}: {
  gutter?: ReactNode;
  location?: ReactNode;
  controls?: ReactNode;
  range?: HunkRange;
  counts?: HunkCounts;
  /** The bar heads a hunk, and pins: it has the slots the reader's location is written into. */
  live?: boolean;
  /** What acts on the breadcrumb's definition ("Show whole function"), right after it. */
  action?: ReactNode;
}) {
  return (
    <>
      <span className="diff-gap-gutter">{gutter}</span>
      <span className="diff-gap-where">
        {location}
        {live && <span className="diff-gap-live" role="group" />}
      </span>
      {action && <span className="diff-gap-act">{action}</span>}
      {/* Hidden, not removed, while the bar is pinned, so pinning never changes its height. */}
      <span className="diff-gap-controls">{controls}</span>
      {(range || counts) && (
        <span className="diff-gap-end">
          {counts && <CountsLabel counts={counts} />}
          <span className="diff-gap-lines">
            {range && <RangeLabel range={range} />}
            {live && <span className="diff-gap-live-line" aria-hidden="true" />}
          </span>
        </span>
      )}
    </>
  );
}

/** A gap bar's controls and messages for its state: stale, failed, short, or the chevrons and Show all. */
function gapControls(part: GapBarPart, status: GapStatus, reveal: (direction: GapDirection) => () => void, onRetry?: () => void) {
  const { hidden, above, below } = part;
  const known = hidden !== undefined;
  if (status.kind === 'stale')
    return {
      body: (
        <span className="diff-gap-message" role="status">
          This file changed on GitHub after the diff loaded. Refresh the PR to show more lines.
        </span>
      ),
    };
  if (status.kind === 'refreshing')
    return {
      body: (
        <LoadingIndicator className="diff-gap-loading" announce={false}>
          Updating to the latest version…
        </LoadingIndicator>
      ),
    };
  if (status.kind === 'mismatch')
    return {
      body: (
        <>
          <span className="diff-gap-message" role="status">
            Couldn’t match this file to its diff.
          </span>
          {onRetry && (
            <button type="button" className="diff-context-button diff-gap-text" onClick={onRetry}>
              Refresh
            </button>
          )}
        </>
      ),
    };
  if (status.kind === 'error')
    return {
      body: (
        <>
          <span className="diff-gap-message" role="alert">
            {status.message}
          </span>
          {onRetry && (
            <button type="button" className="diff-context-button diff-gap-text" onClick={onRetry}>
              Retry
            </button>
          )}
        </>
      ),
    };
  if (known && hidden <= GAP_STEP)
    return {
      body: (
        <button type="button" className="diff-context-button diff-gap-text" onClick={reveal('all')}>
          <span className="icon-mask icon-unfold-vertical" aria-hidden="true" />
          <span className="diff-gap-label">Show {lines(hidden)}</span>
        </button>
      ),
    };
  return {
    gutter: (
      <>
        {above && (
          <button
            type="button"
            className="diff-context-button"
            aria-label={`Show ${GAP_STEP} lines below the change above`}
            title={`Show ${GAP_STEP} lines below the change above`}
            onClick={reveal('down')}
          >
            <span className="icon-mask icon-chevron-down" aria-hidden="true" />
          </button>
        )}
        {below && (
          <button
            type="button"
            className="diff-context-button"
            aria-label={`Show ${GAP_STEP} lines above the change below`}
            title={`Show ${GAP_STEP} lines above the change below`}
            onClick={reveal('up')}
          >
            <span className="icon-mask icon-chevron-up" aria-hidden="true" />
          </button>
        )}
      </>
    ),
    body: (
      <>
        <span className="diff-gap-count">{known ? `${hidden.toLocaleString()} hidden` : 'Unchanged lines below'}</span>
        <button type="button" className="diff-context-button diff-gap-text" title={known ? `Show all ${lines(hidden)}` : 'Show the rest of the file'} onClick={reveal('all')}>
          <span className="icon-mask icon-unfold-vertical" aria-hidden="true" />
          <span className="diff-gap-label">{known ? 'Show all' : 'Show the rest'}</span>
        </button>
      </>
    ),
  };
}

/**
 * The lines after a file's last hunk: one quiet code-line row, on the code's background under a hairline, with what it
 * holds and the action at the code's text column ("82 more lines · Show", or "More lines · Show" when the length is
 * unknown). It heads nothing, so it never pins. On Feedback, with nothing to show and no length, it is left out.
 */
function TrailingBar({
  part,
  status,
  onReveal,
  onRetry,
  plain,
  onShowElsewhere,
}: {
  part: GapBarPart;
  status: GapStatus;
  onShowElsewhere?: (run: number) => void;
  /** Feedback's excerpt: with nothing to show and no length, the bar is left out. */
  plain?: boolean;
  onReveal?: (part: GapBarPart, direction: GapDirection) => void;
  onRetry?: () => void;
}) {
  const { hidden } = part;
  const known = hidden !== undefined;
  const busy = status.kind === 'loading' || status.kind === 'refreshing';
  // An excerpt that cannot load more (GitHub's saved hunk on Feedback) and does not know what follows says nothing.
  if (plain && !known && !onReveal) return null;
  const label = known ? `${lines(hidden)} hidden` : 'More lines may follow';
  const more = known ? `${hidden.toLocaleString()} more ${hidden === 1 ? 'line' : 'lines'}` : 'More lines';
  if (part.gap.elsewhere !== undefined)
    return (
      <div
        className="diff-gap"
        role="group"
        aria-label={ELSEWHERE}
        data-gap={part.gap.index}
        data-trailing=""
        data-elsewhere={part.gap.elsewhere}
      >
        <span className="diff-gap-trailing">{elsewhereBody(part.gap.elsewhere, onShowElsewhere)}</span>
      </div>
    );
  let body: ReactNode;
  if (onReveal && blocked(status)) body = gapControls(part, status, () => () => {}, onRetry).body;
  else
    body = (
      <>
        <span className="diff-gap-count">{more}</span>
        {onReveal && (
          <>
            <span className="diff-gap-dot" aria-hidden="true">
              ·
            </span>
            <button
              type="button"
              className="diff-context-button diff-gap-text"
              title={known ? `Show the last ${lines(hidden)}` : 'Show the rest of the file'}
              onClick={() => onReveal(part, 'all')}
            >
              Show
            </button>
          </>
        )}
        {status.kind === 'loading' && (
          <LoadingIndicator className="diff-gap-loading" announce={false}>
            Loading lines…
          </LoadingIndicator>
        )}
      </>
    );
  return (
    <div className="diff-gap" role="group" aria-label={label} aria-busy={busy || undefined} data-gap={part.gap.index} data-trailing="">
      <span className="diff-gap-trailing">{body}</span>
    </div>
  );
}

const OPAQUE = 'Other changes, not in this topic';
const ELSEWHERE = 'Shown in another part of this topic';

/** A topic's gap over a change another block of the file shows: it says so and offers the way there. */
function elsewhereBody(run: number, onShowElsewhere?: (run: number) => void) {
  return (
    <>
      <span className="diff-gap-count">{ELSEWHERE}</span>
      {onShowElsewhere && (
        <>
          <span className="diff-gap-dot" aria-hidden="true">
            ·
          </span>
          <button type="button" className="diff-context-button diff-gap-text" onClick={() => onShowElsewhere(run)}>
            Go to it
          </button>
        </>
      )}
    </>
  );
}

function GapBar({
  part,
  status,
  onReveal,
  onRetry,
  scope,
  fileName,
  fileOnly,
  note,
  range,
  counts,
  onShowDefinition,
  plain,
  onCollapseScope,
  onShowElsewhere,
}: {
  part: GapBarPart;
  status: GapStatus;
  onReveal?: (part: GapBarPart, direction: GapDirection) => void;
  onRetry?: () => void;
  onShowElsewhere?: (run: number) => void;
  /** Name a gap by its hidden lines only, never as changes left out of a topic (Feedback). */
  plain?: boolean;
  scope?: HunkScope;
  /** The hunk below sits outside every definition of a parsed file: it is at the top level. */
  fileOnly?: boolean;
  /** The file's name, for the breadcrumb's tooltip and accessible label. */
  fileName?: string;
  /** Beside the location: the structure is loading, or failed to load. */
  note?: ReactNode;
  /** The hunk below's lines. */
  range?: HunkRange;
  /** What the hunk below changes. */
  counts?: HunkCounts;
  onShowDefinition?: (reveal: DefinitionReveal) => void;
  onCollapseScope?: (key: string) => void;
}) {
  const { hidden } = part;
  const known = hidden !== undefined;
  const busy = status.kind === 'loading' || status.kind === 'refreshing';
  const reveal = (direction: GapDirection) => () => onReveal?.(part, direction);
  // A topic that leaves out changes between its hunks says so: those lines are not the after side's alone.
  const opaque = plain && part.gap.opaque ? (known ? `${lines(hidden)} hidden` : 'Lines hidden') : OPAQUE;
  const elsewhere = part.gap.elsewhere;
  const label =
    elsewhere !== undefined
      ? ELSEWHERE
      : part.gap.opaque
        ? opaque
        : known
          ? `${lines(hidden)} hidden`
          : 'More lines may follow';
  // A gap over a change another block of the topic shows reveals nothing; it offers the jump there.
  const { gutter, body } =
    elsewhere !== undefined
      ? { gutter: undefined, body: elsewhereBody(elsewhere, onShowElsewhere) }
      : part.gap.opaque
        ? {
            // Unchanged lines next to the hunks still show; the change between them belongs to another topic.
            gutter:
              onReveal &&
              gapControls({ ...part, hidden: undefined, above: !!part.more?.down, below: !!part.more?.up }, status, reveal)
                .gutter,
            body: <span className="diff-gap-count">{opaque}</span>,
          }
        : onReveal
          ? gapControls(part, status, reveal, onRetry)
          : {
              gutter: undefined,
              body: <span className="diff-gap-count">{known ? `${lines(hidden)} hidden` : null}</span>,
            };
  const located = !!scope || (!!fileOnly && !!fileName);
  return (
    <div
      className="diff-gap"
      role="group"
      aria-label={label}
      aria-busy={busy || undefined}
      data-gap={part.gap.index}
      data-hunk-header=""
      data-elsewhere={elsewhere}
      data-message={(onReveal && blocked(status)) || undefined}
    >
      <HeaderRow
        gutter={gutter}
        location={
          scope ? (
            <HunkScopeLabel scope={scope} file={fileName ?? ''} onShow={onShowDefinition} />
          ) : fileOnly && fileName ? (
            <TopLevelLabel file={fileName} />
          ) : undefined
        }
        controls={
          <>
            {body}
            {located && note}
            {status.kind === 'loading' && (
              <LoadingIndicator className="diff-gap-loading" announce={false}>
                Loading lines…
              </LoadingIndicator>
            )}
          </>
        }
        range={range}
        counts={counts}
        live
        action={<ShowDefinition scope={scope} onShow={onShowDefinition} onCollapse={onCollapseScope} />}
      />
    </div>
  );
}

/**
 * The element a file's diff scrolls in: Changes' stream, or an Explanation topic's code pane or document, which mark
 * themselves `data-diff-scroller`. File and hunk headers stick to its top.
 */
export const DIFF_SCROLLER = '.commit-diff-stream, [data-diff-scroller]';

/** The pinned state's thresholds: 0, 5%, 10%… 100% of a header in view (see the observer in ChangesDiff). */
const STUCK_THRESHOLDS = Array.from({ length: 21 }, (_, i) => i / 20);

/** A probe that finds no line (a slice still mounting, a comment) looks again on this many following frames. */
const MISSED_PROBES = 30;

/**
 * Names where the reader is in a pinned header (`bar`): the definitions around the code line just below it, and that
 * line. One hit test finds the line, inside the diff's shadow root; the slots are rewritten only when the place
 * changes. A deleted line is named by the old file's definitions and its old number.
 */
function followReader(
  bar: HTMLElement,
  scopeAt: ((point: LinePoint) => readonly SyntaxDefinition[] | undefined) | undefined,
  file: string
): boolean {
  const where = bar.querySelector<HTMLElement>('.diff-gap-where');
  const section = bar.parentElement;
  if (!where || !section) return true;
  // Two reads of the pinned bar's own boxes: the code's text column, and the bar's bottom edge.
  const x = where.getBoundingClientRect().left + 2;
  // Half a code line below the bar: the first line mostly in view, not one sliding out under the bar.
  const y = bar.getBoundingClientRect().bottom + 10;
  let hit = document.elementFromPoint(x, y);
  if (hit?.shadowRoot) hit = hit.shadowRoot.elementFromPoint(x, y) ?? hit;
  const host = hit && (hit.getRootNode() as ShadowRoot).host;
  // Nothing to name yet, such as a slice still mounting: the caller looks again next frame.
  if (!hit || !host || !section.contains(host)) return false;
  const line = hit.closest<HTMLElement>('[data-line]');
  if (!line) return false;
  const before = line.dataset.lineType === 'change-deletion';
  const number = Number(!before && line.closest('[data-deletions]') ? line.dataset.altLine : line.dataset.line);
  if (!number) return false;
  const point: LinePoint = { side: before ? 'before' : 'after', line: number };
  const chain = scopeAt?.(point);
  const previous = bar.getAttribute('data-live-key')?.split(':')[2];
  // A deleted line without the old file's definitions keeps the place named last: it sits among the same lines.
  // The side is part of the place: each crumb jumps to its definition's first line in its side's numbers (#417).
  const scopeKey = chain
    ? `${point.side[0]}${chain.map((d) => d.start).join(',')}`
    : before && previous !== undefined
      ? previous
      : '-';
  const key = `${point.side}:${number}:${scopeKey}`;
  if (bar.getAttribute('data-live-key') === key) return true;
  bar.setAttribute('data-live-key', key);
  const lineSlot = bar.querySelector('.diff-gap-live-line');
  if (lineSlot) lineSlot.textContent = before ? `old L${number}` : `L${number}`;
  const slot = bar.querySelector<HTMLElement>('.diff-gap-live');
  if (slot && chain && previous !== scopeKey) {
    // A crumb with focus stays focused across the rewrite: on its definition's crumb, or else the innermost.
    const focused = slot.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.start ?? '' : undefined;
    closeFolded(bar);
    slot.replaceChildren(...liveCrumbs(chain, point.side));
    slot.setAttribute(
      'aria-label',
      chain.length ? spokenChain(file, chain.map((definition) => ({ definition }))) : `In ${file}, outside any definition`
    );
    fitCrumbs([slot]);
    if (focused !== undefined) {
      // Removing the focused crumb may leave the bar matching :focus-within; the mark keeps the crumbs shown.
      bar.setAttribute('data-live-focus', '');
      focusCrumb(slot, focused);
      if (!slot.contains(document.activeElement)) bar.removeAttribute('data-live-focus');
    }
  }
  if (chain || scopeKey === '-') bar.setAttribute('data-live', chain ? 'scope' : 'line');
  return true;
}

/**
 * A chain as the breadcrumb shows it, the whole chain folding from the outside like the hunk's own, or "top level".
 * Each crumb is a button that scrolls to its definition's first line, in `side`'s numbers (#417); "…" and the
 * separators are hidden from screen readers.
 */
function liveCrumbs(chain: readonly SyntaxDefinition[], side: LinePoint['side']): Node[] {
  const make = (tag: string, className: string, text?: string) => {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const decorative = (element: HTMLElement) => {
    element.setAttribute('aria-hidden', 'true');
    return element;
  };
  if (!chain.length) {
    const top = make('span', 'diff-gap-crumb', 'top level');
    top.setAttribute('data-top-level', '');
    return [top];
  }
  const groups = chain.map((definition, index) => {
    const group = make('span', 'diff-gap-crumb-group');
    if (index > 0) group.append(decorative(make('span', 'diff-gap-crumb-separator', '›')));
    const crumb = make('button', 'diff-gap-crumb') as HTMLButtonElement;
    crumb.type = 'button';
    crumb.dataset.jump = '';
    crumb.dataset.side = side;
    crumb.dataset.start = String(definition.start);
    crumb.dataset.signatureEnd = String(definition.signatureEnd);
    crumb.dataset.end = String(definition.end);
    crumb.setAttribute('aria-label', jumpLabel(definition));
    crumb.title = jumpLabel(definition);
    const code = make('code', '');
    const keyword = definition.crumbKeyword;
    if (keyword && definition.crumb.startsWith(`${keyword} `))
      code.append(make('span', 'diff-gap-kind', keyword), ` ${definition.crumb.slice(keyword.length + 1)}`);
    else code.textContent = definition.crumb;
    crumb.append(code);
    if (index === chain.length - 1) {
      crumb.setAttribute('data-innermost', '');
      group.setAttribute('data-last', '');
    }
    group.append(crumb);
    return group;
  });
  if (chain.length < 2) return groups;
  // Folded crumbs are still reachable: "…" opens them as a list under the bar (openFolded).
  const more = make('button', 'diff-gap-more', '…') as HTMLButtonElement;
  more.type = 'button';
  more.dataset.more = '';
  more.setAttribute('aria-haspopup', 'true');
  more.setAttribute('aria-expanded', 'false');
  more.setAttribute('aria-label', 'Show the folded levels');
  more.title = 'Show the folded levels';
  return [more, ...groups];
}

/** Frames a pinned crumb's jump waits at most for its reveal to render before it scrolls: a reveal the view cannot
 * make (a topic without those lines) changes nothing. */
const REVEAL_WAIT_FRAMES = 10;
/** A jump's scroll: 250 ms for a short way, up to 450 ms for a screen or more (it never animates more than a screen). */
const jumpDuration = (distance: number, screen: number) => 250 + 200 * Math.min(1, distance / Math.max(1, screen));
/** Exponential ease-out, reaching 1 at 1. */
const easeOut = (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));

/**
 * Marks the rows of each definition shown whole by show scope (lib/show-scope.ts) for its rail: `start` on its first
 * line, `end` on its last, `mid` between, on the new side's rows and their gutter cells. Deleted rows inside it carry
 * the rail through. Attributes change only where they differ, so a pass over a diff that is already marked writes
 * nothing; a diff with no rails and none marked costs one query.
 */
function markRails(host: Element, rails: readonly ScopeRail[]) {
  const root = host.shadowRoot;
  if (!root) return;
  if (!rails.length && !root.querySelector('[data-scope-rail]')) return;
  const gutters = new Map<string, Element>();
  for (const cell of root.querySelectorAll('[data-column-number]'))
    if (!cell.closest('[data-deletions]')) gutters.set(cell.getAttribute('data-line-index') ?? '', cell);
  const write = (element: Element | undefined, value: string | undefined) => {
    if (!element || element.getAttribute('data-scope-rail') === (value ?? null)) return;
    if (value) element.setAttribute('data-scope-rail', value);
    else element.removeAttribute('data-scope-rail');
  };
  let open: ScopeRail | undefined;
  for (const row of root.querySelectorAll<HTMLElement>('[data-line]')) {
    if (row.closest('[data-deletions]')) continue;
    let value: string | undefined;
    if (row.dataset.lineType === 'change-deletion') value = open ? 'mid' : undefined;
    else {
      const line = Number(row.dataset.line);
      const rail = rails.find((r) => line >= r.start && line <= r.end);
      value = !rail ? undefined : rail.start === rail.end ? 'only' : line === rail.start ? 'start' : line === rail.end ? 'end' : 'mid';
      open = rail && line < rail.end ? rail : undefined;
    }
    write(row, value);
    write(gutters.get(row.getAttribute('data-line-index') ?? ''), value);
  }
}

/**
 * Marks changed rows by side and line (`a12`, `b9`) with an attribute, on the rows and their gutter cells: the quiet
 * lines of hunks that also change code (#396, `data-noise-line`) and the lines a move carried over unchanged (#398,
 * `data-moved-line`). One pass over the rows writes each attribute; attributes change only where they differ, and a
 * diff with nothing to mark and nothing marked costs one query per attribute.
 */
function markLines(host: Element, marks: readonly (readonly [attribute: string, lines: ReadonlySet<string>])[]) {
  const root = host.shadowRoot;
  if (!root) return;
  const live = marks.filter(([attribute, lines]) => lines.size || root.querySelector(`[${attribute}]`));
  if (!live.length) return;
  const gutters = new Map<string, Element[]>();
  for (const cell of root.querySelectorAll('[data-column-number]')) {
    const index = cell.getAttribute('data-line-index') ?? '';
    gutters.set(index, [...(gutters.get(index) ?? []), cell]);
  }
  for (const row of root.querySelectorAll<HTMLElement>('[data-line]')) {
    const type = row.dataset.lineType;
    const side = type === 'change-deletion' ? 'b' : type === 'change-addition' ? 'a' : undefined;
    const elements = [row, ...(gutters.get(row.getAttribute('data-line-index') ?? '') ?? [])].filter(
      (e) => e.closest('[data-deletions]') === row.closest('[data-deletions]')
    );
    for (const [attribute, lines] of live) {
      const on = !!side && lines.has(`${side}${row.dataset.line}`);
      for (const element of elements) if (element.hasAttribute(attribute) !== on) element.toggleAttribute(attribute, on);
    }
  }
}

/** A move's annotation: the metadata ChangesDiff gives its own rows among the caller's. */
interface MoveAnnotation {
  gnosisMove: MoveMark;
  words: MoveWords;
}
type MoveWords = ReturnType<typeof moveWords>;
const isMoveAnnotation = (metadata: unknown): metadata is MoveAnnotation =>
  !!metadata && typeof metadata === 'object' && 'gnosisMove' in metadata;

/**
 * Where a moved symbol came from, or went (#398), as one quiet code line under the line above it: "Moved from
 * src/a.ts:12 · renamed from load · 2 lines edited", or "Moved up from line 22" within the file. The place is a link
 * that goes there: in this diff for a move within the file, else through the view's MoveNavigation. Without one, the
 * place is plain text. A note with no row above it in its hunk (`lead`) heads the hunk's code, outside the diff, in
 * the code column of its side.
 */
function MoveNote({ mark, words, onGo, lead }: { mark: MoveMark; words: MoveWords; onGo?: () => void; lead?: 'left' | 'right' }) {
  const { other } = mark;
  const into = mark.side === 'after';
  const { verb, place, where } = words;
  const edits = moveEditsLabel(mark);
  const rename = mark.renamed ? `, renamed ${into ? 'from' : 'to'} ${other.name}` : '';
  const how = mark.exact ? 'the same code' : `${Math.round(mark.similarity * 100)}% similar`;
  return (
    <div
      className="diff-gap diff-move-note"
      role="note"
      aria-label={`${verb} ${where}${rename}, ${edits}`}
      title={`${verb} ${where}${rename}. Matched by structure: ${how}.`}
      data-trailing=""
      data-move-note={mark.side}
      data-move-exact={mark.exact || undefined}
      data-move-lead={lead}
    >
      {/* Spaces between the parts keep the note's text readable when copied; the flex gap lays it out. */}
      <span className="diff-gap-trailing">
        <ArrowRightLeft className="diff-noise-icon" size={13} strokeWidth={2} aria-hidden="true" />
        <span className="diff-noise-label">{verb}</span>{' '}
        {onGo ? (
          <button type="button" className="diff-context-button diff-gap-text" data-move-jump="" aria-label={`Go to ${where}`} onClick={onGo}>
            <code>{place}</code>
          </button>
        ) : (
          <code className="diff-move-place">{place}</code>
        )}{' '}
        {mark.renamed && (
          <>
            <span className="diff-gap-dot" aria-hidden="true">
              ·
            </span>{' '}
            <span className="diff-gap-count" data-move-rename="">
              renamed {into ? 'from' : 'to'} <code>{other.name}</code>
            </span>{' '}
          </>
        )}
        <span className="diff-gap-dot" aria-hidden="true">
          ·
        </span>{' '}
        <span className="diff-gap-count" data-move-edits={mark.edits?.changed.length}>
          {edits}
        </span>
      </span>
    </div>
  );
}

/** A quiet run's icon: a pilcrow for whitespace, a brush for formatting, a slash for comments. */
function NoiseIcon({ kinds }: { kinds: readonly NoiseKind[] }) {
  const label = noiseLabel(kinds);
  const Icon = label === 'Comments only' ? SquareSlash : label.startsWith('Formatting') ? Brush : Pilcrow;
  return <Icon className="diff-noise-icon" size={13} strokeWidth={2} aria-hidden="true" />;
}

/**
 * A hunk whose every change is formatting or comments the reader hides (#396): one quiet code line in its place, under
 * its header, that says what it holds and shows it. Nothing is gone: the header keeps its breadcrumb, lines and
 * counts, and "Show" puts the hunk back.
 */
function NoiseBar({
  quiet,
  rows,
  lines: span,
  onShow,
}: {
  quiet: HunkNoise;
  rows: number;
  /** The hunk's new and old lines, so a jump to one of them finds this bar and opens it (lib/diff-here.ts). */
  lines: { after: [number, number]; before: [number, number] };
  onShow?: () => void;
}) {
  const label = noiseLabel(quiet.kinds);
  return (
    <div
      className="diff-gap"
      role="group"
      aria-label={`${label}, ${lines(rows)} hidden`}
      data-trailing=""
      data-noise-bar={label}
      data-noise-after={span.after.join('-')}
      data-noise-before={span.before.join('-')}
    >
      <span className="diff-gap-trailing">
        <NoiseIcon kinds={quiet.kinds} />
        <span className="diff-noise-label">{label}</span>
        <span className="diff-gap-dot" aria-hidden="true">
          ·
        </span>
        {onShow ? (
          <button type="button" className="diff-context-button diff-gap-text" data-noise-show="" onClick={onShow} title={`Show this ${label.toLowerCase()} change`}>
            Show {lines(rows)}
          </button>
        ) : (
          <span className="diff-gap-count">{lines(rows)}</span>
        )}
      </span>
    </div>
  );
}

/** A definition's signature is marked "here" with its first line, up to this many lines. */
const MAX_HERE_LINES = 12;

/** Where to take the reader in a file's diff (#417, #394): a line on one side, in that side's numbers. */
export interface DiffDestination {
  side: LinePoint['side'];
  line: number;
  /** New lines to reveal first, if any are hidden: a crumb reveals from its definition down to the reader. */
  reveal?: readonly [number, number];
  /** The lines to mark "here", on `side`: by default the line alone, a definition's whole signature for a crumb. */
  here?: readonly [number, number];
  /** The definition the line starts, on `side`: the whole of it is marked, its signature (`here`) most. */
  section?: readonly [number, number];
}
/** What a view holds to take the reader to a line of the file's diff, as a pinned crumb does. */
export interface DiffNavigator {
  goTo(destination: DiffDestination): void;
}

/** What the reader does to scroll: any of these stops a pinned crumb's jump from correcting the view (#417). */
const READER_SCROLLS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/**
 * The row of a line on one side, in the diffs under `scope`: deleted rows and the old column's rows carry old
 * numbers in `data-line`, the rest new ones, with the other side's number in `data-alt-line`.
 */
function lineElement(scope: ParentNode, side: LinePoint['side'], line: number): HTMLElement | undefined {
  const selector = `[data-line="${line}"], [data-alt-line="${line}"]`;
  for (const host of scope.querySelectorAll('diffs-container'))
    for (const row of host.shadowRoot?.querySelectorAll<HTMLElement>(selector) ?? []) {
      const type = row.dataset.lineType;
      if (type === (side === 'before' ? 'change-addition' : 'change-deletion')) continue;
      const own = type === 'change-addition' || type === 'change-deletion' || (side === 'before') === !!row.closest('[data-deletions]');
      if (Number(own ? row.dataset.line : row.dataset.altLine) === line) return row;
    }
  return undefined;
}

/**
 * Opens the levels a narrow pinned breadcrumb folded into "…" (#417): a list under the bar, outermost first, of the
 * same crumbs, which go where theirs go. Escape, a jump, or the reader moving on closes it.
 */
function openFolded(more: HTMLElement) {
  const bar = more.closest<HTMLElement>('[data-hunk-header]');
  const slot = more.closest<HTMLElement>('.diff-gap-live');
  if (!bar || !slot) return;
  if (closeFolded(bar)) return;
  const menu = document.createElement('div');
  menu.className = 'diff-gap-folded';
  menu.setAttribute('role', 'group');
  menu.setAttribute('aria-label', 'Folded levels');
  for (const crumb of slot.querySelectorAll<HTMLElement>(':scope > .diff-gap-crumb-group[data-collapsed] > button[data-jump]')) {
    const item = crumb.cloneNode(true) as HTMLElement;
    item.removeAttribute('data-innermost');
    menu.append(item);
  }
  if (!menu.childElementCount) return;
  menu.style.left = `${Math.round(more.getBoundingClientRect().left - bar.getBoundingClientRect().left)}px`;
  bar.append(menu);
  bar.setAttribute('data-folded-open', '');
  more.setAttribute('aria-expanded', 'true');
  menu.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
}
/** Closes a bar's list of folded levels; whether one was open. */
function closeFolded(bar: Element): boolean {
  const menu = bar.querySelector(':scope > .diff-gap-folded');
  bar.removeAttribute('data-folded-open');
  bar.querySelector('.diff-gap-live > [data-more]')?.setAttribute('aria-expanded', 'false');
  menu?.remove();
  return !!menu;
}

/** Focuses a pinned crumb without scrolling: the one for the definition starting at `start` if it shows, else the
 * innermost, which never folds. */
function focusCrumb(slot: HTMLElement, start: string) {
  const crumbs = [...slot.querySelectorAll<HTMLElement>(':scope > .diff-gap-crumb-group:not([data-collapsed]) > button[data-jump]')];
  (crumbs.find((crumb) => crumb.dataset.start === start) ?? crumbs.at(-1))?.focus({ preventScroll: true });
}

/**
 * Folds breadcrumbs that overflow their bar, from the outside: the outermost crumb goes into "…" first, then the next,
 * and the innermost never folds. Every list is reset and measured together, so a pass costs one layout per round, at
 * most one round per crumb, and runs only when the bars' width or their crumbs change, never while scrolling.
 */
function fitCrumbs(lists: Iterable<HTMLElement>) {
  const all = [...lists];
  for (const list of all) {
    list.removeAttribute('data-collapsed');
    for (const group of list.querySelectorAll(':scope > [data-collapsed]')) group.removeAttribute('data-collapsed');
  }
  let pending = all;
  while (pending.length) {
    const over = pending.filter((list) => list.scrollWidth > list.clientWidth + 1);
    pending = [];
    for (const list of over) {
      const next = list.querySelector<HTMLElement>(':scope > .diff-gap-crumb-group:not([data-collapsed]):not([data-last])');
      if (!next) continue;
      next.setAttribute('data-collapsed', '');
      list.setAttribute('data-collapsed', '');
      pending.push(list);
    }
  }
}
const crumbLists = (root: ParentNode) => root.querySelectorAll<HTMLElement>('.diff-gap-symbol, .diff-gap-live');

/**
 * The last file header's height. Files in a stream share their header's layout, so a diff renders with this height
 * from the start, and measuring its own header changes nothing: setting the property later would restyle every line
 * of the diff (#366).
 */
let lastFileHeaderHeight: number | undefined;

/** Rows mounted with the first render, and in each task after it, nearest the viewport first. */
const ROWS_PER_TASK = 200;
/** A file with more diffs than this mounts them progressively even when no hunk is sliced. */
const MANY_DIFFS = 8;

/**
 * A changed file as hunks and the gaps between them. Each hunk is its own Pierre diff, so a gap bar can sit between
 * hunks and reveal lines into them (#299). A hunk longer than 300 rows renders as 200-row slices: slices outside the
 * viewport skip style and layout, and mount one per task after the first, so a 3,000-line file paints what is in
 * view first and fills in the rest without one long task (#353). Every slice ends up in the DOM, so find in page,
 * selection and jumps reach every line.
 */
export function ChangesDiff<A>({
  parts,
  file,
  layout,
  options,
  annotations,
  renderAnnotation,
  status,
  onReveal,
  onRetry,
  target,
  lineCount,
  scopes,
  structure,
  scopeNote,
  onShowDefinition,
  stickyUnder,
  scopeAt,
  canReveal,
  plainGaps,
  onShowElsewhere,
  navigator,
  rails = NO_RAILS,
  onCollapseScope,
  outline,
  noise,
  moves,
}: {
  parts: GapPart[];
  file: { name: string; prevName?: string; status?: string };
  layout: 'split' | 'unified';
  options: FileDiffOptions<A, undefined>;
  annotations: DiffLineAnnotation<A>[];
  renderAnnotation: (annotation: DiffLineAnnotation<A>) => ReactNode;
  status: GapStatus;
  onReveal?: (part: GapBarPart, direction: GapDirection) => void;
  onRetry?: () => void;
  /** A line to show: its slice mounts first. */
  target?: { side: 'before' | 'after'; line: number };
  /** The highest line number in the file, so every slice's gutter has the same width. */
  lineCount: number;
  /** The file is parsed: hunks outside every definition show the file as their location. */
  structure?: boolean;
  /** Each hunk's enclosing definition, by part key (lib/hunk-scopes.ts). */
  scopes?: ReadonlyMap<string, HunkScope>;
  /** Shown beside each hunk's location: the structure is loading, or failed to load. */
  scopeNote?: ReactNode;
  onShowDefinition?: (reveal: DefinitionReveal) => void;
  /** The file's sticky header: each hunk's header pins right below it (#395). */
  stickyUnder?: RefObject<HTMLElement | null>;
  /**
   * The definitions around a line, outermost first, for a pinned header to follow the reader; empty at the top level,
   * undefined where the file's structure says nothing.
   */
  scopeAt?: (point: LinePoint) => readonly SyntaxDefinition[] | undefined;
  /** Whether a gap can show its lines; by default every gap can when `onReveal` is set. */
  canReveal?: (gap: GapBarPart['gap']) => boolean;
  /** Gaps name only their hidden lines: Feedback shows a comment's excerpt, not a topic's chosen hunks. */
  plainGaps?: boolean;
  /** An Explanation topic's gap over a change another block of the file shows offers a jump to that block. */
  onShowElsewhere?: (run: number) => void;
  /** Set while the diff can take the reader to a line, as its pinned crumbs do: the file's outline uses it. */
  navigator?: RefObject<DiffNavigator | null>;
  /** Definitions shown whole by show scope (lib/show-scope.ts), for their rails. */
  rails?: readonly ScopeRail[];
  /** Takes a definition shown whole by show scope back to plain context. */
  onCollapseScope?: (key: string) => void;
  /** The file's outline of changed symbols (#394), above its first hunk. */
  outline?: Omit<OutlineProps, 'onGo'>;
  /** Quiet changes (#396): hunks whose every change the reader hides show as a bar, and quiet lines among code dim. */
  noise?: DiffNoise;
  /** Moved and renamed symbols (#398): a note above each one, and the lines it carried over unchanged dimmed. */
  moves?: DiffMoves;
}) {
  const latestRails = useRef(rails);
  latestRails.current = rails;
  // The kinds of the blocks still hidden: those the reader opened show.
  const quietKinds = useMemo(() => {
    if (!noise || !noise.shown.size) return noise?.kinds;
    const kinds = new Map(noise.kinds);
    for (const key of noise.shown) kinds.delete(key);
    return kinds;
  }, [noise?.kinds, noise?.shown]);
  const stableOptions = useStableOptions({
    ...options,
    // One text node per line (lib/diff-token-flatten.ts).
    ...({ [FLAT_TOKENS]: true } as object),
    hunkSeparators: 'simple',
    unsafeCSS: options.unsafeCSS ? `${options.unsafeCSS}\n${CHANGES_CSS}` : CHANGES_CSS,
    // Each rendered diff marks its rows for show scope's rails.
    onPostRender: (node: HTMLElement, ...rest: unknown[]) => {
      (options.onPostRender as ((node: HTMLElement, ...rest: unknown[]) => void) | undefined)?.(node, ...rest);
      markRails(node, latestRails.current);
      markLines(node, [
        ['data-noise-line', latestNoiseLines.current],
        ['data-moved-line', latestMovedLines.current],
      ]);
    },
  } as FileDiffOptions<A, undefined>);
  const latestRender = useRef(renderAnnotation);
  latestRender.current = renderAnnotation;
  const openMove = useContext(MoveNavigation);
  const latestOpenMove = useRef(openMove);
  latestOpenMove.current = openMove;
  // A move's note goes to its other end: in this diff for a move within the file, else through the view.
  const goToMove = (mark: MoveMark) => {
    const { other } = mark;
    if (mark.sameFile)
      own.current?.goTo({
        side: other.side,
        line: other.start,
        here: [other.start, Math.max(other.start, other.signatureEnd)],
        section: [other.start, other.end],
      });
    else latestOpenMove.current?.({ url: other.url, headSha: other.headSha, path: other.diffPath, line: other.start, endLine: other.end, side: other.side });
  };
  const latestGoToMove = useRef(goToMove);
  latestGoToMove.current = goToMove;
  const [stableRender] = useState(() => (annotation: DiffLineAnnotation<A>) => {
    const metadata: unknown = annotation.metadata;
    if (isMoveAnnotation(metadata)) {
      const mark = metadata.gnosisMove;
      return <MoveNote mark={mark} words={metadata.words} onGo={mark.sameFile || latestOpenMove.current ? () => latestGoToMove.current(mark) : undefined} />;
    }
    return latestRender.current(annotation);
  });
  // A revealed gap re-creates the hunks around it with equal rows; slices are reused by content.
  const cache = useRef(new Map<string, DiffSlice[]>());
  const blocks = useMemo(() => {
    const next = new Map<string, DiffSlice[]>();
    const result = parts.map((part) => {
      if (part.kind === 'gap') return part;
      const { hunk } = part;
      const id = `${part.key}|${hunk.oldStart}|${hunk.newStart}|${hunk.rows.length}|${hunk.noEofOld}|${hunk.noEofNew}`;
      const slices = cache.current.get(id) ?? hunkSlices(part.key, hunk, file, parse);
      next.set(id, slices);
      return {
        kind: 'hunk' as const,
        key: part.key,
        slices,
        changed: part.hunk.rows.some((row) => row.type !== ' '),
        counts: hunkCounts(hunk),
        range: hunkRange(hunk),
        rows: hunk.rows.length,
        lines: {
          after: [hunk.newStart, hunk.newStart + hunk.rows.filter((row) => row.type !== '-').length - 1] as [number, number],
          before: [hunk.oldStart, hunk.oldStart + hunk.rows.filter((row) => row.type !== '+').length - 1] as [number, number],
        },
        quiet: noise && quietKinds ? hunkNoise(hunk, quietKinds, noise.filter) : undefined,
        blockKeys: noise ? changeBlocks([hunk]).map(blockKey) : [],
      };
    });
    cache.current = next;
    return result;
  }, [parts, file.name, file.prevName, file.status, quietKinds, noise?.filter.whitespace, noise?.filter.formatting, noise?.filter.comments]);
  // Quiet lines in hunks that also change code: dimmed, not hidden.
  const noiseLines = useMemo(() => {
    const result = new Set<string>();
    for (const block of blocks)
      if (block.kind === 'hunk' && block.quiet && !block.quiet.hidden)
        for (const { side, line } of block.quiet.lines) result.add(`${side === 'before' ? 'b' : 'a'}${line}`);
    return result;
  }, [blocks]);
  const latestNoiseLines = useRef(noiseLines);
  latestNoiseLines.current = noiseLines;
  const slices = useMemo(() => blocks.flatMap((block) => (block.kind === 'hunk' ? block.slices : [])), [blocks]);
  // Hunks with a change: pinned context (a definition's signature) is not a location of its own.
  const changedHunks = useMemo(() => new Set(blocks.flatMap((block) => (block.kind === 'hunk' && block.changed ? [block.key] : []))), [blocks]);
  const progressive = slices.length > MANY_DIFFS || (slices.length > 1 && slices.some((slice) => slice.key.includes(':')));
  const split = layout === 'split' && file.status !== 'added' && file.status !== 'deleted';
  // Each move's note heads its symbol (lib/moved-symbols-view.ts); only a symbol with a note shows as moved.
  const noteLines = useMemo(() => moveNoteLines(parts, moves?.marks ?? [], split), [parts, moves?.marks, split]);
  // Lines each move carried over unchanged: dimmed, so its real edits read first.
  const movedLines = useMemo(() => movedLineKeys([...noteLines.keys()]), [noteLines]);
  const latestMovedLines = useRef(movedLines);
  latestMovedLines.current = movedLines;
  // Notes with no row above them in their hunk, by hunk: they head its code.
  const leadNotes = useMemo(() => {
    const result = new Map<string, MoveMark[]>();
    for (const [mark, at] of noteLines) if ('hunk' in at) result.set(at.hunk, [...(result.get(at.hunk) ?? []), mark]);
    return result;
  }, [noteLines]);
  const style = useMemo(
    () =>
      ({
        ...diffStyle,
        '--diffs-min-number-column-width': `${Math.max(3, String(lineCount).length)}ch`,
      }) as CSSProperties,
    [lineCount]
  );
  const [headerHeight] = useState(() => lastFileHeaderHeight);
  // The hunk headers line up with the code: their gutter is as wide as the diff's (globals.css), from the same width.
  const numberWidth = style['--diffs-min-number-column-width' as keyof CSSProperties] as string;
  const rootStyle = useMemo(
    () =>
      ({
        '--diff-number-width': numberWidth,
        ...(headerHeight === undefined ? {} : { '--diff-file-header-height': `${headerHeight}px` }),
      }) as CSSProperties,
    [numberWidth]
  );
  const codeTheme = typeof options.theme === 'string' ? options.theme : undefined;
  useLayoutEffect(() => applyCodePalette(codeTheme), [codeTheme]);
  const bySlice = useMemo(() => {
    const result = new Map<string, DiffLineAnnotation<A>[]>();
    for (const annotation of annotations) {
      const owner = slices.find((slice) => {
        const [from, to] = annotation.side === 'deletions' ? slice.oldLines : slice.newLines;
        return annotation.lineNumber >= from && annotation.lineNumber <= to;
      });
      if (owner) result.set(owner.key, [...(result.get(owner.key) ?? []), annotation]);
    }
    return result;
  }, [annotations, slices]);
  const moveBySlice = useMemo(() => {
    const result = new Map<string, DiffLineAnnotation<A>[]>();
    if (!moves?.marks.length) return result;
    for (const [mark, at] of noteLines) {
      if ('hunk' in at) continue;
      const lineNumber = at.line;
      const side = at.side === 'after' ? ('additions' as const) : ('deletions' as const);
      const owner = slices.find((slice) => {
        const [from, to] = side === 'deletions' ? slice.oldLines : slice.newLines;
        return lineNumber >= from && lineNumber <= to;
      });
      const metadata: MoveAnnotation = { gnosisMove: mark, words: moveWords(mark, parts) };
      const annotation = { side, lineNumber, metadata } as unknown as DiffLineAnnotation<A>;
      if (owner) result.set(owner.key, [...(result.get(owner.key) ?? []), annotation]);
    }
    return result;
  }, [noteLines, slices, parts]);
  const sliceAnnotations = useMemo(() => {
    if (!moveBySlice.size) return bySlice;
    const result = new Map(bySlice);
    for (const [key, list] of moveBySlice) result.set(key, [...(result.get(key) ?? []), ...list]);
    return result;
  }, [bySlice, moveBySlice]);
  const targetKey = useMemo(() => {
    if (!target) return undefined;
    return slices.find((slice) => {
      const [from, to] = target.side === 'before' ? slice.oldLines : slice.newLines;
      return target.line >= from && target.line <= to;
    })?.key;
  }, [slices, target?.side, target?.line]);
  const [mounted, setMounted] = useState<ReadonlySet<string>>(
    () => new Set([...batch(slices, 0).map((slice) => slice.key), ...(targetKey ? [targetKey] : [])])
  );
  // Slices that hold a comment or the jump target mount at once, so they can be read and scrolled to.
  const wanted = useMemo(
    () => [...(targetKey ? [targetKey] : []), ...bySlice.keys()].filter((key) => !mounted.has(key)),
    [targetKey, bySlice, mounted]
  );
  useLayoutEffect(() => {
    if (wanted.length) setMounted((current) => new Set([...current, ...wanted]));
  }, [wanted]);
  const root = useRef<HTMLDivElement>(null);
  const near = useRef(new Set<string>());
  const [nearVersion, setNearVersion] = useState(0);
  useEffect(() => {
    if (!progressive || !root.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.slice;
          if (!key) continue;
          if (entry.isIntersecting) near.current.add(key);
          else near.current.delete(key);
        }
        setNearVersion((n) => n + 1);
      },
      { rootMargin: '1200px 0px' }
    );
    for (const element of root.current.querySelectorAll<HTMLElement>('[data-slice]')) observer.observe(element);
    return () => observer.disconnect();
  }, [progressive, slices]);
  useEffect(() => {
    if (!progressive) return;
    const pending = slices.filter((slice) => !mounted.has(slice.key));
    if (!pending.length) return;
    const nearest = pending.filter((slice) => near.current.has(slice.key));
    const next = batch(nearest.length ? nearest : pending, 0);
    // One batch per idle task, and none while the reader types: the reader can scroll and type between them.
    return whenIdle(() => setMounted((current) => new Set([...current, ...next.map((slice) => slice.key)])));
  }, [progressive, slices, mounted, nearVersion]);

  // Pinned hunk headers (#395). CSS sticky does the pinning; this only marks a pinned header, so its expand controls
  // can step aside. The file header's height comes from a ResizeObserver, never a layout read, and sets both the
  // headers' `top` and the line below which one counts as pinned. A pinned header sits 1 px under the file header,
  // which covers its top border, so it is the one header that crosses that line and is not wholly below it.
  const stuck = useRef<IntersectionObserver>(undefined);
  const latestScopeAt = useRef(scopeAt);
  latestScopeAt.current = scopeAt;
  // What a pinned crumb's jump reads when clicked (#417).
  const latestParts = useRef(parts);
  latestParts.current = parts;
  const latestBlocks = useRef(blocks);
  latestBlocks.current = blocks;
  const latestNoise = useRef(noise);
  latestNoise.current = noise;
  const latestShow = useRef(onShowDefinition);
  latestShow.current = onShowDefinition;
  const latestName = useRef('');
  latestName.current = file.name.slice(file.name.lastIndexOf('/') + 1);
  const follow = useRef<() => void>(undefined);
  // The diff's own navigator, for its outline.
  const own = useRef<DiffNavigator | null>(null);
  // An outline symbol goes where its crumb would (#394): its definition's first line, revealing every hidden line from
  // there down to its first change, and nothing above it; its signature is marked "here".
  const goToSymbol = ({ definition, side, first }: ChangedSymbol) => {
    const parts = latestParts.current;
    const from = newLineAt(parts, side, definition.start);
    const to = newLineAt(parts, first.side, first.line);
    own.current?.goTo({
      side,
      line: definition.start,
      reveal: from !== undefined && to !== undefined && from < to ? [from, to - 1] : undefined,
      here: [definition.start, Math.max(definition.start, definition.signatureEnd)],
      section: [definition.start, definition.end],
    });
  };
  const observeHeaders = () => {
    const observer = stuck.current;
    if (!observer || !root.current) return;
    observer.disconnect();
    for (const header of root.current.querySelectorAll('[data-hunk-header]')) observer.observe(header);
  };
  useEffect(() => {
    const element = root.current;
    const header = stickyUnder?.current;
    const scroller = element?.closest<HTMLElement>(DIFF_SCROLLER);
    if (!element || !header || !scroller) return;
    let height: number | undefined;
    let written = headerHeight;
    // While a header is pinned, its breadcrumb and lines name where the reader is: the line at the top of the view,
    // found by one hit test a frame at most, and only while scrolling with a header pinned (followReader).
    const pinned = new Set<HTMLElement>();
    let frame = 0;
    let listening = false;
    // Frames left to look again for a place a probe could not name (MISSED_PROBES).
    let retries = 0;
    const probe = () => {
      frame = 0;
      let missed = false;
      for (const bar of pinned)
        if (!bar.isConnected) pinned.delete(bar);
        else if (!followReader(bar, latestScopeAt.current, latestName.current)) missed = true;
      if (missed && retries-- > 0) frame = requestAnimationFrame(probe);
    };
    const schedule = () => {
      retries = MISSED_PROBES;
      if (!frame) frame = requestAnimationFrame(probe);
    };
    const listen = (on: boolean) => {
      if (on === listening) return;
      listening = on;
      if (on) scroller.addEventListener('scroll', schedule, { passive: true });
      else {
        scroller.removeEventListener('scroll', schedule);
        cancelAnimationFrame(frame);
        frame = 0;
      }
    };
    follow.current = () => {
      for (const bar of pinned) bar.removeAttribute('data-live-key');
      if (pinned.size) schedule();
    };
    const resize = new ResizeObserver((entries) => {
      const next = Math.round(entries[entries.length - 1].borderBoxSize[0].blockSize);
      if (next === height) return;
      height = lastFileHeaderHeight = next;
      if (next !== written) element.style.setProperty('--diff-file-header-height', `${(written = next)}px`);
      stuck.current?.disconnect();
      stuck.current = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const top = entry.rootBounds?.top ?? 0;
            mark(entry.target, entry.isIntersecting && entry.intersectionRatio < 1 && entry.boundingClientRect.top < top);
          }
          settled();
        },
        // A threshold every 5%: a header is partly in view both while it enters at the bottom and while it is pinned,
        // so a jump straight from one to the other, such as to a line of a file never shown, crosses one of them.
        { root: scroller, rootMargin: `-${next}px 0px 0px 0px`, threshold: STUCK_THRESHOLDS }
      );
      observeHeaders();
    });
    resize.observe(header);
    const mark = (target: Element, stuckNow: boolean) => {
      target.toggleAttribute('data-stuck', stuckNow);
      if (stuckNow) pinned.add(target as HTMLElement);
      else {
        pinned.delete(target as HTMLElement);
        target.removeAttribute('data-live-focus');
        closeFolded(target);
      }
    };
    const settled = () => {
      for (const bar of pinned) if (!bar.isConnected) pinned.delete(bar);
      listen(pinned.size > 0);
      if (pinned.size) schedule();
    };
    // Once any scroll ends, however the reader arrived (a jump, a review check, a deep link, the outline), the pinned
    // state is read from the headers' boxes, for the one case the thresholds cannot see: a header partly in view by
    // exactly as much before a jump as after it. One read of this diff's box, and of its headers' when it is in view.
    const recheck = () => {
      if (height === undefined) return;
      const view = scroller.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      if (box.bottom <= view.top || box.top >= view.bottom) return;
      const line = view.top + height;
      for (const bar of element.querySelectorAll('[data-hunk-header]')) {
        const r = bar.getBoundingClientRect();
        const stuckNow = r.bottom > line && r.top < view.bottom && r.top < line;
        if (stuckNow !== bar.hasAttribute('data-stuck')) mark(bar, stuckNow);
      }
      settled();
    };
    scroller.addEventListener('scrollend', recheck, { passive: true });

    // Going to a line (#417): a pinned crumb, or a symbol of the file's outline (#394). Whatever must show is revealed
    // first; then the line scrolls right under the pinned headers, with an eased move. A line that stays hidden (a topic
    // without it) is stood in for by its gap's bar. A line in a slice not laid out yet is aimed at by its estimated
    // place until it mounts. The reader's wheel, touch, pointer or key stops the scroll. Where it lands is marked "here"
    // (lib/diff-here.ts), and the pinned breadcrumb then follows the reader as after any scroll.
    let jumpFrame = 0;
    let jumpId = 0;
    const stopJump = () => {
      cancelAnimationFrame(jumpFrame);
      jumpFrame = 0;
      for (const type of READER_SCROLLS) scroller.removeEventListener(type, stopJump);
    };
    const goTo = ({ side, line: start, reveal, here = [start, start], section, onLanded }: DiffDestination & { onLanded?: () => void }) => {
      stopJump();
      clearHere();
      const id = ++jumpId;
      // Every bar has the same height, pinned or not.
      const barHeight = element.querySelector<HTMLElement>('[data-hunk-header]')?.offsetHeight ?? 0;
      const parts = latestParts.current;
      const revealing = reveal && reveal[0] <= reveal[1] && hiddenBetween(parts, reveal[0], reveal[1]) ? parts : undefined;
      if (revealing && reveal) latestShow.current?.({ kind: 'whole', start: reveal[0], end: reveal[1] });
      // What the jump lands on, for the "here" mark.
      let landed: HTMLElement | undefined;
      // Where the place is (`y`) and where it should be (`to`), in viewport pixels, found anew each frame: the reveal
      // and late slices move it.
      const where = (): { y: number; to: number; exact: boolean } | undefined => {
        const place = placeOfLine(latestParts.current, side, start);
        // A pinned hunk header's top: 1 px under the file header, which covers its top border.
        const top = header.getBoundingClientRect().bottom - 1;
        const under = top + barHeight;
        landed = undefined;
        if (place.kind === 'top') return { y: element.getBoundingClientRect().top, to: top + 1, exact: true };
        if (place.kind === 'gap') {
          const gapBar = element.querySelector<HTMLElement>(`[data-gap="${place.gap}"]`);
          if (!gapBar) return undefined;
          // A bar that heads a hunk pins at `top`; where it sits unpinned is its section's top.
          const section = gapBar.matches('[data-hunk-header]') ? gapBar.parentElement : null;
          landed = gapBar;
          return section
            ? { y: section.getBoundingClientRect().top, to: top, exact: true }
            : { y: gapBar.getBoundingClientRect().top, to: under, exact: true };
        }
        const block = latestBlocks.current.find((b) => b.kind === 'hunk' && b.key === place.key);
        if (block?.kind !== 'hunk' || !block.slices.length) return undefined;
        // The line is in a hunk collapsed as a quiet change: it opens, and the jump aims again once it renders.
        if (block.quiet?.hidden) {
          latestNoise.current?.show(block.blockKeys, false);
          return undefined;
        }
        const index = Math.min(block.slices.length - 1, Math.floor(place.row / HUNK_SLICE_SIZE));
        const slice = block.slices[block.slices.length > 1 ? index : 0];
        const holder = element.querySelector<HTMLElement>(`[data-slice="${CSS.escape(slice.key)}"]`);
        const line = lineElement(holder ?? element, side, place.line);
        landed = line;
        if (line) return { y: line.getBoundingClientRect().top, to: under, exact: true };
        if (!holder) return undefined;
        // Not mounted yet: mount it now, and aim at the row's estimated place meanwhile.
        setMounted((current) => (current.has(slice.key) ? current : new Set([...current, slice.key])));
        const row = block.slices.length > 1 ? place.row - index * HUNK_SLICE_SIZE : place.row;
        return { y: holder.getBoundingClientRect().top + SLICE_CHROME / 2 + row * CODE_LINE_HEIGHT, to: under, exact: false };
      };
      // Then scroll there: an eased move that aims anew each frame, so a target that moves while it runs is followed,
      // not fought. Past three screens it starts a screen short, so long jumps don't drag. Reduced motion jumps.
      const instant = matchMedia('(prefers-reduced-motion: reduce)').matches;
      let waited = 0;
      let origin: number | undefined;
      let began = 0;
      let duration = 0;
      let settling = 0;
      let still = 0;
      const step = (now: number) => {
        jumpFrame = 0;
        if (id !== jumpId) return;
        // The revealed lines render first; scroll anchoring keeps the reader's lines in place meanwhile.
        if (revealing && latestParts.current === revealing && waited++ < REVEAL_WAIT_FRAMES) {
          jumpFrame = requestAnimationFrame(step);
          return;
        }
        const at = where();
        let moving = false;
        if (at) {
          const current = scroller.scrollTop;
          const max = scroller.scrollHeight - scroller.clientHeight;
          const target = Math.max(0, Math.min(max, current + at.y - at.to));
          if (origin === undefined) {
            const screen = scroller.clientHeight;
            const distance = target - current;
            origin = Math.abs(distance) > 3 * screen ? target - Math.sign(distance) * screen : current;
            duration = instant || Math.abs(target - origin) < 1 ? 0 : jumpDuration(Math.abs(target - origin), screen);
            began = now;
          }
          const progress = duration ? Math.min(1, (now - began) / duration) : 1;
          moving = progress < 1;
          const next = moving ? origin + (target - origin) * easeOut(progress) : target;
          if (Math.abs(next - current) > 0.5) scroller.scrollTo({ top: next, behavior: 'instant' });
          // Settled: on target, or as far as the view scrolls, two frames running.
          still = !moving && at.exact && Math.abs(target - current) < 1 ? still + 1 : 0;
        }
        if (moving || (still < 2 && settling++ < MISSED_PROBES)) {
          jumpFrame = requestAnimationFrame(step);
          return;
        }
        stopJump();
        where();
        if (landed?.isConnected && section && landed.matches('[data-line]')) {
          // A definition is marked whole, in both columns of a split diff, with the gap bars inside it.
          const [first, last] = section;
          const bars = latestParts.current.flatMap((part) => {
            if (part.kind !== 'gap' || part.end === undefined) return [];
            const offset = side === 'before' ? part.gap.oldOffset : 0;
            if (part.start + offset <= first || part.end + offset >= last) return [];
            const bar = element.querySelector(`[data-gap="${part.gap.index}"]`);
            return bar ? [bar] : [];
          });
          // As many rows as fill the view twice: the rest of a long section is out of view while the mark lasts.
          const rows = Math.ceil((2 * scroller.clientHeight) / CODE_LINE_HEIGHT);
          markSection(element.querySelectorAll('diffs-container'), { side, start: first, end: last, signatureEnd: here[1] }, bars, rows);
        } else if (landed?.isConnected) {
          // A line is marked with the rest of `here` on its side, such as a definition's whole signature; a bar alone.
          const rows: HTMLElement[] = [landed];
          if (landed.matches('[data-line]'))
            for (let n = start + 1; n <= here[1] && n < start + MAX_HERE_LINES; n++) {
              const row = lineElement(element, side, n);
              if (row) rows.push(row);
            }
          markHere(rows);
        }
        onLanded?.();
      };
      for (const type of READER_SCROLLS) scroller.addEventListener(type, stopJump, { passive: true });
      step(performance.now());
    };
    // A pinned crumb goes to its definition's first line (#417): it reveals every hidden line from there down to where
    // the reader is, as Show whole function does, and nothing above it. Reveals are in new numbers. The definition's
    // signature is marked with its first line.
    const jump = (crumb: HTMLElement, keyboard: boolean) => {
      const bar = crumb.closest<HTMLElement>('[data-hunk-header]');
      const start = Number(crumb.dataset.start);
      if (!bar || !start) return;
      const side: LinePoint['side'] = crumb.dataset.side === 'before' ? 'before' : 'after';
      const [readerSide, readerLine] = (bar.getAttribute('data-live-key') ?? '').split(':');
      const parts = latestParts.current;
      const from = newLineAt(parts, side, start);
      const to = newLineAt(parts, readerSide === 'before' ? 'before' : 'after', Number(readerLine));
      goTo({
        side,
        line: start,
        reveal: from !== undefined && to !== undefined && from < to ? [from, to - 1] : undefined,
        here: [start, Math.max(start, Number(crumb.dataset.signatureEnd) || start)],
        section: [start, Math.max(start, Number(crumb.dataset.end) || start)],
        // From the keyboard, focus stays on the pinned breadcrumb, now naming where the reader landed.
        onLanded: keyboard
          ? () => {
              const slot = [...pinned].find((b) => b.isConnected && b.dataset.live === 'scope')?.querySelector<HTMLElement>('.diff-gap-live');
              if (slot && !slot.contains(document.activeElement)) focusCrumb(slot, String(start));
            }
          : undefined,
      });
    };
    const navigation: DiffNavigator = { goTo };
    own.current = navigation;
    if (navigator) navigator.current = navigation;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const more = target?.closest<HTMLElement>('.diff-gap-live button[data-more]');
      if (more && element.contains(more)) {
        openFolded(more);
        return;
      }
      const crumb = target?.closest<HTMLElement>(':is(.diff-gap-live, .diff-gap-folded) button[data-jump]');
      if (!crumb || !element.contains(crumb)) return;
      const bar = crumb.closest('[data-hunk-header]');
      const folded = !!crumb.closest('.diff-gap-folded');
      jump(crumb, event.detail === 0);
      if (folded && bar) {
        closeFolded(bar);
        // From the keyboard, focus goes back to the breadcrumb, as for a crumb that showed.
        if (event.detail === 0) bar.querySelector<HTMLElement>('.diff-gap-live [data-more]')?.focus({ preventScroll: true });
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const bar = (event.target as Element | null)?.closest('[data-hunk-header][data-folded-open]');
      if (!bar || !closeFolded(bar)) return;
      event.stopPropagation();
      bar.querySelector<HTMLElement>('.diff-gap-live [data-more]')?.focus({ preventScroll: true });
    };
    // Focus on a pinned crumb keeps the header pinned-looking: focus elsewhere in it brings back its own location and
    // its controls, which act on the hunk.
    const onFocus = (event: FocusEvent) => {
      const slot = (event.target as Element | null)?.closest('.diff-gap-live, .diff-gap-folded');
      const into = event.type === 'focusin' || (event.relatedTarget instanceof Node && !!slot?.contains(event.relatedTarget));
      slot?.closest('[data-hunk-header]')?.toggleAttribute('data-live-focus', into);
    };
    element.addEventListener('click', onClick);
    element.addEventListener('keydown', onKey);
    element.addEventListener('focusin', onFocus);
    element.addEventListener('focusout', onFocus);
    return () => {
      resize.disconnect();
      scroller.removeEventListener('scrollend', recheck);
      stuck.current?.disconnect();
      stuck.current = undefined;
      listen(false);
      follow.current = undefined;
      if (navigator?.current === navigation) navigator.current = null;
      if (own.current === navigation) own.current = null;
      stopJump();
      clearHere();
      element.removeEventListener('click', onClick);
      element.removeEventListener('keydown', onKey);
      element.removeEventListener('focusin', onFocus);
      element.removeEventListener('focusout', onFocus);
    };
  }, [stickyUnder]);
  // New rails mark the diffs already rendered.
  useEffect(() => {
    if (root.current) for (const host of root.current.querySelectorAll('diffs-container')) markRails(host, rails);
  }, [rails]);
  useEffect(() => {
    if (root.current) for (const host of root.current.querySelectorAll('diffs-container')) markLines(host, [['data-noise-line', noiseLines]]);
  }, [noiseLines]);
  useEffect(() => {
    if (root.current) for (const host of root.current.querySelectorAll('diffs-container')) markLines(host, [['data-moved-line', movedLines]]);
  }, [movedLines]);
  // New definitions name the reader's place anew.
  useEffect(() => follow.current?.(), [scopeAt]);
  // Breadcrumbs fold to fit their bar: again whenever the bars' width or their crumbs change.
  useLayoutEffect(() => {
    if (root.current) fitCrumbs(crumbLists(root.current));
  }, [blocks, scopes, structure]);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let width: number | undefined;
    const resize = new ResizeObserver((entries) => {
      const next = Math.round(entries[entries.length - 1].contentRect.width);
      if (next === width) return;
      width = next;
      fitCrumbs(crumbLists(element));
    });
    resize.observe(element);
    return () => resize.disconnect();
  }, []);
  // Revealed lines re-create bars: watch the current ones.
  useEffect(observeHeaders, [blocks, structure]);

  const name = file.name.slice(file.name.lastIndexOf('/') + 1);
  // An added or deleted file is one hunk: the file header already says where it is.
  const whole = file.status === 'added' || file.status === 'deleted';
  const content: ReactNode[] = [];
  // Each hunk is a section with its header bar first, so the header sticks only while its hunk is on screen and the
  // next hunk's header pushes it away (#395).
  let section: { key: string; children: ReactNode[] } | undefined;
  const close = () => {
    if (section)
      content.push(
        <div key={section.key} className="diff-hunk">
          {section.children}
        </div>
      );
    section = undefined;
  };
  const open = (key: string, header?: ReactNode) => {
    close();
    section = { key: `hunk-${key}`, children: header ? [header] : [] };
    return section;
  };
  let previous: 'gap' | 'hunk' | undefined;
  blocks.forEach((block, index) => {
    if (block.kind === 'gap') {
      const key = `h${block.gap.index}`;
      const next = block.below ? blocks[index + 1] : undefined;
      const bar = block.below ? (
        <GapBar
          key={`gap-${block.gap.index}`}
          part={block}
          status={status}
          onReveal={!canReveal || canReveal(block.gap) ? onReveal : undefined}
          onRetry={onRetry}
          scope={scopes?.get(key)}
          fileOnly={!!structure && changedHunks.has(key) && !scopes?.get(key)}
          fileName={name}
          note={scopeNote}
          range={next?.kind === 'hunk' && next.changed ? next.range : undefined}
          counts={next?.kind === 'hunk' && next.changed ? next.counts : undefined}
          onShowDefinition={onShowDefinition}
          plain={plainGaps}
          onCollapseScope={onCollapseScope}
          onShowElsewhere={onShowElsewhere}
        />
      ) : (
        <TrailingBar
          key={`gap-${block.gap.index}`}
          part={block}
          status={status}
          onReveal={!canReveal || canReveal(block.gap) ? onReveal : undefined}
          onRetry={onRetry}
          plain={plainGaps}
          onShowElsewhere={onShowElsewhere}
        />
      );
      // A bar below the last hunk heads nothing.
      if (block.below) open(key, bar);
      else {
        close();
        content.push(bar);
      }
      previous = 'gap';
      return;
    }
    // A hunk with no bar above it (the file's first lines, or hunks a patch leaves apart without a gap) still gets a
    // header that says where it is: once the file is parsed, its definitions or the file alone at the top level, and
    // until then, or in a language with no structure, its lines.
    let current = section;
    if (previous !== 'gap' && block.changed && (structure || !whole)) {
      const scope = structure ? scopes?.get(block.key) : undefined;
      current = open(
        block.key,
        <div
          key={`scope-${block.key}`}
          className="diff-gap"
          data-scope-line={structure ? '' : undefined}
          data-range-line={structure ? undefined : ''}
          data-hunk-header=""
        >
          <HeaderRow
            location={
              !structure ? undefined : scope ? (
                <HunkScopeLabel scope={scope} file={name} onShow={onShowDefinition} />
              ) : (
                <TopLevelLabel file={name} />
              )
            }
            controls={structure && scopeNote}
            action={structure && <ShowDefinition scope={scope} onShow={onShowDefinition} onCollapse={onCollapseScope} />}
            range={block.range}
            counts={block.counts}
            live
          />
        </div>
      );
    } else if (previous === 'hunk' && current)
      current.children.push(<div key={`between-${block.key}`} className="diff-gap" data-static="" aria-hidden="true" />);
    current ??= open(block.key);
    previous = 'hunk';
    // A hunk the reader hides as noise is one bar, unless it holds a comment or the line to show.
    if (block.quiet?.hidden && !block.slices.some((slice) => bySlice.has(slice.key) || slice.key === targetKey)) {
      current.children.push(
        <NoiseBar key={`noise-${block.key}`} quiet={block.quiet} rows={block.rows} lines={block.lines} onShow={noise && (() => noise.show(block.blockKeys))} />
      );
      return;
    }
    // A hunk's lead notes share one row: in a split diff, each in its side's column.
    const leads = leadNotes.get(block.key);
    if (leads) {
      const note = (mark: MoveMark) => (
        <MoveNote
          key={`move-${mark.side}${mark.start}`}
          mark={mark}
          words={moveWords(mark, parts)}
          lead={split && mark.side === 'after' ? 'right' : 'left'}
          onGo={mark.sameFile || openMove ? () => goToMove(mark) : undefined}
        />
      );
      // Unified: every lead note, stacked. Split: one per column.
      const left = split ? leads.filter((mark) => mark.side === 'before') : leads;
      const right = split ? leads.filter((mark) => mark.side === 'after') : [];
      current.children.push(
        <div key={`move-lead-${block.key}`} className="diff-move-lead" data-split={split || undefined}>
          {left.length ? <div>{left.map(note)}</div> : <div aria-hidden="true" />}
          {right.length > 0 && <div>{right.map(note)}</div>}
        </div>
      );
    }
    for (const slice of block.slices) {
      const diff = (
        <SliceDiff
          key={slice.key}
          slice={slice}
          options={stableOptions}
          annotations={sliceAnnotations.get(slice.key) ?? NO_ANNOTATIONS}
          renderAnnotation={stableRender}
          style={style}
        />
      );
      if (!progressive) {
        current.children.push(diff);
        continue;
      }
      const height = estimateSliceHeight(split ? slice.splitRows : slice.unifiedRows);
      const shown = mounted.has(slice.key);
      current.children.push(
        <div
          key={slice.key}
          className="changes-slice"
          data-slice={slice.key}
          data-mounted={shown || undefined}
          style={{ containIntrinsicBlockSize: `auto ${height}px`, minHeight: shown ? undefined : height }}
        >
          {shown && diff}
        </div>
      );
    }
  });
  close();
  // Every change of the file is noise the reader hides: the file is one bar under its header.
  const quietFile =
    !!noise?.fileHidden && !!noise.file && !annotations.length && !targetKey && blocks.some((block) => block.kind === 'hunk' && block.changed);
  const quietNoise = quietFile ? noise : undefined;
  if (quietNoise?.file) {
    const changes = quietNoise.file.added + quietNoise.file.deleted;
    const hunks = blocks.filter((block) => block.kind === 'hunk' && block.changed).length;
    // A whole file of layout changes across hunks reads as a formatter run: "Reformatted".
    const label = quietNoise.file.reformatted ? 'Reformatted' : noiseLabel(quietNoise.file.kinds);
    content.length = 0;
    content.push(
      <div key="noise-file" className="diff-gap" role="group" aria-label={`${label}: every change in this file`} data-trailing="" data-noise-file={label}>
        <span className="diff-gap-trailing">
          <NoiseIcon kinds={quietNoise.file.kinds} />
          <span className="diff-noise-label">{label}</span>
          <span className="diff-gap-dot" aria-hidden="true">
            ·
          </span>
          <span className="diff-gap-count">
            {hunks.toLocaleString()} {hunks === 1 ? 'change' : 'changes'}, {lines(changes)}
          </span>
          <span className="diff-gap-dot" aria-hidden="true">
            ·
          </span>
          <button
            type="button"
            className="diff-context-button diff-gap-text"
            data-noise-show=""
            title="Show every change in this file"
            onClick={() => quietNoise.show(blocks.flatMap((block) => (block.kind === 'hunk' ? block.blockKeys : [])))}
          >
            Show changes
          </button>
        </span>
      </div>
    );
  }
  return (
    <div
      ref={root}
      className="changes-diff"
      data-progressive={progressive || undefined}
      data-code-theme={codeTheme}
      data-indicators={options.diffIndicators ?? 'classic'}
      data-line-numbers={options.disableLineNumbers ? 'off' : undefined}
      style={rootStyle}
    >
      {outline && !quietFile && <DiffOutline {...outline} onGo={goToSymbol} />}
      {content}
    </div>
  );
}
