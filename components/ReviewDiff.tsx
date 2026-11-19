import type { MarkdownLocation } from '../lib/markdown-review';
import { useSessionDraft } from '../lib/session-drafts';
import { useMemo, useRef, type ReactNode, type RefObject } from 'react';
import type { GitHubReviewThread } from '../lib/review-threads';
import type { DiffLineAnnotation, FileDiffOptions } from '@pierre/diffs';
import { DIFF_HIGHLIGHTER } from '@/lib/diff-highlighter';
import { CODE_THEMES } from '@/lib/constants';
import { DEFAULT_DIFF_APPEARANCE, diffContextLines, prepareReviewHunk, type DiffAppearance } from '@/lib/review-diff';
import { reviewGapHunks, type ReviewPin } from '@/lib/review-gap-hunks';
import { fileRevisionKey, type PrChangeFile, type PrChanges, type PrFileRequest } from '@/lib/pr-changes';
import { currentCodeIntelligence } from '@/lib/use-syntax-contents';
import { LFS_VERSION } from '@/lib/git-lfs';
import type { DiffHunk, DiffSide, FileMetadata, InlineExplanation, PendingReviewComment } from '@/lib/types';
import { InlineCodeExplanation } from './InlineCodeExplanation';
import { ChangesDiff } from './ChangesDiff';
import { useDiffFileModel } from './useDiffFileModel';
import { CommentBubble, InlineCommentForm, extractShikiStyles, type CommentCallbacks } from './shared-diff-utils';

type Location = { line: number; side: DiffSide };

/** Where a topic's file is on GitHub, so its gaps and structure read the same after side as Changes. */
export interface ReviewDiffSource {
  url: string;
  /** The file's path in its PR: a stack topic's paths carry their PR as a prefix. */
  path: string;
  previousPath?: string;
  baseSha: string;
  headSha: string;
}

interface Props {
  sourceLocation?: MarkdownLocation;
  onSourceLocationShown?: () => void;
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
  /** The PR revision the topic was written against; without it, gaps reveal only lines the topic saved. */
  source?: ReviewDiffSource;
  /** The file's header: hunk headers pin right below it, as in Changes. */
  stickyUnder?: RefObject<HTMLElement | null>;
  /** The file is expanded: collapsed files read nothing. */
  active?: boolean;
}

/** The Pierre theme a topic's code was highlighted in, from its saved HTML: the file header and bars take its palette. */
export function reviewDiffTheme(hunks: readonly DiffHunk[]): string {
  const classes = extractShikiStyles(hunks[0]?.renderedHtml ?? '').preClass.split(' ');
  return `gnosis-${CODE_THEMES.find((t) => classes.includes(t.id))?.id ?? 'aurora-x'}`;
}

/** Review checks flash the line they jump to (SlideView). Everything else about the code is Changes' own. */
const TOPIC_CSS = `
.check-highlight { animation: check-flash 1.6s ease-out; }
@keyframes check-flash { from { outline: 2px solid var(--ring); } to { background-color: transparent; } }
@media (prefers-reduced-motion: reduce) { .check-highlight { animation: none; outline: 2px solid var(--ring); } }
`;

/**
 * A topic's code for one file, rendered by Changes' own diff (ChangesDiff) through the same model
 * (useDiffFileModel): hunk headers with tree-sitter breadcrumbs and Show whole function, gap bars, the trailing bar,
 * pinned headers and the code palette. What only topics have rides on top: the topic's subset of hunks, inline
 * explanations, review-check pins, comments, drafts and GitHub threads.
 */
