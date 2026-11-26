import { LoadingState, LoadingIndicator } from './LoadingState';
import { DIFF_HIGHLIGHTER } from '../lib/diff-highlighter';
import { stackFileProgressKey, stackFileSourcePath, stackFileDiscussions } from '../lib/stack-changes';
import { GitHubReviewThread } from './GitHubReviewThread';
import { SearchableSelect } from './SearchableSelect';
import { isMarkdownFile, type MarkdownReview, type MarkdownLocation } from '../lib/markdown-review';
import { useMarkdownView } from '../lib/use-markdown-view';
import { peekMarkdownReview, prepareMarkdownReview } from '../lib/markdown-review-cache';
import { MarkdownReviewPreview } from './MarkdownReviewPreview';
import { CommitBadge } from './EntityBadge';
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { File } from '@pierre/diffs/react';
import { parseDiffFromFile, type DiffFileInput, type FileDiffMetadata, type FileDiffOptions, type SelectedLineRange } from '@pierre/diffs';
import { Bot, CheckCheck, MessageSquare, ExternalLink } from 'lucide-react';
import { inspectionFiles as fileCache, previewFor } from '../lib/inspection-cache';
import {
  isUnchangedMove,
  fileRevisionKey,
  type PrChanges,
  type PrChangeFile,
  type PrFileContents,
  type PrFileSide,
} from '../lib/pr-changes';
import { useFileProgress } from '../lib/file-view-progress';
import { useDiffAppearance } from '../lib/use-diff-appearance';
import { useDiffLayout } from '../lib/use-diff-layout';
import { diffContextLines } from '../lib/review-diff';
import { useNoiseFilter } from '../lib/use-semantic-noise';
import { quietHeader } from '../lib/quiet-changes-header';
import { gapContaining, hunksFromDiff, shownSelection } from '../lib/diff-gaps';
import { ChangesDiff } from './ChangesDiff';
import { useDiffFileModel } from './useDiffFileModel';
import { usePendingSymbolJump } from '../lib/tree-symbol-sync';
import { releaseHeld, useHeldOpen } from '../lib/symbol-file-sync';
import { applyCodeIntelligence } from '../lib/use-syntax-contents';
import { codeIntelligenceSettings } from '../lib/code-intelligence';
import { diffThemeName } from '../lib/diff-worker-pool';
import { applyCodePalette } from '../lib/diff-code-palette';
import type { Preferences } from '../lib/types';
import type { usePrDiscussions } from '../lib/use-pr-discussions';
import type { ReviewImageSide } from '../lib/review-images';
import { briefCode, briefPin, type AgentBriefLocation } from '../lib/agent-brief';
import type { ReviewSubject } from '../lib/workbench';
import { useChangesComments } from './useChangesComments';
import { ExplainedChangesContext } from '../lib/explained-changes';
import { DiffFileHeader } from './DiffFileHeader';
import { LfsDownload } from './LfsDownload';
import { ReviewImageDiff } from './ReviewImageDiff';
import { ReviewSelectionActions } from './ReviewSelectionActions';
import { Button } from './ui/button';

export interface ChangeFileEntry {
  key: string;
  snapshot: PrChanges;
  file: PrChangeFile;
}
export const changeFileKey = (entry: ChangeFileEntry) =>
  entry.snapshot.stackComparison
    ? stackFileProgressKey(entry.snapshot, entry.file)
    : `${entry.snapshot.comparison ? 'commit:' : ''}${fileRevisionKey(entry.snapshot.url, entry.file.path, entry.snapshot.metadata.baseSha, entry.snapshot.metadata.headSha)}`;
// Electron preserves messages across IPC, but not custom Error types.
const isUnsupportedPreview = (message: string) =>
  /This file is too large to preview|This binary file has no text preview|This file is not UTF-8 text/.test(message);


function isBeforeDiffLine(line: HTMLElement) {
  if (line.dataset.lineType === 'change-addition') return false;
  if (line.dataset.lineType === 'change-deletion') return true;
  return !!line.closest('[data-deletions]') && !line.closest('[data-additions]');
}

