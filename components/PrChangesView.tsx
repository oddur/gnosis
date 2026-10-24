import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { MultiFileDiff } from '@pierre/diffs/react';
import type { DiffFileInput, DiffLineAnnotation, FileDiffOptions, SelectedLineRange } from '@pierre/diffs';
import { PanelLeft, ArrowLeft, ArrowRight, RefreshCw, MessageSquare, ExternalLink } from 'lucide-react';
import { ChangesFileTree } from './ChangesFileTree';
import { DiffAppearanceMenu } from './DiffAppearanceMenu';
import { GitHubReviewThread } from './GitHubReviewThread';
import { ReviewImageDiff } from './ReviewImageDiff';
import { ReviewSelectionActions } from './ReviewSelectionActions';
import { PrFileChat } from './PrFileChat';
import { Button } from './ui/button';
import { CODE_THEMES } from '../lib/constants';
import { DEFAULT_DIFF_APPEARANCE } from '../lib/review-diff';
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
import type { GitHubReviewThreads, GitHubReviewThread as Thread } from '../lib/review-threads';
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
const memory = new Map<string, PrChanges[]>();
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
  fileRevisionKey(e.snapshot.url, e.file.path, e.snapshot.metadata.baseSha, e.snapshot.metadata.headSha);

export function PrChangesView({ subject, preferences }: { subject: ReviewSubject; preferences: Preferences }) {
  const [position] = useState(() => loadPosition(subject.id));
  const [snapshots, setSnapshots] = useState<PrChanges[]>(() => memory.get(subject.id) ?? []);
  const [selected, setSelected] = useState(position.selected);
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
  const [threadResult, setThreads] = useState<{ url: string; data: GitHubReviewThreads }>(),
    [threadError, setThreadError] = useState('');
  const [chatOpen, setChatOpen] = useState(false),
    [selection, setSelection] = useState('');
  const [range, setRange] = useState<SelectedLineRange | null>(null);
  const viewport = useRef<HTMLDivElement>(null),
    code = useRef<HTMLDivElement>(null);
  const alive = useRef(true),
    generation = useRef(0);
  const persist = () => {
    try {
      localStorage.setItem(`gnosis-changes-position:${subject.id}`, JSON.stringify(position));
    } catch {
      /* Session position remains. */
    }
  };
  async function load(refresh: boolean) {
    const current = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const next: PrChanges[] = [];
      for (const member of subject.members) {
        const snapshot = await window.electronAPI.getPrChanges(member.url, refresh);
        registerChangeProgress(snapshot);
        next.push(snapshot);
      }
      if (!alive.current || current !== generation.current) return;
      memory.set(subject.id, next);
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
    void load(false);
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, [subject.id]);
  const revision = snapshots.map((s) => `${s.url}:${changesRevision(s.metadata)}`).join('|');
  useEffect(() => {
    if (!snapshots.length) return;
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
          subject.kind === 'stack'
            ? `${String(index + 1).padStart(2, '0')} · ${snapshot.metadata.baseRepo?.replace('/', ' · ') ?? 'PR'} #${snapshot.url.split('/').pop()}/`
            : '';
        return [...snapshot.files]
          .sort((a, b) => a.path.localeCompare(b.path))
          .map((file) => ({ key: prefix + file.path, snapshot, file }));
      }),
    [snapshots, subject.kind]
  );
  const entry =
    entries.find((e) => e.key === selected) ?? entries.find((e) => !progress.isFileViewed(viewKey(e))) ?? entries.at(0);
  const activeKey = entry ? viewKey(entry) : '';
  const contents = loadedFile?.key === activeKey ? loadedFile.data : undefined;
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
      })),
    [entries, unviewed, viewedSignature]
  );
  // Keep selection/scroll independent of tabs, queue navigation, and background discovery.
  function select(key: string) {
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
    setLoadedFile(undefined);
    setSelection('');
    setRange(null);
    setFileError('');
    void window.electronAPI
      .getPrChangeFile({
        url: entry.snapshot.url,
        baseSha: entry.snapshot.metadata.baseSha,
        headSha: entry.snapshot.metadata.headSha,
        path: entry.file.path,
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
  }, [activeKey, fileAttempt]);
  useEffect(() => {
    if (!entry) return;
    let cancelled = false;
    setThreads(undefined);
    setThreadError('');
    void window.electronAPI
      .getReviewThreads(entry.snapshot.url)
      .then((value) => {
        if (!cancelled) setThreads({ url: entry.snapshot.url, data: value });
      })
      .catch(() => {
        if (!cancelled) setThreadError('GitHub comments are unavailable. Open the PR on GitHub or retry.');
      });
    return () => {
      cancelled = true;
    };
  }, [entry?.snapshot.url, fileAttempt]);
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el || !contents) return;
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
  }, [activeKey, contents]);
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
  const appearance = { ...DEFAULT_DIFF_APPEARANCE, ...prefs.diffAppearance };
  const threads = threadResult?.url === entry?.snapshot.url ? threadResult?.data : undefined;
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
  const annotations: DiffLineAnnotation<Thread>[] = inline.map((t) => ({
    lineNumber: t.line ?? 0,
    side: t.diffSide === 'LEFT' ? 'deletions' : 'additions',
    metadata: t,
  }));
  const options: FileDiffOptions<Thread, undefined> = {
    theme: `gnosis-${CODE_THEMES.some((t) => t.id === prefs.codeTheme) ? prefs.codeTheme : 'github-dark'}`,
    themeType: 'dark',
    diffStyle: contents?.before.kind === 'absent' || contents?.after.kind === 'absent' ? 'unified' : prefs.diffLayout,
    disableFileHeader: true,
    collapsedContextThreshold: 3,
    hunkSeparators: 'line-info',
    diffIndicators: appearance.indicators,
    lineDiffType: appearance.inline,
    disableBackground: !appearance.backgrounds,
    disableLineNumbers: !appearance.lineNumbers,
    overflow: appearance.wrap ? 'wrap' : 'scroll',
    enableLineSelection: true,
    onLineSelected: setRange,
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
    if (!range || !contents) return '';
    const side = range.side === 'deletions' ? contents.before : contents.after;
    return side.kind === 'text'
      ? `${range.side === 'deletions' ? 'Before' : 'After'} lines ${range.start}–${range.end}:\n${side.content
          .split('\n')
          .slice(Math.min(range.start, range.end) - 1, Math.max(range.start, range.end))
          .join('\n')}`
      : '';
  };
  const request = entry
    ? {
        url: entry.snapshot.url,
        path: entry.file.path,
        baseSha: entry.snapshot.metadata.baseSha,
        headSha: entry.snapshot.metadata.headSha,
      }
    : null;
  return (
    <section
      className="pr-changes"
      aria-label="PR changes"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || chatOpen) e.stopPropagation();
      }}
    >
      <div className="changes-toolbar">
        <Button variant="ghost" size="sm" onClick={() => setTreeOpen((v) => !v)} aria-expanded={treeOpen}>
          <PanelLeft size={15} />
          Files <span>{entries.length}</span>
        </Button>
        <span className="changes-progress">
          {entries.filter((e) => progress.isFileViewed(viewKey(e))).length} / {entries.length} viewed
        </span>
        <span className="changes-toolbar-spacer" />
        <label className="sr-only" htmlFor="changes-layout">
          Diff layout
        </label>
        <select
          id="changes-layout"
          value={prefs.diffLayout}
          onChange={(e) => savePreferences({ diffLayout: e.target.value as Preferences['diffLayout'] })}
        >
          <option value="split">Split</option>
          <option value="unified">Unified</option>
        </select>
        <DiffAppearanceMenu value={appearance} onChange={(diffAppearance) => savePreferences({ diffAppearance })} />
        <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load(true)}>
          <RefreshCw size={14} />
          {loading ? 'Loading…' : 'Update changes'}
        </Button>
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
      <div
        className={`changes-workspace${treeOpen ? '' : ' tree-hidden'}${chatOpen ? ' chat-open' : ''}`}
        style={{ '--changes-tree-width': `${treeWidth}px` } as CSSProperties}
      >
        {treeOpen && (
          <aside className="changes-tree-pane" aria-label="File browser">
            <div className="changes-tree-controls">
              <input
                aria-label="Find changed files"
                placeholder="Find a file…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <label>
                <input type="checkbox" checked={unviewed} onChange={(e) => setUnviewed(e.target.checked)} />
                Unviewed only
              </label>
            </div>
            {loading && !snapshots.length ? (
              <p role="status">Loading changed files…</p>
            ) : !visible.length ? (
              <p role="status">
                {unviewed ? 'All files viewed. Turn off Unviewed only to browse again.' : 'No changed files.'}
              </p>
            ) : (
              <ChangesFileTree entries={treeEntries} selected={entry?.key ?? ''} query={query} onSelect={select} />
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
          {entry && (
            <header className="changes-file-header">
              <div>
                <span className="changes-source">
                  {entry.snapshot.metadata.baseRepo} #{entry.snapshot.url.split('/').pop()} ·{' '}
                  {entry.snapshot.metadata.headSha.slice(0, 7)}
                </span>
                <h2 title={entry.file.path}>
                  {entry.file.previousPath && <span>{entry.file.previousPath} → </span>}
                  {entry.file.path}
                </h2>
                <span className="changes-file-stats">
                  {entry.file.status} · +{entry.file.additions} −{entry.file.deletions}
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
              if (entry && contents) {
                position.selected = entry.key;
                position.scroll[activeKey] = e.currentTarget.scrollTop;
                persist();
              }
            }}
          >
            {!entry && !loading && <p className="changes-empty">Select a file to inspect its changes.</p>}
            {entry && !contents && !fileError && (
              <div className="changes-loading" role="status">
                Loading file contents…
              </div>
            )}
            {fileError && (
              <div className="changes-empty" role="alert">
                <p>{fileError}</p>
                <Button variant="outline" size="sm" onClick={() => setFileAttempt((n) => n + 1)}>
                  Retry
                </Button>
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
              {files && (
                <MultiFileDiff
                  key={activeKey}
                  {...files}
                  options={options}
                  lineAnnotations={annotations}
                  renderAnnotation={({ metadata: thread }) => <GitHubReviewThread key={thread.id} thread={thread} />}
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
            {threadError && (
              <p className="changes-notice">
                {threadError}
                <button onClick={() => setFileAttempt((n) => n + 1)}>Retry</button>
              </p>
            )}
            {!!other.length && (
              <section className="changes-other-threads">
                <h3>Other discussions on this file</h3>
                <p>These comments refer to a different revision or no longer have an inline location.</p>
                {other.map((thread) => (
                  <GitHubReviewThread key={thread.id} thread={thread} />
                ))}
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
