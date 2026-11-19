import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { processFile, type DiffLineAnnotation, type FileDiffOptions } from '@pierre/diffs';
import {
  GAP_STEP,
  estimateSliceHeight,
  hunkSlices,
  type DiffSlice,
  hunkChange,
  hunkRange,
  type GapDirection,
  type GapPart,
  type HunkChange,
  type HunkRange,
} from '../lib/diff-gaps';
import { applyCodePalette } from '../lib/diff-code-palette';
import { LoadingIndicator } from './LoadingState';
import { KeptFileDiff } from './KeptFileDiff';
import { FLAT_TOKEN_CSS, FLAT_TOKENS } from '../lib/diff-token-flatten';
import { revealLabel, spokenChain, visibleCrumbs, type HunkScope } from '../lib/hunk-scopes';
import { definitionLines, type DefinitionReveal } from '../lib/syntax-scope';

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

/**
 * Hunk header design review: `?hunk-header=a|b|c` picks a variant of the header's surface, A by default. Only the
 * fixture sets it; delete with the variants that lose.
 */
const HUNK_HEADER_STYLE = (() => {
  try {
    const value = new URLSearchParams(typeof location === 'undefined' ? '' : location.search).get('hunk-header');
    return value === 'b' || value === 'c' ? value : 'a';
  } catch {
    return 'a';
  }
})();

/** A crumb's text: its kind word, tinted as the syntax theme tints keywords, then its name. */
function CrumbText({ crumb, keyword }: { crumb: string; keyword?: string }) {
  if (!keyword || !crumb.startsWith(`${keyword} `)) return <code>{crumb}</code>;
  return (
    <code>
      <span className="diff-gap-kind">{keyword}</span> {crumb.slice(keyword.length + 1)}
    </code>
  );
}

/**
 * Where the hunk below a bar is (#393): a breadcrumb of the file and every definition around the hunk, such as
 * `store.rs › impl StoreBridge › fn save`. A long chain keeps the file and the innermost two crumbs, with "…" for the
 * middle; the whole chain is the tooltip and the accessible label. Each crumb whose definition is not all on screen
 * reveals it: whole up to the cap, else its signature. The breadcrumb starts at the code's text column, in the code's
 * type, so a provisional crumb resolves in place.
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
  const crumbs = visibleCrumbs(scope.chain);
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
      <span className="diff-gap-symbol" role="group" aria-label={spoken} title={spoken}>
        <span className="diff-gap-crumb" data-crumb-file="" data-innermost={!scope.chain.length || undefined}>
          {file}
        </span>
        {crumbs.map((crumb, index) => {
          if (crumb === 'more')
            return (
              <span key="more" className="diff-gap-crumb-group">
                {separator}
                <span className="diff-gap-crumb" aria-hidden="true">
                  …
                </span>
              </span>
            );
          const last = crumb === innermost;
          const text = (
            <CrumbText crumb={crumb.definition.crumb} keyword={crumb.provisional ? undefined : crumb.definition.crumbKeyword} />
          );
          const { reveal } = crumb;
          return (
            <span key={index} className="diff-gap-crumb-group" data-last={last || undefined}>
              {separator}
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
          : undefined
      }
      onClick={() => scope.reveal && onShow(scope.reveal)}
    >
      <span className="icon-mask icon-unfold-vertical" aria-hidden="true" />
      <span className="diff-gap-label">{revealLabel(scope)}</span>
    </button>
  );
}

/**
 * The file as the whole location, for a hunk outside every definition (imports, top-level statements). Shown only once
 * the file is parsed, so a lone file name always means "top level", never "not known yet".
 */
