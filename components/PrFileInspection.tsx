import { RepositoryBadge, PrBadge, CommitBadge } from './EntityBadge';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { FileDiff, MultiFileDiff } from '@pierre/diffs/react';
import type { DiffFileInput, FileDiffOptions, SelectedLineRange } from '@pierre/diffs';
import { MessageSquare, ExternalLink } from 'lucide-react';
import { inspectionFiles as fileCache, previewFor } from '../lib/inspection-cache';
import { fileRevisionKey, type PrChanges, type PrChangeFile, type PrFileContents } from '../lib/pr-changes';
import { useFileProgress } from '../lib/file-view-progress';
import { useDiffAppearance } from '../lib/use-diff-appearance';
import { diffContextLines } from '../lib/review-diff';
import { prPreviewSelection } from '../lib/pr-change-preview';
import { CODE_THEMES } from '../lib/constants';
import type { Preferences } from '../lib/types';
import type { usePrDiscussions } from '../lib/use-pr-discussions';
import type { ReviewImageSide } from '../lib/review-images';
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
  `${entry.snapshot.comparison ? 'commit:' : ''}${fileRevisionKey(entry.snapshot.url, entry.file.path, entry.snapshot.metadata.baseSha, entry.snapshot.metadata.headSha)}`;
// Electron preserves messages across IPC, but not custom Error types.
const isUnsupportedPreview = (message: string) =>
  /This file is too large to preview|This binary file has no text preview|This file is not UTF-8 text/.test(message);

/** One revision's file preview and discussions. The workspace owns navigation and shared data. */
export function PrFileInspection({
  entry,
  preferences: prefs,
  discussion,
  onViewedNext,
  onAsk,
  onOpenCurrentFile,
}: {
  entry: ChangeFileEntry;
  preferences: Preferences;
  discussion: ReturnType<typeof usePrDiscussions>;
  onViewedNext: () => void;
  onAsk: (text: string) => void;
  onOpenCurrentFile?: (url: string, path: string) => void;
}) {
  const commit = !!onOpenCurrentFile;
  const activeKey = changeFileKey(entry);
  const progress = useFileProgress();
  const viewed = progress.isFileViewed(activeKey);
  const opened = useRef(!viewed);
  if (!viewed) opened.current = true;
  const appearance = useDiffAppearance(prefs.diffAppearance);
  const contextLines = diffContextLines(appearance);
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
  const request = {
    url: entry.snapshot.url,
    path: entry.file.path,
    baseSha: entry.snapshot.metadata.baseSha,
    headSha: entry.snapshot.metadata.headSha,
    comparison: entry.snapshot.comparison,
  };
  const preview = useMemo(() => previewFor(activeKey, entry.file, contextLines), [activeKey, entry.file, contextLines]);
  const contents = fileCache.peek(request) ?? (loadedFile?.key === activeKey ? loadedFile.data : undefined);
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
    if (viewed) return;
    let cancelled = false;
    setLoadedFile((previous) => (previous?.key === activeKey ? previous : undefined));
    setRange(null);
    setFileError('');
    if (
      contents ||
      (preview && (contextLines <= 3 || entry.file.status === 'added' || entry.file.status === 'deleted'))
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
  }, [activeKey, fileAttempt, contextLines, viewed]);
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
  const other = matching.filter((t) => !inline.includes(t));
  const refreshThreads = discussion.refresh;
  const comments = useChangesComments({
    enabled: !commit,
    snapshot: commit ? undefined : entry.snapshot,
    path: entry.file.path,
    activeKey,
    inline,
    refresh: refreshThreads,
    replaceThread: discussion.replace,
  });
  const annotations = comments.annotations;
  const options: FileDiffOptions<(typeof annotations)[number]['metadata'], undefined> = {
    enableGutterUtility: comments.writable && !contents?.lfs,
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
    progress.markFileViewed(activeKey, true);
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
  const fileHeader = (
    <header className="changes-file-header">
      <div>
        {!commit && (
          <span className="changes-source">
            <RepositoryBadge repo={entry.snapshot.metadata.baseRepo} /> <PrBadge url={entry.snapshot.url} title={entry.snapshot.metadata.title} /> <CommitBadge sha={entry.snapshot.metadata.headSha} repo={entry.snapshot.metadata.headRepo} />
          </span>
        )}
        <h2 title={entry.file.path}>
          {entry.file.previousPath && <span>{entry.file.previousPath} → </span>}
          {entry.file.path}
        </h2>
        <span className="changes-file-stats">
          {entry.file.status} · <DiffStats additions={entry.file.additions} deletions={entry.file.deletions} />
        </span>
      </div>
      <div className="changes-file-actions">
        <label>
          <input
            type="checkbox"
            checked={viewed}
            onChange={(e) => (e.target.checked ? mark(false) : progress.markFileViewed(activeKey, false))}
          />
          Viewed
        </label>
        <Button variant="outline" size="sm" data-viewed-next onClick={() => mark(true)}>
          Viewed & next
        </Button>
        {!commit && (
          <Button
            variant="ghost"
            size="sm"
            disabled={!range || !comments.writable || contents?.lfs}
            onClick={() => range && !contents?.lfs && comments.begin(range)}
            title="Select lines in the diff to comment"
          >
            <MessageSquare size={14} /> Comment
          </Button>
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
            onClick={() => void window.electronAPI.openExternal(`${entry.snapshot.url}/files`)}
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
          Downloaded Git LFS contents. GitHub line comments refer to the pointer file; use the file discussion for this
          resource.
        </p>
      )}
      <div ref={code} className="changes-code">
        <ReviewSelectionActions containerRef={code} resetKey={activeKey} onAsk={ask} />
        {preview && !(contextLines > 3 && files) && (
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
        {files && (!preview || contextLines > 3) && (
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
        {contents && !lfsSides.length && (contents.before.kind === 'image' || contents.after.kind === 'image') && (
          <ReviewImageDiff
            enabled
            filePath={entry.file.path}
            comparison={{ before: imageSide(true), after: imageSide(false) }}
          />
        )}
      </div>
      {threadError && (
        <p className="changes-notice">
          {threadError}
          <button onClick={() => void refreshThreads(entry.snapshot.url)}>Retry</button>
        </p>
      )}
      {!!other.length && (
        <section className="changes-other-threads">
          <h3>Other discussions on this file</h3>
          <p>These comments refer to a different revision or no longer have an inline location.</p>
          {other.map(comments.renderThread)}
        </section>
      )}
    </div>
  );
  return (
    <section className="commit-stream-file" aria-label={entry.file.path}>
      {fileHeader}
      {!commit && comments.feedback}
      {/* Keep editor state and pending-write guards alive when the file collapses. */}
      <div className="commit-stream-file-body" hidden={viewed}>
        {opened.current && fileContent}
      </div>
    </section>
  );
}