/** One revision's file preview and discussions. The workspace owns navigation and shared data. */
export function PrFileInspection({
  entry,
  preferences: prefs,
  discussion,
  onViewedNext,
  onAsk,
  onOpenCurrentFile,
  classificationControl,
  classificationTags,
  sourceLine,
  sourceEndLine,
  renderFeedbackThread,
  focusThreadId,
  sourceSide = 'after',
  onOpenSource,
  briefSubject,
  onOpenBrief,
  onOpenFeedback,
  autoViewSymbols = false,
  symbolTree = false,
}: {
  entry: ChangeFileEntry;
  /**
   * The diff is the Changes stream's: the file tree's symbol rows follow the reader here and jump here
   * (lib/tree-symbol-sync.ts). Other views of a file, such as a feedback thread's, leave the tree alone.
   */
  symbolTree?: boolean;
  sourceLine?: number;
  /** Last line of a jump range; defaults to `sourceLine`. */
  sourceEndLine?: number;
  focusThreadId?: string;
  renderFeedbackThread?: (thread: import('../lib/review-threads').GitHubReviewThread) => ReactNode;
  sourceSide?: 'before' | 'after';
  /** The stack or PR whose agent brief collects comments made here. */
  briefSubject?: ReviewSubject;
  onOpenBrief?: () => void;
  onOpenFeedback?: (url: string, threadId: string) => void;
  /** Settings › Review › "Mark a symbol viewed after you scroll through it" (Beta): the diff ticks what the reader read. */
  autoViewSymbols?: boolean;
  onOpenSource?: (url: string, path: string) => void;
  classificationControl?: ReactNode;
  /** The file's kind tags, such as Test, beside its path and status. */
  classificationTags?: ReactNode;
  preferences: Preferences;
  discussion: ReturnType<typeof usePrDiscussions>;
  onViewedNext?: () => void;
  onAsk: (text: string) => void;
  onOpenCurrentFile?: (url: string, path: string) => void;
}) {
  const commit = !!onOpenCurrentFile;
  const combined = entry.snapshot.stackComparison;
  const activeKey = changeFileKey(entry);
  const progress = useFileProgress();
  const viewed = progress.isFileViewed(activeKey);
  // Jumping to a line must show it, without changing the reviewer's viewed progress.
  const [jumpedOpen, setJumpedOpen] = useState(false);
  // A file its last symbol tick marked Viewed stays open while the reader is on it (lib/symbol-file-sync.ts), and
  // collapses once they move on. A file marked Viewed by hand collapses at once, as always.
  const heldOpen = useHeldOpen(activeKey);
  const collapsed = viewed && !jumpedOpen && !focusThreadId && !(symbolTree && heldOpen);
  // A symbol chosen in the file tree opens a file shown collapsed, as a jump to a line does: its diff takes the jump.
  const symbolJump = usePendingSymbolJump(symbolTree ? activeKey : '');
  useEffect(() => {
    if (symbolJump && collapsed) setJumpedOpen(true);
  }, [symbolJump, collapsed]);
  const opened = useRef(!collapsed);
  if (!collapsed) opened.current = true;
  const appearance = useDiffAppearance(prefs.diffAppearance);
  const layout = useDiffLayout(prefs.diffLayout);
  const markdown = isMarkdownFile(entry.file.path);
  const [markdownView, changeMarkdownView] = useMarkdownView();
  const [sourceOverride, setSourceOverride] = useState<string>();
  const [sourceLocation, setSourceLocation] = useState<MarkdownLocation>();
  const sourceJump = useRef<MarkdownLocation | undefined>(undefined);
  const previewJump = useRef<MarkdownLocation | undefined>(undefined);
  const sectionRef = useRef<HTMLElement>(null);
  // A held file collapses once its diff has scrolled wholly out of view, keeping what the reader looks at in place.
  useEffect(() => {
    const section = sectionRef.current;
    const scroller = section?.closest<HTMLElement>('.commit-diff-stream');
    if (!symbolTree || !heldOpen || !section || !scroller) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[entries.length - 1].isIntersecting) releaseHeld({ only: activeKey, anchor: true });
      },
      { root: scroller }
    );
    observer.observe(section);
    return () => observer.disconnect();
  }, [symbolTree, heldOpen, activeKey]);
  // Unmounted (scrolled far away, or the view closed): the reader has left it, and it shows collapsed when it returns.
  useEffect(() => () => releaseHeld({ only: activeKey }), [activeKey]);
  const headerRef = useRef<HTMLElement>(null);
  const [markdownResult, setMarkdownResult] = useState<{ key: string; value: MarkdownReview }>();
  const [markdownError, setMarkdownError] = useState<{ key: string; message: string }>();
  const [markdownAttempt, setMarkdownAttempt] = useState(0);
  const [revealedMove, setRevealedMove] = useState<string>();
  const contextLines = diffContextLines(appearance);
  // GitHub's patches carry 3 lines of context. More comes from revealing a gap, from the after side only (#299).
  const previewContext = Math.min(3, contextLines);
  const parseDiffOptions = useMemo(() => ({ context: contextLines }), [contextLines]);
  const [loadedFile, setLoadedFile] = useState<{ key: string; data: PrFileContents }>();
  const [fileError, setFileError] = useState('');
  const [fileAttempt, setFileAttempt] = useState(0);
  const unsupportedFiles = useRef(new Map<string, string>());
  const [range, setRange] = useState<SelectedLineRange | null>(null);
  const code = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const currentFile = useRef(activeKey);
  currentFile.current = activeKey;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!markdown) return;
    const section = sectionRef.current;
    const header = section?.querySelector('.changes-file-header');
    if (!section || !header) return;
    // The toolbar mounts later inside the section, so the value stays an inherited property. Take the size from the
    // observer entry and write only when it changes, so a resize neither forces a layout nor restyles the file.
    let written = '';
    const write = (height: number) => {
      const value = `${Math.round(height)}px`;
      if (value === written) return;
      written = value;
      section.style.setProperty('--markdown-header-height', value);
    };
    write(header.getBoundingClientRect().height);
    const observer = new ResizeObserver((entries) => write(entries[entries.length - 1].borderBoxSize[0].blockSize));
    observer.observe(header);
    return () => observer.disconnect();
  }, [markdown]);
  const request = {
    url: entry.snapshot.url,
    path: entry.file.path,
    baseSha: entry.snapshot.metadata.baseSha,
    headSha: entry.snapshot.metadata.headSha,
    comparison: entry.snapshot.comparison,
    stackComparison: combined?.key,
  };
  const preview = useMemo(() => previewFor(activeKey, entry.file, previewContext), [activeKey, entry.file, previewContext]);
  const contents = fileCache.peek(request) ?? (loadedFile?.key === activeKey ? loadedFile.data : undefined);
  const unchangedMove = useMemo(() => isUnchangedMove(entry.file, contents), [entry.file, contents]);
  const compactMove = unchangedMove && revealedMove !== activeKey;
  // Context gaps (#299): gaps come from the patch, and revealed lines from the after side alone. Files without a
  // patch diff both sides here instead, which they have already loaded.
  const wholeDiff = useMemo((): FileDiffMetadata | undefined => {
    if (preview || !contents || unchangedMove) return;
    const { before, after } = contents;
    if (before.kind !== 'text' && after.kind !== 'text') return;
    if ([before.kind, after.kind].some((kind) => kind !== 'text' && kind !== 'absent')) return;
    try {
      return parseDiffFromFile(
        before.kind === 'text' ? { name: entry.file.previousPath ?? entry.file.path, contents: before.content } : null,
        after.kind === 'text' ? { name: entry.file.path, contents: after.content } : null,
        parseDiffOptions,
        true
      );
    } catch {
      return;
    }
  }, [preview, contents, unchangedMove, entry.file.path, entry.file.previousPath, parseDiffOptions]);
  const diffBase = preview ?? wholeDiff;
  const gapHunks = useMemo(() => (diffBase ? hunksFromDiff(diffBase) : undefined), [diffBase]);
  const expandable = entry.file.status !== 'added' && entry.file.status !== 'deleted' && !contents?.lfs;
  // Settings › Appearance › Code intelligence: a language that is off shows as a file without a grammar.
  const codeSettings = useMemo(() => codeIntelligenceSettings(prefs), [prefs.codeIntelligence]);
  const noiseFilter = useNoiseFilter(appearance);
  useEffect(() => applyCodeIntelligence(codeSettings), [codeSettings]);
  const scopeFile = useMemo(() => ({ key: activeKey, snapshot: entry.snapshot, file: entry.file }), [activeKey, entry.snapshot, entry.file]);
  // Gaps, reveals, scopes and structure loading are shared with Explanation topics (components/useDiffFileModel.tsx).
  const model = useDiffFileModel({
    fileKey: activeKey,
    path: entry.file.path,
    previousPath: entry.file.previousPath,
    patch: entry.file.patch,
    hunks: gapHunks,
    request,
    contents,
    expandable,
    active: !collapsed,
    scopeFile,
    readStructure: !!preview && !unchangedMove,
    codeSettings,
    sectionRef,
    // An added or deleted file's structure comes from its patch; an LFS pointer is not the file.
    status: contents?.lfs ? undefined : entry.file.status,
    noiseFilter,
  });
  // The symbols the reader may tick by scrolling through them: the outline's own, each with its changed lines.
  const autoView = useMemo(
    () =>
      autoViewSymbols && model.symbols && model.symbolLines
        ? {
            fileKey: activeKey,
            symbols: model.symbols.map((symbol) => ({ id: symbol.id, lines: model.symbolLines?.get(symbol.id) ?? [] })),
          }
        : undefined,
    [autoViewSymbols, model.symbols, model.symbolLines, activeKey]
  );
  // How much of the file is noise the reader hides (#396), for its header: "90 formatting", or "Formatting only".
  const quiet = model.noise?.file;
  const quietStat = quiet && (quiet.added || quiet.deleted) ? quietHeader(quiet, entry.file.additions, entry.file.deletions) : undefined;
  const { parts, gaps, shown, lineCount } = model;
  const revealLines = model.revealLines;
  const wantsPreview = !compactMove && markdown && markdownView.mode === 'preview' && sourceOverride !== activeKey;
  const markdownKey = activeKey + (contents?.lfs ? ':lfs' : '');
  const renderedMarkdown =
    peekMarkdownReview(markdownKey) ?? (markdownResult?.key === markdownKey ? markdownResult.value : undefined);
  const showingPreview = wantsPreview && !!renderedMarkdown;
  const [lfsDownload, setLfsDownload] = useState<{ key: string; busy: boolean; error?: string }>();
  const lfsSides = contents ? [contents.before, contents.after].filter((side) => side.kind === 'lfs') : [];
  async function downloadLfs() {
    if (lfsDownload?.key === activeKey && lfsDownload.busy) return;
    setLfsDownload({ key: activeKey, busy: true });
    try {
      const data = await fileCache.read({ ...request, downloadLfs: true });
      if (alive.current && currentFile.current === activeKey) setLoadedFile({ key: activeKey, data });
      if (alive.current)
        setLfsDownload((previous) => (previous?.key === activeKey ? { key: activeKey, busy: false } : previous));
    } catch (e) {
      if (alive.current)
        setLfsDownload((previous) =>
          previous?.key === activeKey
            ? { key: activeKey, busy: false, error: e instanceof Error ? e.message : String(e) }
            : previous
        );
    }
  }
  useEffect(() => {
    if (collapsed) return;
    let cancelled = false;
    setLoadedFile((previous) => (previous?.key === activeKey ? previous : undefined));
    setRange(null);
    setFileError('');
    // A patch preview shows the change at once; gaps load the after side when the reader reveals one (#299).
    if (contents || (!markdown && preview)) return;
    const unsupported = unsupportedFiles.current.get(activeKey);
    if (unsupported) {
      setFileError(unsupported);
      return;
    }
    void fileCache
      .read({
        url: entry.snapshot.url,
        baseSha: entry.snapshot.metadata.baseSha,
        headSha: entry.snapshot.metadata.headSha,
        path: entry.file.path,
        comparison: entry.snapshot.comparison,
        stackComparison: combined?.key,
      })
      .then((value) => {
        if (!cancelled) setLoadedFile({ key: activeKey, data: value });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          const message = e instanceof Error ? e.message : String(e);
          if (isUnsupportedPreview(message)) unsupportedFiles.current.set(activeKey, message);
          setFileError(message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeKey, fileAttempt, collapsed]);
  useEffect(() => {
    if (
      !markdown ||
      compactMove ||
      !contents ||
      collapsed ||
      ![contents.before.kind, contents.after.kind].every((kind) => kind === 'text' || kind === 'absent')
    )
      return;
    let cancelled = false;
    setMarkdownError(undefined);
    void prepareMarkdownReview(markdownKey, {
      before: contents.before.kind === 'text' ? contents.before.content : null,
      after: contents.after.kind === 'text' ? contents.after.content : null,
      beforeSource: {
        repo: entry.snapshot.metadata.baseRepo ?? entry.snapshot.url.split('/').slice(3, 5).join('/'),
        ref: entry.snapshot.comparisonBase,
        path: entry.file.previousPath ?? entry.file.path,
      },
      afterSource: {
        repo:
          entry.snapshot.metadata.headRepo ??
          entry.snapshot.metadata.baseRepo ??
          entry.snapshot.url.split('/').slice(3, 5).join('/'),
        ref: entry.snapshot.metadata.headSha,
        path: entry.file.path,
      },
    })
      .then((value) => {
        if (!cancelled) setMarkdownResult({ key: markdownKey, value });
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setMarkdownError({ key: markdownKey, message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [markdownKey, contents, collapsed, markdownAttempt, compactMove]);
  useEffect(() => {
    setSourceLocation(undefined);
    sourceJump.current = undefined;
    previewJump.current = undefined;
  }, [activeKey]);
  // A jump into a gap reveals the gap, so the line can be shown.
  useEffect(() => {
    if (!sourceLocation || !gaps) return;
    const gap = gapContaining(gaps, sourceLocation.side, sourceLocation.start);
    if (gap) revealLines(gap, 'all');
  }, [sourceLocation, gaps]);
  useEffect(() => {
    if (!showingPreview || !previewJump.current) return;
    const location = previewJump.current;
    previewJump.current = undefined;
    const block = renderedMarkdown.blocks.find((block) => {
      const range = block[location.side];
      return range && range.end >= location.start;
    });
    if (!block) return;
    const frame = requestAnimationFrame(() =>
      sectionRef.current
        ?.querySelector(`[data-md-block="${block.id}"]`)
        ?.scrollIntoView({ block: 'start', behavior: 'instant' })
    );
    return () => cancelAnimationFrame(frame);
  }, [showingPreview, renderedMarkdown]);
  const threads = discussion.discussions[entry.snapshot.url]?.data;
  const threadError = discussion.discussions[entry.snapshot.url]?.error;
  const matching =
    threads?.threads.filter((t) => t.path === entry.file.path || t.path === entry.file.previousPath) ?? [];
  const inline = matching.filter(
    (t) =>
      !contents?.lfs &&
      !t.isOutdated &&
      t.line !== null &&
      threads?.headSha === entry.snapshot.metadata.headSha &&
      (t.diffSide === 'RIGHT' || threads.baseSha === entry.snapshot.metadata.baseSha)
  );
  const combinedSourcePath = (url: string) =>
    combined ? stackFileSourcePath(combined, entry.file, url) : entry.file.path;
  const combinedDiscussion = combined
    ? stackFileDiscussions(entry.snapshot, entry.file, discussion.discussions)
    : undefined;
  const combinedThreads = combinedDiscussion?.threads.map((t) => ({ ...t, inline: !contents?.lfs && t.inline })) ?? [];
  const other = combined
    ? combinedThreads.filter((t) => !t.inline).map((t) => t.thread)
    : matching.filter((t) => !inline.includes(t));
  const sourceOptions =
    combined?.members.filter((m) => combined.fileSources[entry.file.path]?.includes(m.metadata.url)) ?? [];
  const commentSources = sourceOptions.length ? sourceOptions : (combined?.members ?? []);
  const renderCombinedThread = (thread: (typeof inline)[number]) => {
    const source = combinedThreads.find((t) => t.thread.id === thread.id)?.source;
    return (
      <div key={thread.id} className="combined-thread">
        <Button variant="link" size="sm" onClick={() => { if (source) { if (onOpenFeedback) onOpenFeedback(source.metadata.url, thread.id); else onOpenSource?.(source.metadata.url, thread.path); } }}>
          PR #{source?.metadata.url.split('/').pop()} · {onOpenFeedback ? 'Address feedback' : 'Open to reply'}
        </Button>
        <GitHubReviewThread thread={thread} />
      </div>
    );
  };
  const visibleDiscussions = unchangedMove ? (combined ? combinedThreads.map((t) => t.thread) : matching) : other;
  const refreshThreads = discussion.refresh;
  const sideLine = (text: PrFileSide | undefined, previewSide: 'deletions' | 'additions', line: number) =>
    text?.kind === 'text'
      ? (text.content.split('\n')[line - 1] ?? '')
      : ((previewSide === 'deletions' ? shown?.before : shown?.after)?.get(line)?.replace(/\r$/, '') ?? '');
  const briefLineCode = ({ line, startLine, side, startSide }: AgentBriefLocation) => {
    const start = startLine ?? line;
    // Only the ends of a two-sided region are known here. The agent has the diff for what lies between.
    if (startSide)
      return briefCode(
        `old ${start}: ${sideLine(contents?.before, 'deletions', start)}\nnew ${line}: ${sideLine(contents?.after, 'additions', line)}`
      );
    const text = contents && (side === 'LEFT' ? contents.before : contents.after);
    if (text?.kind === 'text') return briefCode(text.content.split('\n').slice(start - 1, line).join('\n'));
    if (!shown) return {};
    // The comment already says which lines these are, so shown lines are not numbered.
    return briefCode(shownSelection(side === 'LEFT' ? shown.before : shown.after, start, line, false));
  };
  const comments = useChangesComments({
    brief: briefSubject && {
      subjectId: briefSubject.id,
      pin: briefPin(briefSubject, entry.snapshot, entry.file),
      code: briefLineCode,
      onOpen: onOpenBrief,
    },
    enabled: !commit && !combined,
    snapshot: commit || combined ? undefined : entry.snapshot,
    renderThreadOverride: combined ? renderCombinedThread : renderFeedbackThread,
    onOpenFeedback,
    path: entry.file.path,
    activeKey,
    // Unchanged moves keep all published discussions below both source and Markdown views.
    inline: unchangedMove ? [] : combined ? combinedThreads.filter((t) => t.inline).map((t) => t.thread) : inline,
    refresh: refreshThreads,
    replaceThread: discussion.replace,
  });
  const annotations = comments.annotations;
  // Focused sections (#564): which section of the PR's explanation shows each part of this file. One PR's own changes
  // only, at the explanation's head; markers never change the lines shown.
  const explainedSource = useContext(ExplainedChangesContext);
  const explainedMarkers =
    commit || combined || entry.snapshot.comparison
      ? undefined
      : explainedSource?.markersFor(entry.snapshot.url, entry.file.path, entry.snapshot.metadata.headSha);
  const explained = useMemo(
    () => (explainedMarkers?.length && explainedSource ? { markers: explainedMarkers, onOpen: explainedSource.open } : undefined),
    [explainedMarkers, explainedSource]
  );
  const hasInlineDrafts = annotations.some(
    (a) => a.metadata.drafts.length > 0 || a.metadata.brief.length > 0 || a.metadata.composer
  );
  useEffect(() => {
    if (unchangedMove && hasInlineDrafts) setRevealedMove(activeKey);
  }, [activeKey, unchangedMove, hasInlineDrafts]);
  // The rendered diff hosts (one per slice): a jump that arrives after they rendered (cached contents) reveals in them.
  const renderedDiffs = useRef(new Set<HTMLElement>());
  const revealSource = (node: HTMLElement) => {
    for (const host of renderedDiffs.current) if (!host.isConnected) renderedDiffs.current.delete(host);
    renderedDiffs.current.add(node);
    const location = sourceJump.current;
    if (!location || showingPreview) return;
    requestAnimationFrame(() => {
      if (!node.isConnected || currentFile.current !== activeKey || sourceJump.current !== location) return;
      const lines = [...(node.shadowRoot?.querySelectorAll<HTMLElement>('[data-code] [data-line]') ?? [])];
      const target = lines.find(
        (line) =>
          Number(line.dataset.line) >= location.start &&
          Number(line.dataset.line) <= location.end &&
          (unchangedMove || (location.side === 'before') === isBeforeDiffLine(line))
      );
      if (!target) return;
      sourceJump.current = undefined;
      target.scrollIntoView({ block: 'center', behavior: 'instant' });
      // The highlighter may replace line nodes. Keep keyboard focus on its stable host.
      node.tabIndex = -1;
      node.setAttribute('aria-label', `Source at ${location.side === 'before' ? 'old' : 'new'} line ${location.start}`);
      // The stream stops holding the file's top once the line is shown (CommitDiffStream's onFocusCapture).
      node.dataset.jumpTarget = '';
      node.focus({ preventScroll: true });
      delete node.dataset.jumpTarget;
    });
  };
  const options: FileDiffOptions<(typeof annotations)[number]['metadata'], undefined> = {
    preferredHighlighter: DIFF_HIGHLIGHTER,
    enableGutterUtility: comments.canComment && !contents?.lfs,
    onGutterUtilityClick: contents?.lfs ? undefined : comments.begin,
    onLineNumberClick: contents?.lfs
      ? undefined
      : (event) => comments.begin({ start: event.lineNumber, end: event.lineNumber, side: event.annotationSide }),
    theme: diffThemeName(prefs.codeTheme),
    themeType: 'dark',
    diffStyle: entry.file.status === 'added' || entry.file.status === 'deleted' ? 'unified' : layout,
    disableFileHeader: true,
    hunkSeparators: 'simple',
    diffIndicators: appearance.indicators,
    lineDiffType: appearance.inline,
    disableBackground: !appearance.backgrounds,
    disableLineNumbers: !appearance.lineNumbers,
    overflow: appearance.wrap ? 'wrap' : 'scroll',
    enableLineSelection: true,
    onLineSelected: setRange,
    onPostRender: revealSource,
  };
  // The file header is code-tier too: its colours come from the diff's theme (lib/code-palette.ts).
  useLayoutEffect(() => applyCodePalette(options.theme as string), [options.theme]);
  const files: DiffFileInput | undefined = useMemo(
    () =>
      contents &&
      ![contents.before, contents.after].some((side) => side.kind === 'lfs') &&
      (contents.before.kind === 'text' || contents.after.kind === 'text')
        ? ({
            oldFile:
              contents.before.kind === 'text'
                ? { name: entry.file.previousPath ?? entry.file.path, contents: contents.before.content }
                : null,
            newFile:
              contents.after.kind === 'text' ? { name: entry.file.path, contents: contents.after.content } : null,
          } as DiffFileInput)
        : undefined,
    [contents, entry.file.path, entry.file.previousPath]
  );
  const imageSide = (before: boolean): ReviewImageSide => {
    const side = before ? contents?.before : contents?.after;
    return side?.kind === 'image'
      ? {
          status: 'ready',
          dataUrl: side.dataUrl,
          path: (before ? entry.file.previousPath : undefined) ?? entry.file.path,
          revision: before ? entry.snapshot.comparisonBase : entry.snapshot.metadata.headSha,
        }
      : { status: 'absent' };
  };
  function mark(andNext: boolean) {
    // The reader marked a file by hand, and may be going on: files their ticks held open collapse.
    releaseHeld({ except: andNext ? undefined : activeKey });
    setJumpedOpen(false);
    void progress.markFileViewed(activeKey, true);
    if (andNext) onViewedNext?.();
  }
  const ask = (text = '') => onAsk(text);
  const selectedCode = () => {
    if (!range) return '';
    if (preview && shown)
      return `${range.side === 'deletions' ? 'Before' : 'After'} lines ${range.start}–${range.end}:\n${shownSelection(range.side === 'deletions' ? shown.before : shown.after, range.start, range.end)}`;
    if (!contents) return '';
    const side = range.side === 'deletions' ? contents.before : contents.after;
    return side.kind === 'text'
      ? `${range.side === 'deletions' ? 'Before' : 'After'} lines ${range.start}–${range.end}:\n${side.content
          .split('\n')
          .slice(Math.min(range.start, range.end) - 1, Math.max(range.start, range.end))
          .join('\n')}`
      : '';
  };
  function openMarkdownSource(location?: MarkdownLocation) {
    setRevealedMove(activeKey);
    setSourceOverride(activeKey);
    setRange(null);
    if (location) {
      sourceJump.current = location;
      setSourceLocation(location);
    }
  }
  useEffect(() => {
    if (sourceLine || focusThreadId) {
      opened.current = true;
      setJumpedOpen(true);
      if (sourceLine) {
        openMarkdownSource({ side: sourceSide, start: sourceLine, end: Math.max(sourceLine, sourceEndLine ?? sourceLine) });
        // A frame later, after the view scrolls to the selected file.
        const rendered = [...renderedDiffs.current].filter((node) => node.isConnected);
        if (rendered.length) requestAnimationFrame(() => rendered.forEach(revealSource));
      }
    }
  }, [sourceLine, sourceEndLine, sourceSide, activeKey, focusThreadId]);
  function chooseMarkdownMode(mode: 'source' | 'preview') {
    const section = sectionRef.current;
    const top = Math.max(0, section?.closest('.commit-diff-stream')?.getBoundingClientRect().top ?? 0) + 130;
    if (mode === 'source' && showingPreview && section) {
      const anchor = [...section.querySelectorAll<HTMLElement>('[data-md-start]')].find(
        (el) => el.getBoundingClientRect().bottom >= top
      );
      if (anchor) {
        const location: MarkdownLocation = {
          side: anchor.dataset.mdSide === 'before' ? 'before' : 'after',
          start: Number(anchor.dataset.mdStart),
          end: Number(anchor.dataset.mdEnd),
        };
        sourceJump.current = location;
        setSourceLocation(location);
      }
    } else if (mode === 'preview' && code.current) {
      const lines = [...code.current.querySelectorAll('diffs-container')].flatMap((host) => [
        ...(host.shadowRoot?.querySelectorAll<HTMLElement>('[data-code] [data-line]') ?? []),
      ]);
      const bottom = Math.min(
        window.innerHeight,
        section?.closest('.commit-diff-stream')?.getBoundingClientRect().bottom ?? window.innerHeight
      );
      const visible = lines.filter((el) => {
        const bounds = el.getBoundingClientRect();
        return bounds.bottom >= top && bounds.top < bottom;
      });
      const line = visible.at(0);
      if (line) {
        const before = isBeforeDiffLine(line);
        const last = visible.filter((el) => isBeforeDiffLine(el) === before).at(-1) ?? line;
        previewJump.current = {
          side: before ? 'before' : 'after',
          start: Number(line.dataset.line),
          end: Number(last.dataset.line),
        };
      }
    }
    setSourceOverride(undefined);
    setRange(null);
    changeMarkdownView({ mode });
  }
  // In a stack's combined view, the PRs that changed this file and their commits, in the flow above the file's sticky
  // header: they scroll away, so the pinned header is always the one row it is in the flow. A single PR's views name
  // their PR already.
  const fileContext = combined && sourceOptions.length ? (
    <span className="changes-source">
      {sourceOptions.map((source) => {
        const number = source.metadata.url.split('/').pop();
        return (
          <span key={source.metadata.url} className="entity-badge-group">
            <button
              type="button"
              className="entity-badge entity-badge-pr changes-source-pr"
              data-entity-kind="pr"
              title={`Open #${number} · ${source.metadata.title}`}
              onClick={() => onOpenSource?.(source.metadata.url, combinedSourcePath(source.metadata.url))}
            >
              <span className="entity-badge-identity" aria-hidden="true">
                <span className="icon-mask" />
              </span>
              <span className="entity-badge-value">
                <span className="entity-badge-start">#{number}</span>
              </span>
            </button>
            <CommitBadge sha={source.metadata.headSha} repo={source.metadata.headRepo} />
          </span>
        );
      })}
    </span>
  ) : undefined;
  const fileHeader = (
    <>
      {fileContext && <div className="changes-file-context">{fileContext}</div>}
      <DiffFileHeader
        headerRef={headerRef}
        path={entry.file.path}
        previousPath={entry.file.previousPath}
        status={unchangedMove ? 'renamed' : entry.file.status}
        stats={unchangedMove ? 'Moved · contents unchanged' : undefined}
        additions={entry.file.additions}
        deletions={entry.file.deletions}
        noise={unchangedMove ? undefined : quietStat}
        tags={classificationTags}
        actions={
          <>
          {compactMove && !viewed && (
            <Button variant="ghost" size="sm" onClick={() => setRevealedMove(activeKey)}>
              Show file
            </Button>
          )}
          {markdown && !compactMove && (
            <div className="markdown-view-switch" role="group" aria-label="Markdown view">
              <Button
                variant={!wantsPreview ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={!wantsPreview}
                onClick={() => chooseMarkdownMode('source')}
              >
                Source
              </Button>
              <Button
                variant={wantsPreview ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={wantsPreview}
                onClick={() => chooseMarkdownMode('preview')}
              >
                Preview
              </Button>
            </div>
          )}
          <label>
            <input
              type="checkbox"
              checked={viewed}
              onChange={(e) => {
                if (e.target.checked) {
                  mark(false);
                  return;
                }
                // Unviewed by hand: its symbol ticks stay as the reader left them.
                releaseHeld({ only: activeKey });
                void progress.markFileViewed(activeKey, false);
              }}
            />
            Viewed
          </label>
          {onViewedNext && (
            <Button variant="outline" size="sm" data-viewed-next onClick={() => mark(true)}>
              <CheckCheck size={14} aria-hidden="true" />
              <span className="changes-file-action-label">Viewed & next</span>
            </Button>
          )}
          {!commit && !showingPreview && !compactMove && (
            <Button
              variant="ghost"
              size="sm"
              disabled={!range || !comments.canComment || contents?.lfs}
              onClick={() => range && !contents?.lfs && comments.begin(range)}
              title="Select lines in the diff to comment"
            >
              <MessageSquare size={14} /> <span className="changes-file-action-label">Comment</span>
            </Button>
          )}
          {combined && (
            <SearchableSelect
              label="Comment in source PR"
              value=""
              triggerLabel="Comment in PR…"
              popupBoundary="viewport"
              options={commentSources.map((s) => ({
                value: s.metadata.url, kind: 'pr' as const, pr: s.metadata,
                label: `#${s.metadata.url.split('/').pop()} · ${s.metadata.title}`,
              }))}
              onValueChange={(url) => onOpenSource?.(url, combinedSourcePath(url))}
            />
          )}
          {commit && (
            <Button
              variant="ghost"
              size="sm"
              title="Open current file in Changes to comment"
              onClick={() => onOpenCurrentFile(entry.snapshot.url, entry.file.path)}
            >
              Comment in Changes
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="changes-file-ask"
            aria-label="Ask about this"
            title="Ask about this file or selection in chat"
            onClick={() => ask(selectedCode())}
          >
            <Bot size={16} aria-hidden="true" />
          </Button>
          {classificationControl}
          </>
        }
      />
    </>
  );
  const unavailableFocus = focusThreadId && !preview && !files
    ? matching.find(thread => thread.id === focusThreadId && !visibleDiscussions.includes(thread))
    : undefined;
  const fileContent = (
    <div className="changes-code-scroll">
      {!compactMove && (
        <>
          {!contents && !preview && !fileError && (
            <LoadingState compact className="changes-loading" title="Loading file contents…" />
          )}
          {fileError && (
            <div className="changes-empty" role="alert">
              <p>{fileError}</p>
              {!isUnsupportedPreview(fileError) &&
                (preview ? (
                  <p>
                    Could not load more surrounding lines.{' '}
                    <button className="underline" onClick={() => setFileAttempt((n) => n + 1)}>
                      Retry
                    </button>
                  </p>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => setFileAttempt((n) => n + 1)}>
                    Retry
                  </Button>
                ))}
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void window.electronAPI.openExternal(
                    combined
                      ? `https://github.com/${entry.snapshot.metadata.baseRepo}/compare/${entry.snapshot.comparisonBase}...${entry.snapshot.metadata.headSha}`
                      : `${entry.snapshot.url}/files`
                  )
                }
              >
                Open on GitHub <ExternalLink size={14} />
              </Button>
            </div>
          )}
          {lfsSides.length > 0 && (
            <LfsDownload
              pointers={lfsSides.map((side) => side.pointer)}
              busy={lfsDownload?.key === activeKey && lfsDownload.busy}
              error={lfsDownload?.key === activeKey ? lfsDownload.error : undefined}
              onDownload={() => void downloadLfs()}
            />
          )}
          {contents?.lfs && files && (
            <p className="changes-notice">
              Downloaded Git LFS contents. GitHub line comments refer to the pointer file; use the file discussion for
              this resource.
            </p>
          )}
          {wantsPreview && !renderedMarkdown && !lfsSides.length && (
            <div className="markdown-preview-status" role={markdownError?.key === markdownKey ? 'alert' : 'status'}>
              <span>
                {markdownError?.key === markdownKey
                  ? markdownError.message
                  : <LoadingIndicator announce={false}>Preparing rendered view… Source remains available below.</LoadingIndicator>}
              </span>
              {markdownError?.key === markdownKey && (
                <button onClick={() => setMarkdownAttempt((n) => n + 1)}>Retry</button>
              )}
              <button onClick={() => openMarkdownSource()}>Use source</button>
            </div>
          )}
          {showingPreview && (
            <MarkdownReviewPreview
              key={markdownKey}
              review={renderedMarkdown}
              revealLocation={previewJump.current}
              showChanges={markdownView.changes}
              onChanges={(changes) => changeMarkdownView({ changes })}
              onSource={openMarkdownSource}
              onAsk={ask}
              canComment={!commit && comments.canComment && !contents?.lfs}
              annotations={annotations.map((annotation) => ({
                ...annotation,
                content: comments.renderAnnotation(annotation),
              }))}
            />
          )}
          {!showingPreview && (
            <div ref={code} className="changes-code">
              <ReviewSelectionActions containerRef={code} resetKey={activeKey} onAsk={ask} path={entry.file.path} />
              {parts && !unchangedMove && (
                <ChangesDiff
                  key={activeKey}
                  parts={parts}
                  file={{ name: entry.file.path, prevName: entry.file.previousPath, status: entry.file.status }}
                  layout={layout}
                  options={options}
                  annotations={annotations}
                  renderAnnotation={comments.renderAnnotation}
                  status={model.gapStatus}
                  onReveal={gaps ? (part, direction) => revealLines(part.gap, direction) : undefined}
                  scopes={model.scopes}
                  structure={model.structure}
                  scopeNote={model.scopeNote}
                  scopeAt={model.scopeAt}
                  onShowDefinition={model.showDefinition}
                  rails={model.rails}
                  onCollapseScope={model.collapseScope}
                  noise={model.noise}
                  moves={model.moves}
                  explained={explained}
                  outline={{
                    quiet: model.quietSymbols,
                    symbols: model.symbols,
                    pending: model.outlinePending,
                    fileKey: activeKey,
                    fileName: entry.file.path.slice(entry.file.path.lastIndexOf('/') + 1),
                    fileViewed: viewed,
                    onMarkFileViewed: () => mark(false),
                  }}
                  stickyUnder={headerRef}
                  symbolKey={symbolTree ? activeKey : undefined}
                  autoView={symbolTree ? autoView : undefined}
                  changedLines={model.changedLines}
                  onRetry={model.retry}
                  target={sourceLocation ? { side: sourceLocation.side, line: sourceLocation.start } : undefined}
                  lineCount={lineCount}
                />
              )}
              {unchangedMove && contents?.after.kind === 'text' && (
                <File
                  file={{ name: entry.file.path, contents: contents.after.content }}
                  lineAnnotations={annotations
                    .filter((a) => a.metadata.drafts.length > 0 || a.metadata.brief.length > 0 || a.metadata.composer)
                    .map((a) => ({ ...a, metadata: { ...a.metadata, threads: [] } }))}
                  renderAnnotation={(annotation) => comments.renderAnnotation({ ...annotation, side: 'additions' })}
                  options={{
                    preferredHighlighter: DIFF_HIGHLIGHTER,
                    theme: options.theme,
                    themeType: options.themeType,
                    disableFileHeader: true,
                    disableLineNumbers: options.disableLineNumbers,
                    overflow: options.overflow,
                    enableLineSelection: true,
                    onLineSelected: setRange,
                    enableGutterUtility: comments.canComment && !contents.lfs,
                    onGutterUtilityClick: contents.lfs ? undefined : comments.begin,
                    onLineNumberClick: contents.lfs
                      ? undefined
                      : (event) =>
                          comments.begin({ start: event.lineNumber, end: event.lineNumber, side: 'additions' }),
                    onPostRender: revealSource,
                  }}
                  style={
                    {
                      '--diffs-font-family': 'var(--font-mono)',
                      '--diffs-font-size': 'var(--type-code)',
                      '--diffs-line-height': 'var(--leading-code)',
                    } as CSSProperties
                  }
                />
              )}
              {contents &&
                !lfsSides.length &&
                (contents.before.kind === 'image' || contents.after.kind === 'image') && (
                  <ReviewImageDiff
                    enabled
                    filePath={entry.file.path}
                    comparison={{ before: imageSide(true), after: imageSide(false) }}
                  />
                )}
            </div>
          )}
        </>
      )}
      {combinedDiscussion?.failures.map((failure) => (
        <p className="changes-notice" role="status" key={failure.url}>
          Comments from PR #{failure.url.split('/').pop()} are unavailable. Some discussions may be missing.
          <button
            aria-label={`Retry comments for PR #${failure.url.split('/').pop()}`}
            onClick={() => void refreshThreads(failure.url)}
          >
            Retry comments
          </button>
        </p>
      ))}
      {!combined && !renderFeedbackThread && threadError && (
        <p className="changes-notice">
          {threadError}
          <button onClick={() => void refreshThreads(entry.snapshot.url)}>Retry</button>
        </p>
      )}
      {unavailableFocus && renderFeedbackThread && <section className="changes-other-threads">
        <h3>Code feedback</h3>
        <p>The file preview is unavailable. You can still address this conversation.</p>
        {unavailableFocus.comments[0]?.diffHunk && <pre className="feedback-code" aria-label="Code when commented">{unavailableFocus.comments[0].diffHunk}</pre>}
        {renderFeedbackThread(unavailableFocus)}
      </section>}
      {!!visibleDiscussions.length && (
        <section className="changes-other-threads">
          <h3>{unchangedMove ? 'Discussions on this file' : 'Other discussions on this file'}</h3>
          {!unchangedMove && <p>These comments refer to a different revision or no longer have an inline location.</p>}
          {visibleDiscussions.map(comments.renderThread)}
        </section>
      )}
    </div>
  );
  return (
    <section
      ref={sectionRef}
      className="commit-stream-file"
      aria-label={entry.file.path}
      data-code-theme={options.theme as string}
      data-markdown-switch={markdown && !compactMove ? '' : undefined}
    >
      {fileHeader}
      {!commit && comments.feedback}
      {/* Keep editor state and pending-write guards alive when the file collapses. */}
      <div className="commit-stream-file-body" hidden={collapsed}>
        {opened.current && fileContent}
      </div>
    </section>
  );
}