function FileScopeLabel({ file }: { file: string }) {
  return (
    <span className="diff-gap-scope" data-scope-kind="file">
      <span className="diff-gap-symbol" role="group" aria-label={`In ${file}, outside any definition`} title={`${file}, outside any definition`}>
        <span className="diff-gap-crumb" data-crumb-file="" data-innermost="">
          {file}
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

/**
 * A hunk header's or gap bar's contents, in DOM order as on screen: the expand chevrons in the line-number gutter, the
 * breadcrumb from the code's text column, the bar's other controls, and the hunk's lines at the end.
 */
function HeaderRow({
  gutter,
  location,
  controls,
  range,
}: {
  gutter?: ReactNode;
  location?: ReactNode;
  controls?: ReactNode;
  range?: HunkRange;
}) {
  return (
    <>
      <span className="diff-gap-gutter">{gutter}</span>
      {location}
      {/* Hidden, not removed, while the bar is pinned, so pinning never changes its height. */}
      <span className="diff-gap-controls">{controls}</span>
      {range && <RangeLabel range={range} />}
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
  change,
  header,
  onShowDefinition,
}: {
  part: GapBarPart;
  status: GapStatus;
  onReveal?: (part: GapBarPart, direction: GapDirection) => void;
  onRetry?: () => void;
  scope?: HunkScope;
  /** The hunk below sits outside every definition of a parsed file: the file alone is its location. */
  fileOnly?: boolean;
  /** The file's name, the breadcrumb's first crumb. */
  fileName?: string;
  /** Beside the location: the structure is loading, or failed to load. */
  note?: ReactNode;
  /** The hunk below's lines. */
  range?: HunkRange;
  /** What the hunk below changes: the colour of the rule on the bar's edge. */
  change?: HunkChange;
  /** The bar heads the hunk below and sticks while the hunk is on screen (#395). */
  header?: boolean;
  onShowDefinition?: (reveal: DefinitionReveal) => void;
}) {
  const { hidden, above, below } = part;
  const known = hidden !== undefined;
  const busy = status.kind === 'loading';
  const reveal = (direction: GapDirection) => () => onReveal?.(part, direction);
  const label = known ? `${lines(hidden)} hidden` : 'More lines may follow';
  let gutter: ReactNode = null;
  let body: ReactNode;
  if (!onReveal) body = <span className="diff-gap-count">{known ? `${lines(hidden)} hidden` : null}</span>;
  else if (status.kind === 'stale')
    body = (
      <span className="diff-gap-message" role="status">
        This file changed on GitHub after the diff loaded. Refresh the PR to show more lines.
      </span>
    );
  else if (status.kind === 'error')
    body = (
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
    );
  else if (known && hidden <= GAP_STEP)
    body = (
      <button type="button" className="diff-context-button diff-gap-text" onClick={reveal('all')}>
        <span className="icon-mask icon-unfold-vertical" aria-hidden="true" />
        <span className="diff-gap-label">Show {lines(hidden)}</span>
      </button>
    );
  else {
    gutter = (
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
    );
    body = (
      <>
        <span className="diff-gap-count">{known ? `${lines(hidden)} hidden` : 'Unchanged lines below'}</span>
        <button type="button" className="diff-context-button diff-gap-text" onClick={reveal('all')}>
          <span className="icon-mask icon-unfold-vertical" aria-hidden="true" />
          <span className="diff-gap-label">{known ? 'Show all' : 'Show the rest'}</span>
        </button>
      </>
    );
  }
  const located = !!scope || (!!fileOnly && !!fileName);
  return (
    <div
      className="diff-gap"
      role="group"
      aria-label={label}
      aria-busy={busy || undefined}
      data-gap={part.gap.index}
      data-hunk-header={header || undefined}
      data-change={header ? change : undefined}
    >
      <HeaderRow
        gutter={gutter}
        location={
          scope ? (
            <HunkScopeLabel scope={scope} file={fileName ?? ''} onShow={onShowDefinition} />
          ) : fileOnly && fileName ? (
            <FileScopeLabel file={fileName} />
          ) : undefined
        }
        controls={
          <>
            {body}
            <ShowDefinition scope={scope} onShow={onShowDefinition} />
            {located && note}
            {busy && (
              <LoadingIndicator className="diff-gap-loading" announce={false}>
                Loading lines…
              </LoadingIndicator>
            )}
          </>
        }
        range={range}
      />
    </div>
  );
}

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
        change: hunkChange(hunk),
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
  const observeHeaders = () => {
    const observer = stuck.current;
    if (!observer || !root.current) return;
    observer.disconnect();
    for (const header of root.current.querySelectorAll('[data-hunk-header]')) observer.observe(header);
  };
  useEffect(() => {
    const element = root.current;
    const header = stickyUnder?.current;
    const scroller = element?.closest<HTMLElement>('.commit-diff-stream');
    if (!element || !header || !scroller) return;
    let height: number | undefined;
    let written = headerHeight;
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
            const pinned = entry.isIntersecting && entry.intersectionRatio < 1 && entry.boundingClientRect.top < top;
            entry.target.toggleAttribute('data-stuck', pinned);
          }
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
    };
  }, [stickyUnder]);
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
      const bar = (
        <GapBar
          key={`gap-${block.gap.index}`}
          part={block}
          status={status}
          onReveal={onReveal}
          onRetry={onRetry}
          scope={block.below ? scopes?.get(key) : undefined}
          fileOnly={!!structure && block.below && changedHunks.has(key) && !scopes?.get(key)}
          fileName={name}
          note={scopeNote}
          range={next?.kind === 'hunk' && next.changed ? next.range : undefined}
          change={next?.kind === 'hunk' ? next.change : undefined}
          header={block.below}
          onShowDefinition={onShowDefinition}
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
          data-change={block.change}
        >
          <HeaderRow
            location={
              !structure ? undefined : scope ? (
                <HunkScopeLabel scope={scope} file={name} onShow={onShowDefinition} />
              ) : (
                <FileScopeLabel file={name} />
              )
            }
            controls={
              structure && (
                <>
                  <ShowDefinition scope={scope} onShow={onShowDefinition} />
                  {scopeNote}
                </>
              )
            }
            range={block.range}
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
      data-hunk-header-style={HUNK_HEADER_STYLE}
      style={rootStyle}
    >
      {content}
    </div>
  );
}
