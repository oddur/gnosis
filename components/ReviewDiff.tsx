import { useSessionDraft } from '../lib/session-drafts';
import { useMemo, useState, useRef, type CSSProperties, type ReactNode } from 'react';
import type { GitHubReviewThread } from '../lib/review-threads';
import { FileDiff } from '@pierre/diffs/react';
import { bundledLanguages } from 'shiki/langs';
import { bundledThemes } from 'shiki/themes';
import { processFile, registerCustomTheme } from '@pierre/diffs';
import type { DiffLineAnnotation, FileDiffOptions } from '@pierre/diffs';
import { ChevronsUpDown } from 'lucide-react';
import { readableCodeTheme } from '@/lib/code-contrast';
import { CODE_THEMES } from '@/lib/constants';
import {
  DEFAULT_DIFF_APPEARANCE,
  prepareReviewHunk,
  reviewContextRanges,
  sliceReviewHunk,
  type DiffAppearance,
} from '@/lib/review-diff';
import type { DiffHunk, DiffSide, FileMetadata, InlineExplanation, PendingReviewComment } from '@/lib/types';
import { InlineCodeExplanation } from './InlineCodeExplanation';
import { DiffHunkGroup } from './DiffHunk';
import { InteractiveDiffHunkGroup } from './InteractiveDiffHunk';
import { SplitDiffHunkGroup } from './SplitDiffHunk';
import { CommentBubble, InlineCommentForm, extractShikiStyles, type CommentCallbacks } from './shared-diff-utils';

// Each preference keeps its syntax palette, adjusted for changed-line surfaces.
for (const { id } of CODE_THEMES) {
  registerCustomTheme(`gnosis-${id}`, async () => {
    const { default: theme } = await bundledThemes[id]();
    return readableCodeTheme(theme, `gnosis-${id}`);
  });
}

type Location = { line: number; side: DiffSide };
interface Props {
  filePath: string;
  hunks: DiffHunk[];
  pinnedLines?: number[];
  fileStatus?: FileMetadata['status'];
  diffLayout: 'split' | 'unified';
  appearance?: DiffAppearance;
  pendingComments?: PendingReviewComment[];
  slideIndex: number;
  commentCallbacks?: CommentCallbacks;
  threads?: GitHubReviewThread[];
  inlineExplanations?: InlineExplanation[];
  renderThread?: (thread: GitHubReviewThread) => ReactNode;
}

const shadowCSS = `
:host {
  --diffs-bg-context-override: var(--diffs-bg);
  --diffs-bg-context-gutter-override: var(--diffs-bg);
  --diffs-fg-number-override: var(--diffs-fg);
  --diffs-bg-addition-number-override: var(--diffs-bg-addition-override);
  --diffs-bg-deletion-number-override: var(--diffs-bg-deletion-override);
  --diffs-bg-addition-override: color-mix(in srgb, var(--diffs-bg) 90%, #5ecc71);
  --diffs-bg-deletion-override: color-mix(in srgb, var(--diffs-bg) 90%, #ff6762);
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--diffs-bg) 80%, #5ecc71);
  --diffs-bg-deletion-emphasis-override: color-mix(in srgb, var(--diffs-bg) 80%, #ff6762);
}

[data-line] { scroll-margin-block: 4rem; }
.check-highlight { animation: check-flash 1.6s ease-out; }
@keyframes check-flash { from { outline: 2px solid var(--ring); } to { background-color: transparent; } }
@media (prefers-reduced-motion: reduce) { .check-highlight { animation: none; outline: 2px solid var(--ring); } }
::selection { background: var(--accent); color: var(--accent-foreground); }
`;

