import { DIFF_HIGHLIGHTER } from '../lib/diff-highlighter';
import { stackFileProgressKey, stackFileSourcePath, stackFileDiscussions } from '../lib/stack-changes';
import { GitHubReviewThread } from './GitHubReviewThread';
import { SearchableSelect } from './SearchableSelect';
import { isMarkdownFile, type MarkdownReview, type MarkdownLocation } from '../lib/markdown-review';
import { useMarkdownView } from '../lib/use-markdown-view';
import { peekMarkdownReview, prepareMarkdownReview } from '../lib/markdown-review-cache';
import { MarkdownReviewPreview } from './MarkdownReviewPreview';
import { RepositoryBadge, PrBadge, CommitBadge } from './EntityBadge';
import { useEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { File, FileDiff, MultiFileDiff } from '@pierre/diffs/react';
import type { DiffFileInput, FileDiffOptions, SelectedLineRange } from '@pierre/diffs';
import { MessageSquare, ExternalLink } from 'lucide-react';
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
import { diffContextLines } from '../lib/review-diff';
import { prPreviewSelection } from '../lib/pr-change-preview';
import { CODE_THEMES } from '../lib/constants';
import type { Preferences } from '../lib/types';
import type { usePrDiscussions } from '../lib/use-pr-discussions';
import type { ReviewImageSide } from '../lib/review-images';
import { briefCode, briefPin, type AgentBriefLocation } from '../lib/agent-brief';
import type { ReviewSubject } from '../lib/workbench';
import { useChangesComments } from './useChangesComments';
import { DiffStats } from './DiffStats';
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
  sourceLine,
  sourceSide = 'after',
  onOpenSource,
  briefSubject,
  onOpenBrief,
}: {
  entry: ChangeFileEntry;
  sourceLine?: number;
  sourceSide?: 'before' | 'after';
  /** The stack or PR whose agent brief collects comments made here. */
  briefSubject?: ReviewSubject;
  onOpenBrief?: () => void;
  onOpenSource?: (url: string, path: string) => void;
  classificationControl?: ReactNode;
  preferences: Preferences;
  discussion: ReturnType<typeof usePrDiscussions>;
  onViewedNext: () => void;
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
  const collapsed = viewed && !jumpedOpen;
  const opened = useRef(!collapsed);
  if (!collapsed) opened.current = true;
  const appearance = useDiffAppearance(prefs.diffAppearance);
  const markdown = isMarkdownFile(entry.file.path);
  const [markdownView, changeMarkdownView] = useMarkdownView();
  const [sourceOverride, setSourceOverride] = useState<string>();
  const [sourceLocation, setSourceLocation] = useState<MarkdownLocation>();
  const sourceJump = useRef<MarkdownLocation | undefined>(undefined);
  const previewJump = useRef<MarkdownLocation | undefined>(undefined);
  const sectionRef = useRef<HTMLElement>(null);
  const [markdownResult, setMarkdownResult] = useState<{ key: string; value: MarkdownReview }>();
  const [markdownError, setMarkdownError] = useState<{ key: string; message: string }>();
  const [markdownAttempt, setMarkdownAttempt] = useState(0);
  const [revealedMove, setRevealedMove] = useState<string>();
  const contextLines = sourceLocation ? Number.MAX_SAFE_INTEGER : diffContextLines(appearance);
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
    const measure = () =>
      section.style.setProperty('--markdown-header-height', `${header.getBoundingClientRect().height}px`);
    measure();
    const observer = new ResizeObserver(measure);
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
  const preview = useMemo(() => previewFor(activeKey, entry.file, contextLines), [activeKey, entry.file, contextLines]);
  const contents = fileCache.peek(request) ?? (loadedFile?.key === activeKey ? loadedFile.data : undefined);
  const unchangedMove = useMemo(() => isUnchangedMove(entry.file, contents), [entry.file, contents]);
  const compactMove = unchangedMove && revealedMove !== activeKey;
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
    if (
      contents ||
      (!markdown && preview && (contextLines <= 3 || entry.file.status === 'added' || entry.file.status === 'deleted'))
    )
      return;
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
  }, [activeKey, fileAttempt, contextLines, collapsed]);
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
        <Button variant="link" size="sm" onClick={() => source && onOpenSource?.(source.metadata.url, thread.path)}>
          PR #{source?.metadata.url.split('/').pop()} · Open to reply
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
      : preview
        ? prPreviewSelection(preview, { start: line, end: line, side: previewSide }).replace(/^\d+: /, '')
        : '';
  const briefLineCode = ({ line, startLine, side, startSide }: AgentBriefLocation) => {
    const start = startLine ?? line;
    // Only the ends of a two-sided region are known here. The agent has the diff for what lies between.
    if (startSide)
      return briefCode(
        `old ${start}: ${sideLine(contents?.before, 'deletions', start)}\nnew ${line}: ${sideLine(contents?.after, 'additions', line)}`
      );
    const text = contents && (side === 'LEFT' ? contents.before : contents.after);
    if (text?.kind === 'text') return briefCode(text.content.split('\n').slice(start - 1, line).join('\n'));
    if (!preview) return {};
    const selected = prPreviewSelection(preview, { start, end: line, side: side === 'LEFT' ? 'deletions' : 'additions' });
    // A partial patch prefixes each line with its number. The comment already says which lines these are.
    return briefCode(preview.isPartial ? selected.replace(/^\d+: /gm, '') : selected);
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
    renderThreadOverride: combined ? renderCombinedThread : undefined,
    path: entry.file.path,
    activeKey,
    // Unchanged moves keep all published discussions below both source and Markdown views.
    inline: unchangedMove ? [] : combined ? combinedThreads.filter((t) => t.inline).map((t) => t.thread) : inline,
    refresh: refreshThreads,
    replaceThread: discussion.replace,
  });
  const annotations = comments.annotations;
  const hasInlineDrafts = annotations.some(
    (a) => a.metadata.drafts.length > 0 || a.metadata.brief.length > 0 || a.metadata.composer
  );
  useEffect(() => {
    if (unchangedMove && hasInlineDrafts) setRevealedMove(activeKey);
  }, [activeKey, unchangedMove, hasInlineDrafts]);
  const revealSource = (node: HTMLElement) => {
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
      node.focus({ preventScroll: true });
    });
  };
  const options: FileDiffOptions<(typeof annotations)[number]['metadata'], undefined> = {
    preferredHighlighter: DIFF_HIGHLIGHTER,
    enableGutterUtility: comments.canComment && !contents?.lfs,
    onGutterUtilityClick: contents?.lfs ? undefined : comments.begin,
    onLineNumberClick: contents?.lfs
      ? undefined
      : (event) => comments.begin({ start: event.lineNumber, end: event.lineNumber, side: event.annotationSide }),
    theme: `gnosis-${CODE_THEMES.some((t) => t.id === prefs.codeTheme) ? prefs.codeTheme : 'github-dark'}`,
    themeType: 'dark',
    diffStyle: entry.file.status === 'added' || entry.file.status === 'deleted' ? 'unified' : prefs.diffLayout,
    disableFileHeader: true,
    collapsedContextThreshold: 0,
    parseDiffOptions,
    hunkSeparators: 'line-info',
    diffIndicators: appearance.indicators,
    lineDiffType: appearance.inline,
    disableBackground: !appearance.backgrounds,
    disableLineNumbers: !appearance.lineNumbers,
    overflow: appearance.wrap ? 'wrap' : 'scroll',
    enableLineSelection: true,
    onLineSelected: setRange,
    onPostRender: revealSource,
    loadDiffFiles: async () => {
      try {
        if (alive.current && currentFile.current === activeKey) setFileError('');
        const value = await fileCache.read(request);
        if (value.before.kind !== 'text' || value.after.kind !== 'text')
          throw new Error('Full text context is unavailable for this file.');
        return {
          oldFile: { name: entry.file.previousPath ?? request.path, contents: value.before.content },
          newFile: { name: request.path, contents: value.after.content },
        };
      } catch (error) {
        if (alive.current && currentFile.current === activeKey)
          setFileError(error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
  };
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
    setJumpedOpen(false);
    void progress.markFileViewed(activeKey, true);
    if (andNext) onViewedNext();
  }
  const ask = (text = '') => onAsk(text);
  const selectedCode = () => {
    if (!range) return '';
    if (preview)
      return `${range.side === 'deletions' ? 'Before' : 'After'} lines ${range.start}–${range.end}:\n${prPreviewSelection(preview, range)}`;
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
    if (sourceLine) {
      opened.current = true;
      setJumpedOpen(true);
      openMarkdownSource({ side: sourceSide, start: sourceLine, end: sourceLine });
    }
  }, [sourceLine, sourceSide, activeKey]);
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
  const fileHeader = (
    <header className="changes-file-header">
      <div>
        {!commit && !combined && (
          <span className="changes-source">
            <RepositoryBadge repo={entry.snapshot.metadata.baseRepo} />{' '}
            <PrBadge url={entry.snapshot.url} title={entry.snapshot.metadata.title} />{' '}
            <CommitBadge sha={entry.snapshot.metadata.headSha} repo={entry.snapshot.metadata.headRepo} />
          </span>
        )}
        {combined && (
          <span className="changes-source">
            <span>Combined changes</span>
            {sourceOptions.slice(0, 3).map((source) => (
              <Button
                key={source.metadata.url}
                size="sm"
                variant="link"
                onClick={() => onOpenSource?.(source.metadata.url, combinedSourcePath(source.metadata.url))}
              >
                #{source.metadata.url.split('/').pop()}
              </Button>
            ))}
            {sourceOptions.length > 3 && <span>+{sourceOptions.length - 3} PRs</span>}
          </span>
        )}
        <h2 title={entry.file.path}>
          {entry.file.previousPath && <span>{entry.file.previousPath} → </span>}
          {entry.file.path}
        </h2>
        <span className="changes-file-stats">
          {unchangedMove ? (
            'Moved · contents unchanged'
          ) : (
            <>
              {entry.file.status} · <DiffStats additions={entry.file.additions} deletions={entry.file.deletions} />
            </>
          )}
        </span>
      </div>
      <div className="changes-file-actions">
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
        {classificationControl}
        <label>
          <input
            type="checkbox"
            checked={viewed}
            onChange={(e) => (e.target.checked ? mark(false) : void progress.markFileViewed(activeKey, false))}
          />
          Viewed
        </label>
        <Button variant="outline" size="sm" data-viewed-next onClick={() => mark(true)}>
          Viewed & next
        </Button>
        {!commit && !showingPreview && !compactMove && (
          <Button
            variant="ghost"
            size="sm"
            disabled={!range || !comments.canComment || contents?.lfs}
            onClick={() => range && !contents?.lfs && comments.begin(range)}
            title="Select lines in the diff to comment"
          >
            <MessageSquare size={14} /> Comment
          </Button>
        )}
        {combined && (
          <SearchableSelect
            label="Comment in source PR"
            value=""
            triggerLabel="Comment in PR…"
            popupBoundary="viewport"
            options={commentSources.map((s) => ({
              value: s.metadata.url,
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
        <Button variant="ghost" size="sm" onClick={() => ask(selectedCode())}>
          <MessageSquare size={14} />
          Ask about this
        </Button>
      </div>
    </header>
  );
  const fileContent = (
    <div className="changes-code-scroll">
      {!compactMove && (
        <>
          {!contents && !preview && !fileError && (
            <div className="changes-loading" role="status">
              Loading file contents…
            </div>
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
                  : 'Preparing rendered view… Source remains available below.'}
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
              <ReviewSelectionActions containerRef={code} resetKey={activeKey} onAsk={ask} />
              {preview && !unchangedMove && !(contextLines > 3 && files) && (
                <FileDiff
                  key={activeKey}
                  fileDiff={preview}
                  options={options}
                  lineAnnotations={annotations}
                  renderAnnotation={comments.renderAnnotation}
                  style={
                    {
                      '--diffs-font-family': 'var(--font-mono)',
                      '--diffs-font-size': 'var(--type-code)',
                      '--diffs-line-height': 'var(--leading-code)',
                    } as CSSProperties
                  }
                />
              )}
              {files && !unchangedMove && (!preview || contextLines > 3) && (
                <MultiFileDiff
                  key={activeKey}
                  {...files}
                  options={options}
                  lineAnnotations={annotations}
                  renderAnnotation={comments.renderAnnotation}
                  style={
                    {
                      '--diffs-font-family': 'var(--font-mono)',
                      '--diffs-font-size': 'var(--type-code)',
                      '--diffs-line-height': 'var(--leading-code)',
                    } as CSSProperties
                  }
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
      {!combined && threadError && (
        <p className="changes-notice">
          {threadError}
          <button onClick={() => void refreshThreads(entry.snapshot.url)}>Retry</button>
        </p>
      )}
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
    <section ref={sectionRef} className="commit-stream-file" aria-label={entry.file.path}>
      {fileHeader}
      {!commit && comments.feedback}
      {/* Keep editor state and pending-write guards alive when the file collapses. */}
      <div className="commit-stream-file-body" hidden={collapsed}>
        {opened.current && fileContent}
      </div>
    </section>
  );
}