export function ReviewDiff({
  sourceLocation,
  onSourceLocationShown,
  filePath,
  hunks,
  pinnedLines,
  fileStatus: knownStatus,
  diffLayout,
  appearance = DEFAULT_DIFF_APPEARANCE,
  pendingComments = [],
  slideIndex,
  commentCallbacks,
  threads = [],
  inlineExplanations = [],
  renderThread,
  source,
  stickyUnder,
  active = true,
}: Props) {
  const root = useRef<HTMLDivElement>(null);
  // Without the file's status, a topic whose saved hunks add (or delete) the whole file is an added (or deleted) file,
  // shown as Changes shows one: unified, and whole.
  const fileStatus = useMemo(() => {
    if (knownStatus || !hunks.length) return knownStatus;
    const prepared = hunks.map((hunk) => prepareReviewHunk(hunk));
    if (!prepared.every((p) => p?.singleSide)) return undefined;
    return prepared.every((p) => p?.lines.every((line) => line.type === 'add')) ? 'added' : 'deleted';
  }, [knownStatus, hunks]);
  const fileComments = useMemo(() => pendingComments.filter((c) => c.filePath === filePath), [pendingComments, filePath]);
  const notes = useMemo(() => inlineExplanations.filter((note) => note.filePath === filePath), [inlineExplanations, filePath]);
  // Lines the topic points at stay in view, with context around them: checks, threads, notes and drafts.
  const pins = useMemo<ReviewPin[]>(
    () => [
      ...(pinnedLines ?? []).map((line) => ({ line })),
      ...threads.flatMap((t) => (t.line == null ? [] : [{ line: t.line, side: t.diffSide }])),
      ...notes.map((note) => ({ line: note.line, side: note.side })),
      ...fileComments.map((c) => ({ line: c.line, side: c.side })),
    ],
    [pinnedLines, threads, notes, fileComments]
  );
  const pinKey = pins.map((pin) => `${pin.side ?? ''}${pin.line}`).join(',');
  const context = diffContextLines(appearance);
  const saved = useMemo(
    () => reviewGapHunks(hunks, { status: fileStatus, context, pins }),
    [hunks, fileStatus, context, pinKey]
  );
  const lfs = hunks.some((hunk) => hunk.content.includes(LFS_VERSION));
  const path = source?.path ?? filePath;
  const request = useMemo<PrFileRequest | undefined>(
    () => (source ? { url: source.url, path: source.path, baseSha: source.baseSha, headSha: source.headSha } : undefined),
    [source?.url, source?.path, source?.baseSha, source?.headSha]
  );
  // The revision key Changes uses for the same file, so both read and parse it once.
  const fileKey = source
    ? fileRevisionKey(source.url, source.path, source.baseSha, source.headSha)
    : `topic:${slideIndex}:${filePath}`;
  const revealKey = `${fileKey}|${saved.hunks.map((h) => `${h.oldStart},${h.newStart},${h.rows.length}`).join(';')}`;
  const scopeFile = useMemo(() => {
    if (!source) return undefined;
    // The scope read needs only the revision and the file's patch (lib/syntax-contents.ts).
    const snapshot = {
      version: 1,
      url: source.url,
      metadata: { baseSha: source.baseSha, headSha: source.headSha },
      comparisonBase: source.baseSha,
      files: [],
      fetchedAt: 0,
    } as unknown as PrChanges;
    const file: PrChangeFile = {
      path: source.path,
      previousPath: source.previousPath,
      status: fileStatus ?? 'modified',
      additions: 0,
      deletions: 0,
      changeId: '',
      patch: saved.patch,
    };
    return { key: fileKey, snapshot, file };
  }, [fileKey, source?.previousPath, fileStatus, saved.patch]);
  const model = useDiffFileModel({
    fileKey,
    revealKey,
    path,
    previousPath: source?.previousPath,
    patch: saved.patch,
    hunks: saved.hunks,
    known: saved.known,
    partial: true,
    request,
    expandable: fileStatus !== 'added' && fileStatus !== 'deleted' && !lfs,
    active,
    scopeFile,
    readStructure: !!source,
    codeSettings: currentCodeIntelligence(),
    sectionRef: root,
  });
  // Unified context lines name their old line too, for review checks and jumps (findReviewLine).
  const oldOf = useMemo(() => {
    const map = new Map<number, number>();
    for (const part of model.parts ?? []) {
      if (part.kind !== 'hunk') continue;
      let oldLine = part.hunk.oldStart,
        newLine = part.hunk.newStart;
      for (const row of part.hunk.rows) {
        if (row.type === ' ') map.set(newLine, oldLine);
        if (row.type !== '+') oldLine++;
        if (row.type !== '-') newLine++;
      }
    }
    return map;
  }, [model.parts]);
  const [active_, setActive] = useSessionDraft<Location | null>(`comment-location:${slideIndex}:${filePath}`, null);
  const single = fileStatus === 'added' || fileStatus === 'deleted';
  const unified = single || diffLayout === 'unified';
  const options: FileDiffOptions<Location, undefined> = {
    theme: reviewDiffTheme(hunks),
    preferredHighlighter: DIFF_HIGHLIGHTER,
    themeType: 'dark',
    diffStyle: single ? 'unified' : diffLayout,
    disableFileHeader: true,
    hunkSeparators: 'simple',
    diffIndicators: appearance.indicators,
    disableBackground: !appearance.backgrounds,
    disableLineNumbers: !appearance.lineNumbers,
    overflow: appearance.wrap ? 'wrap' : 'scroll',
    lineDiffType: appearance.inline,
    unsafeCSS: TOPIC_CSS,
    enableGutterUtility: !!commentCallbacks,
    onGutterUtilityClick: commentCallbacks
      ? (range) => setActive({ line: range.start, side: range.side === 'deletions' ? 'LEFT' : 'RIGHT' })
      : undefined,
    onLineNumberClick: commentCallbacks
      ? (event) => setActive({ line: event.lineNumber, side: event.annotationSide === 'deletions' ? 'LEFT' : 'RIGHT' })
      : undefined,
    onPostRender(node) {
      // Review checks jump to a line by these (findReviewLine): `data-file-path` is the topic's path, `data-line-number`
      // the new line where the row has one, and `data-base-line` the old line: on deleted rows, on the old column of a
      // split diff, and on unified context rows.
      for (const el of node.shadowRoot?.querySelectorAll<HTMLElement>('[data-code] [data-line]') ?? []) {
        const type = el.dataset.lineType;
        const old = type === 'change-addition' ? false : type === 'change-deletion' || !!el.closest('[data-deletions]');
        const n = Number(el.dataset.line);
        el.dataset.filePath = filePath;
        delete el.dataset.lineNumber;
        delete el.dataset.baseLine;
        if (!old) el.dataset.lineNumber = String(n);
        if (old) el.dataset.baseLine = String(n);
        else if (unified && oldOf.has(n)) el.dataset.baseLine = String(oldOf.get(n));
      }
      if (sourceLocation)
        requestAnimationFrame(() => {
          if (!node.isConnected) return;
          const target = node.shadowRoot?.querySelector<HTMLElement>(
            `[${sourceLocation.side === 'before' ? 'data-base-line' : 'data-line-number'}="${sourceLocation.start}"]`
          );
          if (!target) return;
          target.scrollIntoView({ block: 'center', behavior: 'instant' });
          node.tabIndex = -1;
          node.setAttribute(
            'aria-label',
            `Source at ${sourceLocation.side === 'before' ? 'old' : 'new'} line ${sourceLocation.start}`
          );
          node.focus({ preventScroll: true });
          onSourceLocationShown?.();
        });
    },
  };
  const shownAt = (location: Location) =>
    (location.side === 'LEFT' ? model.shown?.before : model.shown?.after)?.has(location.line) ?? false;
  const annotations = useMemo<DiffLineAnnotation<Location>[]>(() => {
    const locations: Location[] = [
      ...fileComments,
      ...(active_ ? [active_] : []),
      ...threads.flatMap((t) => (t.line == null ? [] : [{ line: t.line, side: t.diffSide }])),
      ...notes,
    ];
    const seen = new Set<string>();
    return locations.flatMap((location) => {
      const key = `${location.side}:${location.line}`;
      if (seen.has(key) || !shownAt(location)) return [];
      seen.add(key);
      return [{ lineNumber: location.line, side: location.side === 'LEFT' ? 'deletions' : 'additions', metadata: location }];
    });
  }, [fileComments, active_, threads, notes, model.shown]);
  const renderAnnotation = ({ metadata: location }: DiffLineAnnotation<Location>) => (
    <div className="font-sans text-foreground text-sm">
      {notes
        .filter((note) => note.line === location.line && note.side === location.side)
        .map((note) => (
          <InlineCodeExplanation key={`${note.side}:${note.line}:${note.text}`} explanation={note} />
        ))}
      {commentCallbacks && active_?.line === location.line && active_.side === location.side && (
        <InlineCommentForm
          draftKey={`${filePath}:${slideIndex}:${location.side}:${location.line}`}
          onCancel={() => setActive(null)}
          onSubmit={async (body) => {
            const lines = location.side === 'LEFT' ? model.shown?.before : model.shown?.after;
            await commentCallbacks.onAddComment({
              filePath,
              ...location,
              body,
              slideIndex,
              hunkHeader: saved.headers.get(`${location.side}:${location.line}`) ?? (hunks.at(0)?.hunkHeader ?? ''),
              codeSnippet: lines?.get(location.line)?.replace(/\r$/, '') ?? '',
            });
            setActive(null);
          }}
        />
      )}
      {commentCallbacks &&
        fileComments
          .filter((c) => c.line === location.line && c.side === location.side)
          .map((c) => (
            <CommentBubble
              key={c.id}
              comment={c}
              onEdit={commentCallbacks.onEditComment}
              onRemove={commentCallbacks.onRemoveComment}
            />
          ))}
      {threads.filter((t) => t.line === location.line && t.diffSide === location.side).map((t) => renderThread?.(t))}
    </div>
  );
  return (
    <div ref={root} className="review-diff select-text min-w-0">
      {model.parts && model.parts.length > 0 && (
        <ChangesDiff
          parts={model.parts}
          file={{ name: path, prevName: source?.previousPath, status: fileStatus }}
          layout={diffLayout}
          options={options}
          annotations={annotations}
          renderAnnotation={renderAnnotation}
          status={model.gapStatus}
          onReveal={model.gaps ? (part, direction) => model.revealLines(part.gap, direction) : undefined}
          canReveal={model.canReveal}
          onRetry={() => model.readAfter(true)}
          scopes={model.scopes}
          structure={model.structure}
          scopeNote={model.scopeNote}
          scopeAt={model.scopeAt}
          onShowDefinition={model.showDefinition}
          stickyUnder={stickyUnder}
          target={sourceLocation ? { side: sourceLocation.side, line: sourceLocation.start } : undefined}
          lineCount={model.lineCount}
        />
      )}
      {saved.unreadable.map((hunk) => (
        <div key={hunk.hunkHeader} className="review-diff-unreadable" role="note">
          <p>This saved change could not be read as a diff. Its text is below.</p>
          <pre>{hunk.content}</pre>
        </div>
      ))}
    </div>
  );
}

/** Keep the renderer's shadow DOM boundary out of review navigation. */
export function findReviewLine(
  container: HTMLElement,
  filePath: string,
  line: number,
  side?: DiffSide
): HTMLElement | null {
  const roots: (HTMLElement | ShadowRoot)[] = [
    container,
    ...Array.from(container.querySelectorAll('diffs-container')).flatMap((el) =>
      el.shadowRoot ? [el.shadowRoot] : []
    ),
  ];
  for (const attr of side === 'LEFT'
    ? ['data-base-line']
    : side === 'RIGHT'
      ? ['data-line-number']
      : ['data-line-number', 'data-base-line']) {
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
