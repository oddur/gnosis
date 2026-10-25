import { useDiffAppearance } from '../lib/use-diff-appearance';
import { DiffStats } from './DiffStats';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  inspectionFiles as fileCache,
  fileIsReady,
  prepareFile,
  prefetchInspection,
  commitPositionId,
  previewFor,
  inspectionData,
} from '../lib/inspection-cache';
import { prPreviewSelection } from '../lib/pr-change-preview';
import { FileDiff, MultiFileDiff } from '@pierre/diffs/react';
import type { DiffFileInput, FileDiffOptions, SelectedLineRange } from '@pierre/diffs';
import {
  ChevronDown,
  ChevronRight,
  PanelLeft,
  ArrowLeft,
  ArrowRight,
  RefreshCw,
  MessageSquare,
  ExternalLink,
} from 'lucide-react';
import { ChangesFileTree } from './ChangesFileTree';
import { DiffAppearanceMenu } from './DiffAppearanceMenu';
import { useChangesComments } from './useChangesComments';
import { ReviewImageDiff } from './ReviewImageDiff';
import { ReviewSelectionActions } from './ReviewSelectionActions';
import { PrFileChat } from './PrFileChat';
import { Button } from './ui/button';
import { CODE_THEMES } from '../lib/constants';
import { diffContextLines } from '../lib/review-diff';
import {
  changesRevision,
  fileRevisionKey,
  type PrChanges,
  type PrChangeFile,
  type PrFileContents,
} from '../lib/pr-changes';
import { registerChangeProgress, useFileProgress } from '../lib/file-view-progress';
import type { ReviewSubject } from '../lib/workbench';
import type { Preferences } from '../lib/types';
import { usePrDiscussions } from '../lib/use-pr-discussions';
import type { ReviewImageSide } from '../lib/review-images';

interface Entry {
  key: string;
  snapshot: PrChanges;
  file: PrChangeFile;
}
interface Position {
  selected: string;
  scroll: Record<string, number>;
}
const positions = new Map<string, Position>();
function loadPosition(id: string): Position {
  let saved: Position | undefined = positions.get(id);
  if (!saved) {
    try {
      saved =
        (JSON.parse(localStorage.getItem(`gnosis-changes-position:${id}`) ?? 'null') as Position | null) ?? undefined;
    } catch {
      /* Optional. */
    }
    if (!saved || typeof saved.selected !== 'string' || typeof saved.scroll !== 'object')
      saved = { selected: '', scroll: {} };
    positions.set(id, saved);
  }
  return saved;
}
const viewKey = (e: Entry) =>
  `${e.snapshot.comparison ? 'commit:' : ''}${fileRevisionKey(e.snapshot.url, e.file.path, e.snapshot.metadata.baseSha, e.snapshot.metadata.headSha)}`;

