import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { processFile, type DiffLineAnnotation, type FileDiffOptions } from '@pierre/diffs';
import {
  GAP_STEP,
  estimateSliceHeight,
  hunkSlices,
  type DiffSlice,
  hunkCounts,
  hunkRange,
  type GapDirection,
  type GapPart,
  type HunkCounts,
  type HunkRange,
} from '../lib/diff-gaps';
import { applyCodePalette } from '../lib/diff-code-palette';
import { LoadingIndicator } from './LoadingState';
import { KeptFileDiff } from './KeptFileDiff';
import { FLAT_TOKEN_CSS, FLAT_TOKENS } from '../lib/diff-token-flatten';
import { revealLabel, spokenChain, type HunkScope, type LinePoint } from '../lib/hunk-scopes';
import { definitionLines, type DefinitionReveal, type SyntaxDefinition } from '../lib/syntax-scope';

type GapBarPart = Extract<GapPart, { kind: 'gap' }>;
export type GapStatus =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  /** The after text no longer matches the patch. */
  | { kind: 'stale' };

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
${FLAT_TOKEN_CSS}`;
const NO_ANNOTATIONS: never[] = [];
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

/** "Show whole function": the innermost definition, among the bar's controls on the right. */
function ShowDefinition({ scope, onShow }: { scope?: HunkScope; onShow?: (reveal: DefinitionReveal) => void }) {
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
 * `-live` slots, which sit over the hunk's own in the same grid cell, so the swap never changes the bar's size. They are
 * hidden from screen readers, which keep the hunk's own location; nothing is announced as the reader scrolls.
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
        {live && <span className="diff-gap-live" aria-hidden="true" />}
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
 * holds and the action at the code's text column ("82 more lines · Show"). It heads nothing, so it never pins.
 */
function TrailingBar({
  part,
  status,
  onReveal,
  onRetry,
}: {
  part: GapBarPart;
  status: GapStatus;
  onReveal?: (part: GapBarPart, direction: GapDirection) => void;
  onRetry?: () => void;
}) {
  const { hidden } = part;
  const known = hidden !== undefined;
  const busy = status.kind === 'loading';
  const label = known ? `${lines(hidden)} hidden` : 'More lines may follow';
  const more = known ? `${hidden.toLocaleString()} more ${hidden === 1 ? 'line' : 'lines'}` : 'More lines may follow';
  let body: ReactNode;
  if (onReveal && (status.kind === 'stale' || status.kind === 'error'))
    body = gapControls(part, status, () => () => {}, onRetry).body;
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
        {busy && (
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
}: {
  part: GapBarPart;
  status: GapStatus;
  onReveal?: (part: GapBarPart, direction: GapDirection) => void;
  onRetry?: () => void;
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
}) {
  const { hidden } = part;
  const known = hidden !== undefined;
  const busy = status.kind === 'loading';
  const reveal = (direction: GapDirection) => () => onReveal?.(part, direction);
  // A topic that leaves out changes between its hunks says so: those lines are not the after side's alone.
  const label = part.gap.opaque ? OPAQUE : known ? `${lines(hidden)} hidden` : 'More lines may follow';
  const { gutter, body } = onReveal
    ? gapControls(part, status, reveal, onRetry)
    : {
        gutter: undefined,
        body: <span className="diff-gap-count">{part.gap.opaque ? OPAQUE : known ? `${lines(hidden)} hidden` : null}</span>,
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
            {busy && (
              <LoadingIndicator className="diff-gap-loading" announce={false}>
                Loading lines…
              </LoadingIndicator>
            )}
          </>
        }
        range={range}
        counts={counts}
        live
        action={<ShowDefinition scope={scope} onShow={onShowDefinition} />}
      />
    </div>
  );
}

/**
 * The element a file's diff scrolls in: Changes' stream, or an Explanation topic's code pane or document, which mark
 * themselves `data-diff-scroller`. File and hunk headers stick to its top.
 */
export const DIFF_SCROLLER = '.commit-diff-stream, [data-diff-scroller]';

/** A probe that finds no line (a slice still mounting, a comment) looks again on this many following frames. */
const MISSED_PROBES = 30;

/**
 * Names where the reader is in a pinned header (`bar`): the definitions around the code line just below it, and that
 * line. One hit test finds the line, inside the diff's shadow root; the slots are rewritten only when the place
 * changes. A deleted line is named by the old file's definitions and its old number.
 */
function followReader(
  bar: HTMLElement,
  scopeAt: ((point: LinePoint) => readonly SyntaxDefinition[] | undefined) | undefined
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
  const scopeKey = chain ? chain.map((d) => d.start).join(',') : before && previous !== undefined ? previous : '-';
  const key = `${point.side}:${number}:${scopeKey}`;
  if (bar.getAttribute('data-live-key') === key) return true;
  bar.setAttribute('data-live-key', key);
  const lineSlot = bar.querySelector('.diff-gap-live-line');
  if (lineSlot) lineSlot.textContent = before ? `old L${number}` : `L${number}`;
  const slot = bar.querySelector('.diff-gap-live');
  if (slot && chain && previous !== scopeKey) {
    slot.replaceChildren(...liveCrumbs(chain));
    fitCrumbs([slot as HTMLElement]);
  }
  if (chain || scopeKey === '-') bar.setAttribute('data-live', chain ? 'scope' : 'line');
  return true;
}

/** A chain as the breadcrumb shows it, as plain elements: the innermost two crumbs, "…" before, or "top level". */
function liveCrumbs(chain: readonly SyntaxDefinition[]): Node[] {
  const make = (tag: string, className: string, text?: string) => {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  if (!chain.length) {
    const top = make('span', 'diff-gap-crumb', 'top level');
    top.setAttribute('data-top-level', '');
    return [top];
  }
  const shown: readonly (SyntaxDefinition | 'more')[] = chain;
  const groups = shown.map((definition, index) => {
    const group = make('span', 'diff-gap-crumb-group');
    if (index > 0) group.append(make('span', 'diff-gap-crumb-separator', '›'));
    const crumb = make('span', 'diff-gap-crumb');
    if (definition === 'more') crumb.textContent = '…';
    else {
      const code = make('code', '');
      const keyword = definition.crumbKeyword;
      if (keyword && definition.crumb.startsWith(`${keyword} `))
        code.append(make('span', 'diff-gap-kind', keyword), ` ${definition.crumb.slice(keyword.length + 1)}`);
      else code.textContent = definition.crumb;
      crumb.append(code);
      if (index === shown.length - 1) {
        crumb.setAttribute('data-innermost', '');
        group.setAttribute('data-last', '');
      }
    }
    group.append(crumb);
    return group;
  });
  if (chain.length < 2) return groups;
  const more = make('span', 'diff-gap-more', '…');
  return [more, ...groups];
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
}) {
  const stableOptions = useStableOptions({
    ...options,
    // One text node per line (lib/diff-token-flatten.ts).
    ...({ [FLAT_TOKENS]: true } as object),
    hunkSeparators: 'simple',
    unsafeCSS: options.unsafeCSS ? `${options.unsafeCSS}\n${CHANGES_CSS}` : CHANGES_CSS,
  });
  const latestRender = useRef(renderAnnotation);
  latestRender.current = renderAnnotation;
  const [stableRender] = useState(() => (annotation: DiffLineAnnotation<A>) => latestRender.current(annotation));
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
      };
    });
    cache.current = next;
    return result;
  }, [parts, file.name, file.prevName, file.status]);
  const slices = useMemo(() => blocks.flatMap((block) => (block.kind === 'hunk' ? block.slices : [])), [blocks]);
  // Hunks with a change: pinned context (a definition's signature) is not a location of its own.
  const changedHunks = useMemo(() => new Set(blocks.flatMap((block) => (block.kind === 'hunk' && block.changed ? [block.key] : []))), [blocks]);
  const progressive = slices.length > MANY_DIFFS || (slices.length > 1 && slices.some((slice) => slice.key.includes(':')));
  const split = layout === 'split' && file.status !== 'added' && file.status !== 'deleted';
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
  const follow = useRef<() => void>(undefined);
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
        else if (!followReader(bar, latestScopeAt.current)) missed = true;
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
            const stuckNow = entry.isIntersecting && entry.intersectionRatio < 1 && entry.boundingClientRect.top < top;
            entry.target.toggleAttribute('data-stuck', stuckNow);
            if (stuckNow) pinned.add(entry.target as HTMLElement);
            else pinned.delete(entry.target as HTMLElement);
          }
          for (const bar of pinned) if (!bar.isConnected) pinned.delete(bar);
          listen(pinned.size > 0);
          if (pinned.size) schedule();
        },
        { root: scroller, rootMargin: `-${next}px 0px 0px 0px`, threshold: [0, 1] }
      );
      observeHeaders();
    });
    resize.observe(header);
    return () => {
      resize.disconnect();
      stuck.current?.disconnect();
      stuck.current = undefined;
      listen(false);
      follow.current = undefined;
    };
  }, [stickyUnder]);
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
        />
      ) : (
        <TrailingBar
          key={`gap-${block.gap.index}`}
          part={block}
          status={status}
          onReveal={!canReveal || canReveal(block.gap) ? onReveal : undefined}
          onRetry={onRetry}
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
            action={structure && <ShowDefinition scope={scope} onShow={onShowDefinition} />}
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
    for (const slice of block.slices) {
      const diff = (
        <SliceDiff
          key={slice.key}
          slice={slice}
          options={stableOptions}
          annotations={bySlice.get(slice.key) ?? NO_ANNOTATIONS}
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
      {content}
    </div>
  );
}
