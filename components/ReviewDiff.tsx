import type { MarkdownLocation } from '../lib/markdown-review';
import { useSessionDraft } from '../lib/session-drafts';
import { useMemo, useRef, type ReactNode, type RefObject } from 'react';
import type { GitHubReviewThread } from '../lib/review-threads';
import type { DiffLineAnnotation, FileDiffOptions } from '@pierre/diffs';
import { DIFF_HIGHLIGHTER } from '@/lib/diff-highlighter';
import { CODE_THEMES } from '@/lib/constants';
import { DEFAULT_DIFF_APPEARANCE, diffContextLines, prepareReviewHunk, type DiffAppearance } from '@/lib/review-diff';
import { useNoiseFilter } from '@/lib/use-semantic-noise';
import { reviewGapHunks, type ReviewPin } from '@/lib/review-gap-hunks';
import type { ElsewhereChange, HiddenChange, HiddenTarget } from '@/lib/diff-gaps';
import { resolveBlock } from '@/lib/slide-file-groups';
import { fileRevisionKey, type PrChangeFile, type PrChanges, type PrFileRequest } from '@/lib/pr-changes';
import { currentCodeIntelligence } from '@/lib/use-syntax-contents';
import { LFS_VERSION } from '@/lib/git-lfs';
import type { DiffHunk, DiffSide, FileMetadata, InlineExplanation, PendingReviewComment } from '@/lib/types';
import { InlineCodeExplanation } from './InlineCodeExplanation';
import { openQuietLine } from '@/lib/diff-here';
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
  /** Which block of the file this is, when a topic shows one file in more than one block: each has its own open comment. */
  commentScope?: string;
  /** Changes other blocks of the file show: gaps over them reveal nothing, and offer a jump to the block. */
  elsewhere?: readonly ElsewhereChange[];
  onShowElsewhere?: (run: number, line?: number) => void;
  /** Changes the section leaves out between its slices (#563): their gaps say where each went. */
  hidden?: readonly HiddenChange[];
  /** The action that opens where a hidden change went (another section, or Changes), if the view can. */
  onOpenHidden?: (target: HiddenTarget) => (() => void) | undefined;
  /** False for a diff with nothing to reveal between its hunks, such as a moved definition's edits (#563). */
  expandable?: boolean;
  /** Unchanged lines of the saved hunks the section's ranges leave out, by new line: gaps reveal from them (#563). */
  hiddenContext?: ReadonlyMap<number, string>;
  commentCallbacks?: CommentCallbacks;
  threads?: GitHubReviewThread[];
  inlineExplanations?: InlineExplanation[];
  renderThread?: (thread: GitHubReviewThread) => ReactNode;
  /** The PR revision the topic was written against; without it, gaps reveal only lines the topic saved. */
  source?: ReviewDiffSource;
  /**
   * What tells this diff from another one of the same path and slide when it has no `source`: the PR's URL, or a chat
   * patch's hash. Its reveals and shown scopes are kept under it for the session (useDiffFileModel).
   */
  keyScope?: string;
  /** The file's header: hunk headers pin right below it, as in Changes. */
  stickyUnder?: RefObject<HTMLElement | null>;
  /** The file is expanded: collapsed files read nothing. */
  active?: boolean;
  /** The Pierre theme, when the hunks carry no saved highlighting: Feedback's GitHub hunks use the reader's code theme. */
  theme?: string;
  /** Gaps name only their hidden lines (Feedback's comment excerpts are not a topic's chosen hunks). */
  plainGaps?: boolean;
  /** The file is marked Viewed: its outline's symbols read as viewed. */
  fileViewed?: boolean;
  /** Marks the file Viewed, offered once every symbol of its outline is ticked. */
  onMarkFileViewed?: () => void;
}