export interface CommitWorkspace {
  snapshot?: PrChanges;
  sidebar: ReactNode;
  header: ReactNode;
  status: ReactNode;
  tools: ReactNode;
  fileStatus: string;
  filesOpen: boolean;
  toggleFiles: () => void;
  onOpenCurrentFile: (url: string, path: string) => void;
}
export function PrChangesView({
  subject,
  preferences,
  commit,
  initialFile,
}: {
  subject: ReviewSubject;
  preferences: Preferences;
  commit?: CommitWorkspace;
  initialFile?: { url: string; path: string };
}) {
  const positionId = commit ? commitPositionId(subject.id, commit.snapshot) : subject.id;
  const [position] = useState(() => loadPosition(positionId));
  const [loadedSnapshots, setSnapshots] = useState<PrChanges[]>(() => subject.members.flatMap(member =>
    inspectionData.peekChanges(member) ?? []));
  const snapshots = useMemo(
    () => (commit ? (commit.snapshot ? [commit.snapshot] : []) : loadedSnapshots),
    [commit?.snapshot, !!commit, loadedSnapshots]
  );
  const [selected, setSelected] = useState(position.selected);
  const [openingFile, setOpeningFile] = useState('');
  const [navigationError, setNavigationError] = useState<{ key: string; message: string }>();
  const fileNavigation = useRef(0);
  const hoverCancel = useRef<() => void>(() => {});
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [newer, setNewer] = useState(false),
    [checkError, setCheckError] = useState('');
  const [query, setQuery] = useState(''),
    [unviewed, setUnviewed] = useState(false),
    [treeOpen, setTreeOpen] = useState(true);
  const [treeWidth, setTreeWidth] = useState(() => {
    try {
      return Math.max(180, Math.min(500, Number(localStorage.getItem('gnosis-changes-tree-width')) || 270));
    } catch {
      return 270;
    }
  });
  const [prefs, setPrefs] = useState(preferences),
    [preferenceError, setPreferenceError] = useState('');
  const appearance = useDiffAppearance(prefs.diffAppearance);
  const contextLines = diffContextLines(appearance);
  const parseDiffOptions = useMemo(() => ({ context: contextLines }), [contextLines]);
  const writes = useRef(Promise.resolve());
  useEffect(
    () =>
      setPrefs((p) => ({
        ...p,
        provider: preferences.provider,
        model: preferences.model,
        codeTheme: preferences.codeTheme,
      })),
    [preferences.provider, preferences.model, preferences.codeTheme]
  );
  const progress = useFileProgress();
  const [loadedFile, setLoadedFile] = useState<{ key: string; data: PrFileContents }>(),
    [fileError, setFileError] = useState(''),
    [fileAttempt, setFileAttempt] = useState(0);
  const discussion = usePrDiscussions(commit ? [] : subject.members.map((member) => member.url));
  const [chatOpen, setChatOpen] = useState(false),
    [selection, setSelection] = useState('');
  const [range, setRange] = useState<SelectedLineRange | null>(null);
  const viewport = useRef<HTMLDivElement>(null),
    code = useRef<HTMLDivElement>(null);
  const alive = useRef(true),
    generation = useRef(0);
  const persist = () => {
    try {
      localStorage.setItem(`gnosis-changes-position:${positionId}`, JSON.stringify(position));
    } catch {
      /* Session position remains. */
    }
  };
  async function load(refresh: boolean) {
    if (commit) return;
    const current = ++generation.current;
    setLoading(refresh || !loadedSnapshots.length);
    setError('');
    try {
      const next: PrChanges[] = [];
      for (const member of subject.members) {
        const snapshot = await inspectionData.readChanges(member, refresh);
        registerChangeProgress(snapshot);
        next.push(snapshot);
      }
      if (!alive.current || current !== generation.current) return;
      setSnapshots(next);
      if (refresh) setNewer(false);
      setCheckError('');
    } catch (e) {
      if (alive.current && current === generation.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current && current === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    if (loadedSnapshots.length === subject.members.length) loadedSnapshots.forEach(registerChangeProgress);
    else void load(false);
    return () => {
      alive.current = false;
      generation.current++;
      fileNavigation.current++;
      hoverCancel.current();
    };
  }, [subject.id]);
  const revision = snapshots.map((s) => `${s.url}:${changesRevision(s.metadata)}`).join('|');
  useEffect(() => {
    if (commit || !snapshots.length) return;
    let cancelled = false;
    const check = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        for (const snapshot of snapshots) {
          const current = await window.electronAPI.checkPrChanges(snapshot.url);
          if (!cancelled && changesRevision(current) !== changesRevision(snapshot.metadata)) setNewer(true);
        }
        if (!cancelled) setCheckError('');
      } catch {
        if (!cancelled) setCheckError('Could not check for new commits. Showing the saved version.');
      }
    };
    void check();
    const timer = setInterval(() => void check(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [revision]);
  const entries = useMemo<Entry[]>(
    () =>
      snapshots.flatMap((snapshot, index) => {
        const prefix =
          subject.kind === 'stack' && !commit
            ? `${String(index + 1).padStart(2, '0')} · ${snapshot.metadata.baseRepo?.replace('/', ' · ') ?? 'PR'} #${snapshot.url.split('/').pop()}/`
            : '';
        return [...snapshot.files]
          .sort((a, b) => a.path.localeCompare(b.path))
          .map((file) => ({ key: prefix + file.path, snapshot, file }));
      }),
    [snapshots, subject.kind, !!commit]
  );
  const entry =
    entries.find((e) => e.key === selected) ?? entries.find((e) => !progress.isFileViewed(viewKey(e))) ?? entries.at(0);
  const activeKey = entry ? viewKey(entry) : '';
  const currentFile = useRef(activeKey);
  currentFile.current = activeKey;
  const request = entry
    ? {
        url: entry.snapshot.url,
        path: entry.file.path,
        baseSha: entry.snapshot.metadata.baseSha,
        headSha: entry.snapshot.metadata.headSha,
        comparison: entry.snapshot.comparison,
      }
    : null;
  const preview = useMemo(
    () => (entry ? previewFor(activeKey, entry.file, contextLines) : undefined),
    [activeKey, entry?.file, contextLines]
  );
  const contents =
    (request ? fileCache.peek(request) : undefined) ?? (loadedFile?.key === activeKey ? loadedFile.data : undefined);
  const visible = entries.filter((e) => !unviewed || !progress.isFileViewed(viewKey(e)));
  const viewedSignature = visible.map((e) => (progress.isFileViewed(viewKey(e)) ? '1' : '0')).join('');
  const treeEntries = useMemo(
    () =>
      visible.map((e) => ({
        key: e.key,
        status: e.file.status,
        viewed: progress.isFileViewed(viewKey(e)),
        additions: e.file.additions,
        deletions: e.file.deletions,
        commentCount: discussion.discussions[e.snapshot.url]?.data?.threads
          .filter((t) => t.path === e.file.path || t.path === e.file.previousPath)
          .reduce((total, thread) => total + thread.comments.length, 0),
        commentError: !!discussion.discussions[e.snapshot.url]?.error,
      })),
    [entries, unviewed, viewedSignature, discussion.discussions]
  );
  useEffect(() => {
    if (!initialFile) return;
    const match = entries.find(
      (e) =>
        e.snapshot.url === initialFile.url &&
        (e.file.path === initialFile.path || e.file.previousPath === initialFile.path)
    );
    if (match) select(match.key);
    else if (snapshots.length)
      setError(`“${initialFile.path}” is not in the current PR changes. Choose another file to comment on.`);
  }, [initialFile, entries]);
  // Keep selection/scroll independent of tabs, queue navigation, and background discovery.
  function warmFile(key: string) {
    const target = entries.find((e) => e.key === key);
    if (!target) return () => {};
    if (
      contextLines > 3 &&
      target.file.status === 'modified' &&
      !fileCache.peek({
        url: target.snapshot.url,
        path: target.file.path,
        baseSha: target.snapshot.metadata.baseSha,
        headSha: target.snapshot.metadata.headSha,
        comparison: target.snapshot.comparison,
      })
    ) {
      return prefetchInspection(viewKey(target), () =>
        fileCache.read(
          {
            url: target.snapshot.url,
            path: target.file.path,
            baseSha: target.snapshot.metadata.baseSha,
            headSha: target.snapshot.metadata.headSha,
            comparison: target.snapshot.comparison,
          },
          true
        )
      );
    }
    if (fileIsReady(target.snapshot, target.file)) return () => {};
    return prefetchInspection(viewKey(target), () => prepareFile(target.snapshot, target.file, true));
  }
  useEffect(() => {
    if (!entry) return;
    const index = entries.indexOf(entry);
    const cancel = [index + 1, index + 2, index - 1].flatMap((i) => (entries[i] ? [warmFile(entries[i].key)] : []));
    return () => cancel.forEach((stop) => stop());
  }, [activeKey, entries, contextLines]);
  function select(key: string) {
    const target = entries.find((e) => e.key === key);
    if (!target) return;
    const id = ++fileNavigation.current;
    setNavigationError(undefined);
    if (fileIsReady(target.snapshot, target.file)) {
      setOpeningFile('');
      applySelection(key);
      return;
    }
    setOpeningFile(key);
    void prepareFile(target.snapshot, target.file)
      .then(() => {
        if (alive.current && fileNavigation.current === id) applySelection(key);
      })
      .catch((error: unknown) => {
        if (alive.current && fileNavigation.current === id)
          setNavigationError({ key, message: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        if (alive.current && fileNavigation.current === id) setOpeningFile('');
      });
  }
  function applySelection(key: string) {
    if (viewport.current && entry) position.scroll[activeKey] = viewport.current.scrollTop;
    position.selected = key;
    persist();
    setSelected(key);
    setSelection('');
    setRange(null);
    if (window.innerWidth <= 700) setTreeOpen(false);
  }
  useEffect(() => {
    if (!entry) return;
    let cancelled = false;
    setLoadedFile((previous) => (previous?.key === activeKey ? previous : undefined));
    setSelection('');
    setRange(null);
    setFileError('');
    if (
      contents ||
      (preview && (contextLines <= 3 || entry.file.status === 'added' || entry.file.status === 'deleted'))
    )
      return;
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
        if (!cancelled) setFileError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [activeKey, fileAttempt, contextLines]);
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el || (!contents && !preview)) return;
    const desired = position.scroll[activeKey] ?? 0;
    const restore = () => {
      el.scrollTop = desired;
    };
    restore();
    const observer = new ResizeObserver(restore);
    if (code.current) observer.observe(code.current);
    const timer = setTimeout(() => observer.disconnect(), 1500);
    const stop = () => observer.disconnect();
    el.addEventListener('wheel', stop, { passive: true });
    el.addEventListener('pointerdown', stop);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
      el.removeEventListener('wheel', stop);
      el.removeEventListener('pointerdown', stop);
    };
  }, [activeKey, contents, preview]);
  function savePreferences(patch: Partial<Preferences>) {
    setPrefs((p) => ({ ...p, ...patch }));
    setPreferenceError('');
    writes.current = writes.current
      .catch(() => {})
      .then(async () => {
        const current = await window.electronAPI.loadPreferences();
        await window.electronAPI.savePreferences({ ...current, ...patch });
      })
      .catch(() => setPreferenceError('Could not save diff preferences.'));
  }
  const threads = entry ? discussion.discussions[entry.snapshot.url]?.data : undefined;
  const threadError = entry ? discussion.discussions[entry.snapshot.url]?.error : undefined;
  const matching =
    threads?.threads.filter((t) => t.path === entry?.file.path || t.path === entry?.file.previousPath) ?? [];
  const inline = matching.filter(
    (t) =>
      !t.isOutdated &&
      t.line !== null &&
      threads?.headSha === entry?.snapshot.metadata.headSha &&
      (t.diffSide === 'RIGHT' || threads?.baseSha === entry?.snapshot.metadata.baseSha)
  );
  const other = matching.filter((t) => !inline.includes(t));
  const refreshThreads = discussion.refresh;
  const comments = useChangesComments({
    enabled: !commit,
    snapshot: commit ? undefined : entry?.snapshot,
    path: entry?.file.path,
    activeKey,
    inline,
    refresh: refreshThreads,
    replaceThread: discussion.replace,
  });
  const annotations = comments.annotations;
  const options: FileDiffOptions<(typeof annotations)[number]['metadata'], undefined> = {
    enableGutterUtility: comments.writable,
    onGutterUtilityClick: comments.begin,
    onLineNumberClick: (event) =>
      comments.begin({ start: event.lineNumber, end: event.lineNumber, side: event.annotationSide }),
    theme: `gnosis-${CODE_THEMES.some((t) => t.id === prefs.codeTheme) ? prefs.codeTheme : 'github-dark'}`,
    themeType: 'dark',
    diffStyle: entry?.file.status === 'added' || entry?.file.status === 'deleted' ? 'unified' : prefs.diffLayout,
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
      if (!request) throw new Error('Select a file first.');
      try {
        if (alive.current && currentFile.current === activeKey) setFileError('');
        const value = await fileCache.read(request);
        if (value.before.kind !== 'text' || value.after.kind !== 'text')
          throw new Error('Full text context is unavailable for this file.');
        return {
          oldFile: { name: entry?.file.previousPath ?? request.path, contents: value.before.content },
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
      contents && (contents.before.kind === 'text' || contents.after.kind === 'text')
        ? ({
            oldFile:
              contents.before.kind === 'text'
                ? { name: entry?.file.previousPath ?? entry?.file.path ?? '', contents: contents.before.content }
                : null,
            newFile:
              contents.after.kind === 'text'
                ? { name: entry?.file.path ?? '', contents: contents.after.content }
                : null,
          } as DiffFileInput)
        : undefined,
    [contents, entry?.file.path, entry?.file.previousPath]
  );
  const imageSide = (before: boolean): ReviewImageSide => {
    const side = before ? contents?.before : contents?.after;
    return side?.kind === 'image'
      ? {
          status: 'ready',
          dataUrl: side.dataUrl,
          path: (before ? entry?.file.previousPath : undefined) ?? entry?.file.path ?? '',
          revision: before ? (entry?.snapshot.comparisonBase ?? '') : (entry?.snapshot.metadata.headSha ?? ''),
        }
      : { status: 'absent' };
  };
  const fileIndex = entry ? entries.indexOf(entry) : -1;
  const viewed = entry ? progress.isFileViewed(activeKey) : false;
  function mark(andNext: boolean) {
    if (!entry) return;
    progress.markFileViewed(activeKey, true);
    if (andNext || unviewed) {
      const next = [...entries.slice(fileIndex + 1), ...entries.slice(0, fileIndex)].find(
        (e) => !progress.isFileViewed(viewKey(e))
      );
      if (next) select(next.key);
    }
  }
  function ask(text = selection) {
    setSelection(text);
    setChatOpen(true);
  }
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
  return (
    <section
      className="pr-changes"
      aria-label={commit ? 'Commit changes' : 'PR changes'}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || chatOpen) e.stopPropagation();
      }}
    >
      <div className="changes-toolbar">
        <Button variant="ghost" size="sm" onClick={() => setTreeOpen((v) => !v)} aria-expanded={treeOpen}>
          <PanelLeft size={15} />
          {commit ? (
            'Commits & files'
          ) : (
            <>
              Files <span>{entries.length}</span>
            </>
          )}
        </Button>
        {(!commit || commit.snapshot) && (
          <span className="changes-progress">
            {entries.filter((e) => progress.isFileViewed(viewKey(e))).length} / {entries.length} viewed
          </span>
        )}
        <span className="changes-toolbar-spacer" />
        {openingFile && (
          <span className="changes-progress" role="status">
            Opening {openingFile.split('/').pop()}…
          </span>
        )}
        {commit?.tools}
        {!commit && comments.controls}
        <DiffAppearanceMenu
          layout={prefs.diffLayout}
          onLayoutChange={(diffLayout) => savePreferences({ diffLayout })}
          value={appearance}
          onChange={(diffAppearance) => savePreferences({ diffAppearance })}
        />
        {!commit && (
          <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load(true)}>
            <RefreshCw size={14} />
            {loading ? 'Loading…' : 'Update changes'}
          </Button>
        )}
      </div>
      {newer && (
        <div className="changes-notice" role="status">
          New commits are available. Your current diff is unchanged.
          <button disabled={loading} onClick={() => void load(true)}>
            Update changes
          </button>
        </div>
      )}
      {(error || checkError || preferenceError) && (
        <div className="changes-notice" role="status">
          {error || checkError || preferenceError}
          {error && <button onClick={() => void load(true)}>Retry</button>}
        </div>
      )}
      {navigationError && (
        <div className="changes-notice" role="alert">
          Could not open {navigationError.key}. {navigationError.message}
          <button onClick={() => select(navigationError.key)}>Retry</button>
        </div>
      )}
      {!commit && comments.panel}
      <div
        className={`changes-workspace${treeOpen ? '' : ' tree-hidden'}${chatOpen ? ' chat-open' : ''}`}
        style={{ '--changes-tree-width': `${treeWidth}px` } as CSSProperties}
      >
        {treeOpen && (
          <aside className={`changes-tree-pane${commit ? ' commits-sidebar' : ''}`} aria-label="File browser">
            {commit?.sidebar}
            {commit && (
              <button className="commit-section-toggle" onClick={commit.toggleFiles} aria-expanded={commit.filesOpen}>
                {commit.filesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Changed files{' '}
                <span>{commit.snapshot ? entries.length : '—'}</span>
              </button>
            )}
            {(!commit || commit.filesOpen) && (
              <>
                <div className="changes-tree-controls">
                  {!commit && (
                    <input
                      aria-label="Find changed files"
                      placeholder="Find a file…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  )}
                  <label>
                    <input type="checkbox" checked={unviewed} onChange={(e) => setUnviewed(e.target.checked)} />
                    Unviewed only
                  </label>
                </div>
                {commit && !commit.snapshot ? (
                  <p className="commit-inherited" role="status">
                    {commit.fileStatus}
                  </p>
                ) : loading && !snapshots.length ? (
                  <p role="status">Loading changed files…</p>
                ) : !visible.length ? (
                  <p role="status">
                    {unviewed ? 'All files viewed. Turn off Unviewed only to browse again.' : 'No changed files.'}
                  </p>
                ) : (
                  <ChangesFileTree
                    entries={treeEntries}
                    selected={entry?.key ?? ''}
                    query={query}
                    onSelect={select}
                    onPreview={(key) => {
                      hoverCancel.current();
                      hoverCancel.current = warmFile(key);
                    }}
                    showComments={!commit}
                  />
                )}
              </>
            )}
          </aside>
        )}
        {treeOpen && (
          <div
            className="changes-resize"
            role="separator"
            aria-label="Resize file browser"
            aria-orientation="vertical"
            aria-valuemin={180}
            aria-valuemax={500}
            aria-valuenow={treeWidth}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                const width = Math.max(180, Math.min(500, treeWidth + (e.key === 'ArrowRight' ? 20 : -20)));
                setTreeWidth(width);
                try {
                  localStorage.setItem('gnosis-changes-tree-width', String(width));
                } catch {
                  /* Optional. */
                }
              }
            }}
            onPointerDown={(e) => {
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                const width = Math.max(
                  180,
                  Math.min(500, e.clientX - (e.currentTarget.parentElement?.getBoundingClientRect().left ?? 0))
                );
                setTreeWidth(width);
              }
            }}
            onPointerUp={(e) => {
              e.currentTarget.releasePointerCapture(e.pointerId);
              try {
                localStorage.setItem('gnosis-changes-tree-width', String(treeWidth));
              } catch {
                /* Optional. */
              }
            }}
          />
        )}
        <div className="changes-diff-pane">
          {commit?.header}
          {entry && (
            <header className="changes-file-header">
              <div>
                {!commit && (
                  <span className="changes-source">
                    {entry.snapshot.metadata.baseRepo} #{entry.snapshot.url.split('/').pop()} ·{' '}
                    {entry.snapshot.metadata.headSha.slice(0, 7)}
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
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Previous file"
                  disabled={fileIndex <= 0}
                  onClick={() => select(entries[fileIndex - 1].key)}
                >
                  <ArrowLeft size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Next file"
                  disabled={fileIndex >= entries.length - 1}
                  onClick={() => select(entries[fileIndex + 1].key)}
                >
                  <ArrowRight size={14} />
                </Button>
                <label>
                  <input
                    type="checkbox"
                    checked={viewed}
                    onChange={(e) => (e.target.checked ? mark(false) : progress.markFileViewed(activeKey, false))}
                  />
                  Viewed
                </label>
                <Button variant="outline" size="sm" onClick={() => mark(true)}>
                  Viewed & next
                </Button>
                {!commit && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!range || !comments.writable}
                    onClick={() => range && comments.begin(range)}
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
                    onClick={() => commit.onOpenCurrentFile(entry.snapshot.url, entry.file.path)}
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
          )}
          <div
            className="changes-code-scroll"
            ref={viewport}
            onScroll={(e) => {
              if (entry && (contents || preview)) {
                position.selected = entry.key;
                position.scroll[activeKey] = e.currentTarget.scrollTop;
                persist();
              }
            }}
          >
            {commit?.status}
            {!entry && !loading && !commit && <p className="changes-empty">Select a file to inspect its changes.</p>}
            {entry && !contents && !preview && !fileError && (
              <div className="changes-loading" role="status">
                Loading file contents…
              </div>
            )}
            {fileError && (
              <div className="changes-empty" role="alert">
                <p>{fileError}</p>
                {preview ? (
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
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void window.electronAPI.openExternal(`${entry?.snapshot.url}/files`)}
                >
                  Open on GitHub <ExternalLink size={14} />
                </Button>
              </div>
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
              {contents && (contents.before.kind === 'image' || contents.after.kind === 'image') && (
                <ReviewImageDiff
                  enabled
                  filePath={entry?.file.path ?? ''}
                  comparison={{ before: imageSide(true), after: imageSide(false) }}
                />
              )}
            </div>
            {entry && !commit && (
              <div className="changes-discussion-tools">
                <Button variant="ghost" size="sm" onClick={() => void refreshThreads(entry.snapshot.url)}>
                  Refresh comments
                </Button>
              </div>
            )}
            {threadError && (
              <p className="changes-notice">
                {threadError}
                <button onClick={() => entry && void refreshThreads(entry.snapshot.url)}>Retry</button>
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
        </div>
        {chatOpen && request && (
          <PrFileChat
            key={activeKey}
            request={request}
            preferences={prefs}
            selection={selection}
            onClose={() => setChatOpen(false)}
          />
        )}
      </div>
    </section>
  );
}