function ReviewHunk({
  hunk,
  sourceHeader,
  ...props
}: Omit<Props, 'hunks'> & { hunk: DiffHunk; sourceHeader?: string }) {
  const {
    filePath,
    fileStatus,
    diffLayout,
    slideIndex,
    commentCallbacks,
    pendingComments = [],
    threads = [],
    inlineExplanations = [],
    renderThread,
    appearance = DEFAULT_DIFF_APPEARANCE,
  } = props;
  const prepared = useMemo(() => {
    const data = prepareReviewHunk(hunk, fileStatus);
    if (!data) return null;
    try {
      const file = processFile(data.patch, { throwOnError: true });
      if (!file) return null;
      file.name = filePath;
      if (hunk.language in bundledLanguages) file.lang = hunk.language as keyof typeof bundledLanguages;
      return { ...data, file };
    } catch {
      return null;
    }
  }, [hunk, fileStatus, filePath]);
  const lineMaps = useMemo(
    () => ({
      old: new Map(prepared?.lines.filter((l) => l.baseLineNumber != null).map((l) => [l.baseLineNumber, l])),
      head: new Map(prepared?.lines.filter((l) => l.headLineNumber != null).map((l) => [l.headLineNumber, l])),
    }),
    [prepared]
  );
  const [active, setActive] = useSessionDraft<Location | null>(`comment-location:${slideIndex}:${filePath}:${hunk.hunkHeader}`, null);
  const theme = useMemo(() => {
    const classes = extractShikiStyles(hunk.renderedHtml).preClass.split(' ');
    return CODE_THEMES.find((t) => classes.includes(t.id))?.id ?? 'aurora-x';
  }, [hunk.renderedHtml]);
  const options = useMemo<FileDiffOptions<Location, undefined>>(
    () => ({
      theme: `gnosis-${theme}`,
      themeType: 'dark',
      diffStyle: prepared?.singleSide ? 'unified' : diffLayout,
      disableFileHeader: true,
      hunkSeparators: sourceHeader ? 'simple' : 'metadata',
      diffIndicators: appearance.indicators,
      disableBackground: !appearance.backgrounds,
      disableLineNumbers: !appearance.lineNumbers,
      overflow: appearance.wrap ? 'wrap' : 'scroll',
      lineDiffType: appearance.inline,
      unsafeCSS: shadowCSS,
      enableGutterUtility: !!commentCallbacks,
      onGutterUtilityClick: commentCallbacks
        ? (range) => setActive({ line: range.start, side: range.side === 'deletions' ? 'LEFT' : 'RIGHT' })
        : undefined,
      onLineNumberClick: commentCallbacks
        ? (event) =>
            setActive({ line: event.lineNumber, side: event.annotationSide === 'deletions' ? 'LEFT' : 'RIGHT' })
        : undefined,
      onPostRender(node) {
        for (const el of node.shadowRoot?.querySelectorAll<HTMLElement>('[data-code] [data-line]') ?? []) {
          const old = !!el.closest('[data-deletions]') || el.dataset.lineType === 'change-deletion';
          const n = Number(el.dataset.line);
          const info = (old ? lineMaps.old : lineMaps.head).get(n);
          el.dataset.filePath = filePath;
          delete el.dataset.lineNumber;
          delete el.dataset.baseLine;
          if (info?.headLineNumber != null && !old) el.dataset.lineNumber = String(info.headLineNumber);
          if (info?.baseLineNumber != null && (old || diffLayout === 'unified'))
            el.dataset.baseLine = String(info.baseLineNumber);
        }
      },
    }),
    [theme, prepared, diffLayout, appearance, commentCallbacks, filePath, lineMaps, sourceHeader]
  );
  const annotations = useMemo<DiffLineAnnotation<Location>[]>(() => {
    const locations = [
      ...pendingComments.filter((c) => c.filePath === filePath),
      ...(active ? [active] : []),
      ...threads.flatMap((t) => (t.line == null ? [] : [{ line: t.line, side: t.diffSide }])),
      ...inlineExplanations,
    ];
    const seen = new Set<string>();
    return locations.flatMap((location) => {
      const key = `${location.side}:${location.line}`;
      if (
        seen.has(key) ||
        !prepared?.lines.some((l) => (location.side === 'LEFT' ? l.baseLineNumber : l.headLineNumber) === location.line)
      )
        return [];
      seen.add(key);
      return [
        { lineNumber: location.line, side: location.side === 'LEFT' ? 'deletions' : 'additions', metadata: location },
      ];
    });
  }, [pendingComments, filePath, active, prepared, threads, inlineExplanations]);
  if (!prepared) {
    if (diffLayout === 'split') return <SplitDiffHunkGroup {...props} hunks={[hunk]} showFileHeader={false} />;
    if (commentCallbacks)
      return (
        <InteractiveDiffHunkGroup
          {...props}
          {...commentCallbacks}
          pendingComments={pendingComments}
          hunks={[hunk]}
          showFileHeader={false}
        />
      );
    return <DiffHunkGroup filePath={filePath} hunks={[hunk]} showFileHeader={false} />;
  }
  return (
    <FileDiff
      fileDiff={prepared.file}
      options={options}
      lineAnnotations={annotations}
      style={
        {
          '--diffs-font-family': 'var(--font-mono)',
          '--diffs-font-size': 'var(--type-code)',
          '--diffs-line-height': 'var(--leading-code)',
        } as CSSProperties
      }
      renderAnnotation={({ metadata: location }) => (
        <div className="font-sans text-foreground text-sm">
          {inlineExplanations
            .filter((note) => note.line === location.line && note.side === location.side)
            .map((note) => (
              <InlineCodeExplanation key={`${note.side}:${note.line}:${note.text}`} explanation={note} />
            ))}
          {commentCallbacks && active?.line === location.line && active.side === location.side && (
            <InlineCommentForm
              draftKey={`${filePath}:${slideIndex}:${location.side}:${location.line}`}
              onCancel={() => setActive(null)}
              onSubmit={(body) => {
                const info = prepared.lines.find(
                  (l) => (location.side === 'LEFT' ? l.baseLineNumber : l.headLineNumber) === location.line
                );
                commentCallbacks.onAddComment({
                  filePath,
                  ...location,
                  body,
                  slideIndex,
                  hunkHeader: sourceHeader ?? hunk.hunkHeader,
                  codeSnippet: info?.text ?? '',
                });
                setActive(null);
              }}
            />
          )}
          {commentCallbacks &&
            pendingComments
              .filter((c) => c.filePath === filePath && c.line === location.line && c.side === location.side)
              .map((c) => (
                <CommentBubble
                  key={c.id}
                  comment={c}
                  onEdit={commentCallbacks.onEditComment}
                  onRemove={commentCallbacks.onRemoveComment}
                />
              ))}
          {threads
            .filter((t) => t.line === location.line && t.diffSide === location.side)
            .map((t) => renderThread?.(t))}
        </div>
      )}
    />
  );
}