/** The Pierre theme a topic's code was highlighted in, from its saved HTML: the file header and bars take its palette. */
export function reviewDiffTheme(hunks: readonly DiffHunk[]): string {
  const classes = extractShikiStyles(hunks[0]?.renderedHtml ?? '').preClass.split(' ');
  return `gnosis-${CODE_THEMES.find((t) => classes.includes(t.id))?.id ?? 'aurora-x'}`;
}

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
  commentScope,
  elsewhere,
  onShowElsewhere,
  hidden,
  onOpenHidden,
  hiddenContext,
  expandable = true,
  commentCallbacks,
  threads = [],
  inlineExplanations = [],
  renderThread,
  source,
  keyScope = '',
  stickyUnder,
  active = true,
  theme,
  plainGaps,
  fileViewed,
  onMarkFileViewed,
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
  // A section's ranges leave rows of their saved hunks out: those unchanged lines are known too, as a whole hunk's are.
  const known = useMemo(() => {
    if (!hiddenContext?.size) return saved.known;
    const all = [...saved.known];
    for (const [line, text] of hiddenContext) all[line - 1] ??= text;
    return all;
  }, [saved.known, hiddenContext]);
  const lfs = hunks.some((hunk) => hunk.content.includes(LFS_VERSION));
  const path = source?.path ?? filePath;
  const request = useMemo<PrFileRequest | undefined>(
    () => (source ? { url: source.url, path: source.path, baseSha: source.baseSha, headSha: source.headSha } : undefined),
    [source?.url, source?.path, source?.baseSha, source?.headSha]
  );
  // The revision key Changes uses for the same file, so both read and parse it once.
  const fileKey = source
    ? fileRevisionKey(source.url, source.path, source.baseSha, source.headSha)
    : `topic:${keyScope}:${slideIndex}:${filePath}`;
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
  // The same quiet changes as Changes (#396), from the same appearance.
  const noiseFilter = useNoiseFilter(appearance);
  const model = useDiffFileModel({
    fileKey,
    revealKey,
    path,
    previousPath: source?.previousPath,
    patch: saved.patch,
    hunks: saved.hunks,
    known,
    partial: true,
    elsewhere,
    hidden,
    request,
    expandable: expandable && fileStatus !== 'added' && fileStatus !== 'deleted' && !lfs,
    active,
    scopeFile,
    readStructure: !!source,
    codeSettings: currentCodeIntelligence(),
    sectionRef: root,
    status: lfs ? undefined : fileStatus,
    noiseFilter,
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
  const [active_, setActive] = useSessionDraft<Location | null>(`comment-location:${slideIndex}:${commentScope ?? filePath}`, null);
  const single = fileStatus === 'added' || fileStatus === 'deleted';
  const unified = single || diffLayout === 'unified';
  const options: FileDiffOptions<Location, undefined> = {
    theme: theme ?? reviewDiffTheme(hunks),
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
          outline={{
            quiet: model.quietSymbols,
            symbols: model.symbols,
            pending: model.outlinePending,
            fileKey,
            fileName: path.slice(path.lastIndexOf('/') + 1),
            fileViewed,
            onMarkFileViewed,
          }}
          stickyUnder={stickyUnder}
          target={sourceLocation ? { side: sourceLocation.side, line: sourceLocation.start } : undefined}
          lineCount={model.lineCount}
          plainGaps={plainGaps}
          onShowElsewhere={onShowElsewhere}
          onOpenHidden={onOpenHidden}
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

/**
 * The block of `filePath` that holds `line`, when a topic shows the file in more than one block: the first rendered
 * block that shows the line, the new side first, then the first whose saved hunks span it (a collapsed block renders
 * none), else the file's first block. With a thread id, the block that shows that thread, placed or not.
 */
export function findReviewBlock(
  root: ParentNode,
  filePath: string,
  { line, side, threadId }: { line?: number; side?: DiffSide; threadId?: string } = {}
): HTMLElement | undefined {
  const blocks = [...root.querySelectorAll<HTMLElement>('.review-file-group[data-file-path]')].filter(
    (block) => block.dataset.filePath === filePath
  );
  if (threadId) {
    const holder = blocks.find((block) => block.querySelector(`[data-thread-id="${CSS.escape(threadId)}"]`));
    if (holder) return holder;
  }
  return resolveBlock(
    blocks,
    { line, side },
    (block, s) => line !== undefined && !!findReviewLine(block, filePath, line, s),
    (block, s) => (s === 'LEFT' ? block.dataset.oldRanges : block.dataset.newRanges)
  );
}

/**
 * When a line is not on screen because a quiet change holds it (#396), opens that change: a jump then finds the line
 * once the diff renders. Whether it opened one.
 */
export function openReviewLine(container: HTMLElement, filePath: string, line: number, side?: DiffSide): boolean {
  const groups = [...container.querySelectorAll<HTMLElement>('.review-file-group[data-file-path]')].filter((group) => group.dataset.filePath === filePath);
  const scopes: HTMLElement[] = groups.length ? groups : container.matches('.review-file-group') ? [container] : [container];
  return scopes.some((scope) => openQuietLine(scope, line, side === 'LEFT' ? 'before' : 'after'));
}

export function reviewCodeSelection(container: HTMLElement) {
  for (const host of container.querySelectorAll('diffs-container')) {
    const root = host.shadowRoot as (ShadowRoot & { getSelection?: () => Selection | null }) | null;
    const selection = root?.getSelection?.();
    if (selection && !selection.isCollapsed && selection.rangeCount) return selection;
  }
  return window.getSelection();
}
