import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { FileDiff } from '@pierre/diffs/react';
import { processFile, type DiffLineAnnotation, type FileDiffOptions } from '@pierre/diffs';
import {
  GAP_STEP,
  estimateSliceHeight,
  hunkSlices,
  type DiffSlice,
  type GapDirection,
  type GapPart,
} from '../lib/diff-gaps';
import { LoadingIndicator } from './LoadingState';

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
}`;
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
    <FileDiff
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
/** Inserting a diff restyles the page: rules such as `.commit-stream-file:has(…)` and `body:has(…)` make each
 * insertion invalidate those ancestors' whole subtrees. While someone types a comment, that cost would land on
 * their keys, so background mounting waits for a pause in typing. */
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

function GapBar({
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
  const { hidden, above, below } = part;
  const known = hidden !== undefined;
  const busy = status.kind === 'loading';
  const reveal = (direction: GapDirection) => () => onReveal?.(part, direction);
  const label = known ? `${lines(hidden)} hidden` : 'More lines may follow';
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
        Show {lines(hidden)}
      </button>
    );
  else
    body = (
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
        <span className="diff-gap-count">{known ? `${lines(hidden)} hidden` : 'Unchanged lines below'}</span>
        <button type="button" className="diff-context-button diff-gap-text" onClick={reveal('all')}>
          <span className="icon-mask icon-unfold-vertical" aria-hidden="true" />
          {known ? 'Show all' : 'Show the rest'}
        </button>
      </>
    );
  return (
    <div className="diff-gap" role="group" aria-label={label} aria-busy={busy || undefined} data-gap={part.gap.index}>
      {body}
      {busy && (
        <LoadingIndicator className="diff-gap-loading" announce={false}>
          Loading lines…
        </LoadingIndicator>
      )}
    </div>
  );
}

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
}) {
  const stableOptions = useStableOptions({
    ...options,
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
      return { kind: 'hunk' as const, key: part.key, slices };
    });
    cache.current = next;
    return result;
  }, [parts, file.name, file.prevName, file.status]);
  const slices = useMemo(() => blocks.flatMap((block) => (block.kind === 'hunk' ? block.slices : [])), [blocks]);
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

  const content: ReactNode[] = [];
  let previous: 'gap' | 'hunk' | undefined;
  for (const block of blocks) {
    if (block.kind === 'gap') {
      content.push(<GapBar key={`gap-${block.gap.index}`} part={block} status={status} onReveal={onReveal} onRetry={onRetry} />);
      previous = 'gap';
      continue;
    }
    // Hunks that a patch leaves apart without a gap to reveal are still marked apart.
    if (previous === 'hunk') content.push(<div key={`between-${block.key}`} className="diff-gap" data-static="" aria-hidden="true" />);
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
        content.push(diff);
        continue;
      }
      const height = estimateSliceHeight(split ? slice.splitRows : slice.unifiedRows);
      const shown = mounted.has(slice.key);
      content.push(
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
  }
  return (
    <div ref={root} className="changes-diff" data-progressive={progressive || undefined}>
      {content}
    </div>
  );
}