function FoldableReviewHunk({ hunk, ...props }: Omit<Props, 'hunks'> & { hunk: DiffHunk }) {
  const prepared = useMemo(() => prepareReviewHunk(hunk, props.fileStatus), [hunk, props.fileStatus]);
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  const [draftNotice, setDraftNotice] = useState(false);
  function changeContext(change: () => void) {
    const draft = rootRef.current?.querySelector('textarea');
    if (draft) {
      setDraftNotice(true);
      draft.focus();
      return;
    }
    setDraftNotice(false);
    change();
  }
  const pinned = useMemo(() => {
    const result = new Set<number>();
    prepared?.lines.forEach((line, index) => {
      if (
        props.pinnedLines?.some((n) => line.headLineNumber === n || line.baseLineNumber === n) ||
        props.threads?.some((t) => (t.diffSide === 'LEFT' ? line.baseLineNumber : line.headLineNumber) === t.line) ||
        props.inlineExplanations?.some(
          (note) => (note.side === 'LEFT' ? line.baseLineNumber : line.headLineNumber) === note.line
        ) ||
        props.pendingComments?.some(
          (c) =>
            c.filePath === props.filePath && (c.side === 'LEFT' ? line.baseLineNumber : line.headLineNumber) === c.line
        )
      )
        result.add(index);
    });
    return result;
  }, [prepared, props.pinnedLines, props.pendingComments, props.filePath, props.threads, props.inlineExplanations]);
  const ranges = useMemo(
    () => (prepared ? reviewContextRanges(prepared.lines, pinned, revealed) : []),
    [prepared, pinned, revealed]
  );
  // New/deleted files contain changes on every line; never fold their content.
  if (!prepared || prepared.singleSide || (!ranges.some((range) => range.hidden) && !revealed.size)) {
    return <ReviewHunk hunk={hunk} {...props} />;
  }
  return (
    <div ref={rootRef} className="review-context-hunk">
      {draftNotice && (
        <p className="px-3 py-2 text-xs text-muted-foreground" role="status">
          Finish or cancel your comment before changing the visible context.
        </p>
      )}
      {revealed.size > 0 && (
        <div className="flex justify-end border-b bg-muted/30 px-3 py-1">
          <button
            className="review-context-action text-xs underline underline-offset-2"
            onClick={() => changeContext(() => setRevealed(new Set()))}
          >
            Hide extra context
          </button>
        </div>
      )}
      {ranges.map((range) => {
        if (!range.hidden)
          return (
            <ReviewHunk
              key={`code-${range.start}`}
              {...props}
              hunk={sliceReviewHunk(hunk, prepared.lines, range.start, range.end)}
              sourceHeader={hunk.hunkHeader}
            />
          );
        const count = range.end - range.start;
        const reveal = (all: boolean) =>
          setRevealed((current) => {
            const next = new Set(current);
            const amount = all ? count : Math.min(count, 10);
            // Reveal nearest the change: upwards above it, downwards below it,
            // and from both ends when the hidden region lies between changes.
            for (let i = 0; i < amount; i++) {
              const index =
                range.start === 0
                  ? range.end - 1 - i
                  : range.end === prepared.lines.length
                    ? range.start + i
                    : i % 2 === 0
                      ? range.start + Math.floor(i / 2)
                      : range.end - 1 - Math.floor(i / 2);
              next.add(index);
            }
            return next;
          });
        return (
          <div
            key={`gap-${range.start}`}
            className="diff-context-gap flex flex-wrap items-center gap-x-3 gap-y-1 border-y bg-muted/40 px-3 py-1.5 text-xs"
          >
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="text-muted-foreground">
              {count} unchanged {count === 1 ? 'line' : 'lines'} hidden
            </span>
            <button
              className="review-context-action underline underline-offset-2"
              onClick={() => changeContext(() => reveal(false))}
            >
              Show {Math.min(count, 10)} more {Math.min(count, 10) === 1 ? 'line' : 'lines'}
            </button>
            {count > 10 && (
              <button
                className="review-context-action underline underline-offset-2"
                onClick={() => changeContext(() => reveal(true))}
              >
                Show all {count} lines
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ReviewDiff({ hunks, ...props }: Props) {
  const annotationsByHunk = useMemo(() => {
    const owners = new Map<string, number>();
    hunks.forEach((hunk, index) => {
      for (const line of prepareReviewHunk(hunk, props.fileStatus)?.lines ?? []) {
        for (const [side, number] of [
          ['LEFT', line.baseLineNumber],
          ['RIGHT', line.headLineNumber],
        ] as const) {
          const key = `${side}:${number}`;
          if (number != null && !owners.has(key)) owners.set(key, index);
        }
      }
    });
    const result = hunks.map(() => ({ threads: [] as GitHubReviewThread[], explanations: [] as InlineExplanation[] }));
    for (const thread of props.threads ?? []) {
      const owner = owners.get(`${thread.diffSide}:${thread.line}`);
      if (owner !== undefined) result[owner].threads.push(thread);
    }
    for (const note of props.inlineExplanations ?? []) {
      if (note.filePath !== props.filePath) continue;
      const owner = owners.get(`${note.side}:${note.line}`);
      if (owner !== undefined) result[owner].explanations.push(note);
    }
    return result;
  }, [hunks, props.fileStatus, props.filePath, props.threads, props.inlineExplanations]);
  return (
    <div className="review-diff select-text min-w-0 overflow-hidden rounded-md border">
      {hunks.map((hunk, i) => (
        <FoldableReviewHunk
          key={`${props.slideIndex}:${i}:${hunk.hunkHeader}`}
          hunk={hunk}
          {...props}
          threads={annotationsByHunk[i].threads}
          inlineExplanations={annotationsByHunk[i].explanations}
        />
      ))}
    </div>
  );
}

/** Keep the renderer's shadow DOM boundary out of review navigation. */
export function findReviewLine(container: HTMLElement, filePath: string, line: number, side?: DiffSide): HTMLElement | null {
  const roots: (HTMLElement | ShadowRoot)[] = [
    container,
    ...Array.from(container.querySelectorAll('diffs-container')).flatMap((el) =>
      el.shadowRoot ? [el.shadowRoot] : []
    ),
  ];
  for (const attr of side==='LEFT'?['data-base-line']:side==='RIGHT'?['data-line-number']:['data-line-number', 'data-base-line']) {
    for (const root of roots) {
      const result = root.querySelector<HTMLElement>(`[data-file-path="${CSS.escape(filePath)}"][${attr}="${line}"]`);
      if (result) return result;
    }
  }
  return null;
}

export function reviewCodeSelection(container: HTMLElement) {
  for (const host of container.querySelectorAll('diffs-container')) {
    const root = host.shadowRoot as (ShadowRoot & { getSelection?: () => Selection | null }) | null;
    const selection = root?.getSelection?.();
    if (selection && !selection.isCollapsed && selection.rangeCount) return selection;
  }
  return window.getSelection();
}
