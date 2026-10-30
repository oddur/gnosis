import { watchGitHub } from '../lib/watch-github';
import { stackFileDiscussions } from '../lib/stack-changes';
import { loadInspectionBatch, inspectionFailure, type InspectionFailure } from '../lib/inspection-batch';
import { InspectionFailureNotice } from './InspectionFailureNotice';
import { useKeyboardShortcuts } from '../lib/use-keyboard-shortcuts';
import { useRawFileFilters } from '../lib/use-raw-file-filters';
import { hiddenByFileFilters, hiddenByFileExtensions } from '../lib/file-kinds';
import { RawFileFilters, FileKindControl } from './RawFileFilters';
import { usePrReadVisit } from '../lib/pr-read-context';
import { CommitDiffStream, type CommitDiffStreamHandle } from './CommitDiffStream';
import { useReviewBreadcrumbs, type ReviewCrumb } from '../lib/review-breadcrumbs';
import { PrFileInspection, changeFileKey as viewKey, type ChangeFileEntry as Entry } from './PrFileInspection';
import { useDiffAppearance } from '../lib/use-diff-appearance';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  inspectionFiles as fileCache,
  fileIsReady,
  prepareFile,
  prefetchInspection,
  commitPositionId,
  inspectionData,
} from '../lib/inspection-cache';
import { ChevronDown, ChevronRight, PanelLeft, RefreshCw } from 'lucide-react';
import { ChangesFileTree } from './ChangesFileTree';
import { ChangesFileResize } from './ChangesFileResize';
import { DiffAppearanceMenu } from './DiffAppearanceMenu';
import { useChangesComments } from './useChangesComments';
import { PrFileChat } from './PrFileChat';
import { Button } from './ui/button';
import { diffContextLines } from '../lib/review-diff';
import { changesRevision, type PrChanges } from '../lib/pr-changes';
import { registerChangeProgress, useFileProgress } from '../lib/file-view-progress';
import type { ReviewSubject } from '../lib/workbench';
import type { Preferences } from '../lib/types';
import { usePrDiscussions } from '../lib/use-pr-discussions';

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
export function rememberChangesFile(subjectId: string, path: string) {
  const position = loadPosition(subjectId);
  position.selected = path;
  try { localStorage.setItem(`gnosis-changes-position:${subjectId}`, JSON.stringify(position)); } catch { /* Optional position. */ }
}
export interface CommitWorkspace {
  breadcrumbs?: ReviewCrumb[];
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
  combined,
  toolbar,
  preferredPath,
  onActiveFile,
}: {
  subject: ReviewSubject;
  preferences: Preferences;
  commit?: CommitWorkspace;
  combined?: { snapshot: PrChanges; onOpenSource: (url: string, path: string) => void };
  toolbar?: ReactNode;
  preferredPath?: string;
  onActiveFile?: (path: string) => void;
  initialFile?: { url: string; path: string; line?: number; headSha?: string };
}) {
  const positionId = combined ? `combined:${subject.id}` : commit ? commitPositionId(subject.id, commit.snapshot) : subject.id;
  const stream = useRef<CommitDiffStreamHandle>(null);
  const workspace = useRef<HTMLElement>(null);
  const [chatFocusRequest, setChatFocusRequest] = useState(0);
  const [chatEntry, setChatEntry] = useState<Entry>();
  const [position] = useState<Position>(() => loadPosition(positionId));
  const [loadedSnapshots, setSnapshots] = useState<PrChanges[]>(() =>
    combined ? [] : subject.members.flatMap((member) => inspectionData.peekChanges(member) ?? [])
  );
  const snapshots = useMemo(
    () => combined ? [combined.snapshot] : (commit ? (commit.snapshot ? [commit.snapshot] : []) : loadedSnapshots),
    [combined?.snapshot, commit?.snapshot, !!commit, loadedSnapshots]
  );
  usePrReadVisit(
    snapshots.map((snapshot) => ({ url: snapshot.url, headSha: snapshot.metadata.headSha })),
    !commit && !combined
  );
  const [selected, setSelected] = useState(position.selected);
  const hoverCancel = useRef<() => void>(() => {});
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [newer, setNewer] = useState(false),
    [checkError, setCheckError] = useState('');
  const [loadErrors, setLoadErrors] = useState<InspectionFailure[]>([]);
  const [query, setQuery] = useState(''),
    [unviewed, setUnviewed] = useState(false),
    [treeOpen, setTreeOpen] = useState(() => window.innerWidth > 700);
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 700px)');
    const resize = () => { if (narrow.matches) setTreeOpen(false); };
    narrow.addEventListener('change', resize);
    return () => narrow.removeEventListener('change', resize);
  }, []);
  const [treeWidth, setTreeWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('gnosis-changes-tree-width'));
      return Number.isFinite(saved) && saved > 0 ? Math.max(180, Math.min(500, saved)) : 270;
    } catch {
      return 270;
    }
  });
  const [prefs, setPrefs] = useState(preferences),
    [preferenceError, setPreferenceError] = useState('');
  const appearance = useDiffAppearance(prefs.diffAppearance);
  const contextLines = diffContextLines(appearance);
  const writes = useRef(Promise.resolve());
  useEffect(
    () =>
      setPrefs((p) => ({
        ...p,
        provider: preferences.provider,
        model: preferences.model,
        codeTheme: preferences.codeTheme,
      })),
    [preferences.provider, preferences.model, preferences.codeTheme, preferences.diffLayout, preferences.diffAppearance]
  );
  const progress = useFileProgress();
  const discussion = usePrDiscussions(commit ? [] : subject.members.map((member) => member.url));
  const [chatOpen, setChatOpen] = useState(false),
    [selection, setSelection] = useState('');
  const alive = useRef(true),
    generation = useRef(0);
  const persist = () => {
    try {
      localStorage.setItem(`gnosis-changes-position:${positionId}`, JSON.stringify(position));
    } catch {
      /* Session position remains. */
    }
  };
  const loadController = useRef<AbortController | undefined>(undefined);
  const [pendingMembers, setPendingMembers] = useState<string[]>([]);
  async function load(refresh: boolean, onlyUrl?: string) {
    if (commit || combined) return;
    const current = ++generation.current;
    setLoading(true);
    setError('');
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    const members = subject.members.filter(m => !onlyUrl || m.url === onlyUrl);
    const waiting = new Set(members.map(m => m.url));
    setPendingMembers([...waiting]);
    const next = new Map(loadedSnapshots.map(s => [s.url, s]));
    const failures = new Map(loadErrors.filter(e => onlyUrl && e.url !== onlyUrl).map(e => [e.url, e]));
    setLoadErrors([...failures.values()]);
    try {
      await loadInspectionBatch(members, (member, signal) => inspectionData.readChanges(member, refresh, false, signal), (member, result) => {
        if (!alive.current || current !== generation.current) return;
        if ('value' in result) {
          registerChangeProgress(result.value);
          next.set(member.url, result.value);
        } else failures.set(member.url, inspectionFailure(member.url, result.error));
        waiting.delete(member.url);
        stream.current?.preservePosition();
        setSnapshots(subject.members.flatMap(m => next.get(m.url) ?? []));
        setLoadErrors([...failures.values()]);
        setPendingMembers([...waiting]);
      }, controller.signal);
      if (alive.current && current === generation.current && !controller.signal.aborted) {
        if (refresh && !failures.size) setNewer(false);
        setCheckError('');
      }
    } finally {
      if (alive.current && current === generation.current) { setLoading(false); setPendingMembers([]); }
    }
  }
  useEffect(() => {
    alive.current = true;
    if (!commit && !combined && loadedSnapshots.length === subject.members.length) loadedSnapshots.forEach(registerChangeProgress);
    else if (!commit && !combined) void load(false);
    return () => {
      alive.current = false;
      generation.current++;
      loadController.current?.abort();
      hoverCancel.current();
    };
  }, [subject.id]);
  const revision = snapshots.map((s) => `${s.url}:${changesRevision(s.metadata)}`).join('|');
  useEffect(() => {
    if (commit || combined || !snapshots.length) return;
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
    const stop = watchGitHub({ kind: 'metadata', priority: 'active', targets: snapshots.map(snapshot => ({ url: snapshot.url })) }, update => {
      if (update.kind !== 'metadata') return;
      const snapshot = snapshots.find(snapshot => snapshot.url === update.url);
      if (snapshot && changesRevision(update.value) !== changesRevision(snapshot.metadata)) setNewer(true);
      setCheckError('');
    }, () => setCheckError('Could not check for new commits. Showing the saved version; retrying automatically.'));
    if (stop) return stop;
    void check();
    const timer = setInterval(() => void check(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [revision]);
  const entries = useMemo<Entry[]>(
    () =>
      snapshots.flatMap((snapshot) => {
        const index = subject.members.findIndex(member => member.url === snapshot.url);
        const prefix =
          subject.kind === 'stack' && !commit && !combined
            ? `${String(index + 1).padStart(2, '0')} · ${snapshot.metadata.baseRepo?.replace('/', ' · ') ?? 'PR'} #${snapshot.url.split('/').pop()}/`
            : '';
        return [...snapshot.files]
          .sort((a, b) => a.path.localeCompare(b.path))
          .map((file) => ({ key: prefix + file.path, snapshot, file }));
      }),
    [snapshots, subject.kind, !!commit, !!combined]
  );
  const incomplete = snapshots.some(s => s.filesTruncated) || loadErrors.length > 0 ||
    (!commit && !combined && snapshots.length < subject.members.length);
  const filters = useRawFileFilters(snapshots);
  const kinds = new Map(entries.map((e) => [e.key, filters.kind(e.snapshot, e.file)]));
  const allowed = entries.filter(
    (e) =>
      !hiddenByFileFilters(filters.kind(e.snapshot, e.file), filters.state) &&
      !hiddenByFileExtensions(e.file.path, filters.state.hiddenExtensions)
  );
  const hidden = entries.length - allowed.length;
  const visible = allowed.filter((e) => !unviewed || !progress.isFileViewed(viewKey(e)));
  const selectionIndex = entries.findIndex((e) => e.key === selected);
  const visibleKeys = new Set(visible.map((e) => e.key));
  const entry =
    visible.find((e) => e.key === selected) ??
    (!position.selected && preferredPath ? visible.find(e => e.file.path === preferredPath) : undefined) ??
    entries.slice(selectionIndex + 1).find((e) => visibleKeys.has(e.key)) ??
    visible.at(0);
  const activeKey = entry ? viewKey(entry) : '';
  const carried = useRef(false);
  useEffect(() => {
    if (carried.current || !entries.length) return;
    carried.current = true;
    if (!position.selected && preferredPath) {
      const match = entries.find(e => e.file.path === preferredPath);
      if (match) { setSelected(match.key); requestAnimationFrame(() => stream.current?.scrollToFile(match.key)); }
    }
  }, [entries]);
  useEffect(() => { if (entry) onActiveFile?.(entry.file.path); }, [activeKey]);
  useKeyboardShortcuts({
    c: () => {
      if (!entry) return;
      if (!chatEntry || viewKey(chatEntry) !== viewKey(entry)) setSelection('');
      setChatEntry(entry);
      setChatOpen(true);
      setChatFocusRequest((request) => request + 1);
    },
  }, { enabled: !!entry, capture: true, scope: workspace });
  const awaitingSelection = loading && !!selected && !entries.some(e => e.key === selected);
  const wasAwaiting = useRef(false);
  useEffect(() => {
    if (wasAwaiting.current && !awaitingSelection && entries.some(e => e.key === selected)) stream.current?.scrollToFile(selected);
    wasAwaiting.current = awaitingSelection;
  }, [awaitingSelection]);
  const visibleSignature = visible.map((e) => e.key).join('\n');
  useEffect(() => {
    if (!awaitingSelection && entry && !visible.some((e) => e.key === selected)) {
      setSelected(entry.key);
      stream.current?.scrollToFile(entry.key);
    }
  }, [visibleSignature, awaitingSelection]);
  const reveal = async () => {
    setUnviewed(false);
    await filters.update({ filters: { hideGenerated: false, hideTests: false, hiddenExtensions: [] } });
  };
  const viewedSignature = visible.map((e) => (progress.isFileViewed(viewKey(e)) ? '1' : '0')).join('');
  const streamFiles = useMemo(
    () => visible.map((e) => ({ key: e.key, file: e.file, viewed: progress.isFileViewed(viewKey(e)) })),
    [entries, visibleSignature, viewedSignature]
  );
  const treeEntries = useMemo(
    () =>
      visible.map((e) => {
        const combinedDiscussion = combined
          ? stackFileDiscussions(e.snapshot, e.file, discussion.discussions)
          : undefined;
        return {
          key: e.key,
          status: e.file.status,
          viewed: progress.isFileViewed(viewKey(e)),
          additions: e.file.additions,
          deletions: e.file.deletions,
          commentCount: combinedDiscussion
            ? combinedDiscussion.count
            : discussion.discussions[e.snapshot.url]?.data?.threads
                .filter((t) => t.path === e.file.path || t.path === e.file.previousPath)
                .reduce((total, thread) => total + thread.comments.length, 0),
          commentError: combinedDiscussion
            ? combinedDiscussion.failures.length > 0
            : !!discussion.discussions[e.snapshot.url]?.error,
        };
      }),
    [entries, visibleSignature, viewedSignature, discussion.discussions]
  );
  useEffect(() => {
    if (!initialFile) return;
    const match = entries.find(
      (e) =>
        e.snapshot.url === initialFile.url &&
        (e.file.path === initialFile.path || e.file.previousPath === initialFile.path)
    );
    if (match && initialFile.headSha && match.snapshot.metadata.headSha !== initialFile.headSha) {
      setError('This annotation belongs to an older commit. Open its source on GitHub from Checks.');
    } else if (match) void select(match.key);
    else if (snapshots.length)
      setError(snapshots.some(s => s.url === initialFile.url && s.filesTruncated)
        ? `“${initialFile.path}” is not in the files GitHub returned. This PR’s file list is incomplete.`
        : `“${initialFile.path}” is not in the current PR changes. Choose another file to comment on.`);
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
        stackComparison: target.snapshot.stackComparison?.key,
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
        stackComparison: target.snapshot.stackComparison?.key,
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
    const index = visible.indexOf(entry);
    const cancel = [index + 1, index + 2, index - 1].flatMap((i) => (visible[i] ? [warmFile(visible[i].key)] : []));
    return () => cancel.forEach((stop) => stop());
  }, [activeKey, entries, visibleSignature, contextLines]);
  async function select(key: string) {
    const target = entries.find((e) => e.key === key);
    if (!target) return;
    if (!allowed.some((e) => e.key === key)) await reveal();
    if (unviewed && progress.isFileViewed(viewKey(target))) setUnviewed(false);
    setSelected(key);
    requestAnimationFrame(() => stream.current?.scrollToFile(key));
    if (window.innerWidth <= 700) setTreeOpen(false);
  }
  useReviewBreadcrumbs(
    commit ? 'commits' : 'changes',
    [
      ...(commit?.breadcrumbs ?? []),
      ...(!commit && !combined && subject.kind === 'stack' && entry
        ? [
            {
              id: 'member',
              label: `Source #${entry.snapshot.url.split('/').pop()}`,
              pickerLabel: 'Source PR in stack changes',
              value: entry.snapshot.url,
              options: subject.members.map((member) => ({
                value: member.url,
                label: `#${member.number} · ${member.title}`,
              })),
              select: (url: string) => {
                const next = entries.find((e) => e.snapshot.url === url);
                if (next) void select(next.key);
              },
            },
          ]
        : []),
      ...(entry
        ? [
            {
              id: 'file',
              label: entry.file.path,
              pickerLabel: 'File in comparison',
              value: entry.key,
              options: visible
                .filter((e) => e.snapshot.url === entry.snapshot.url)
                .map((e) => ({ value: e.key, label: e.file.path })),
              select,
            },
          ]
        : []),
    ],
    true
  );
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
  const refreshThreads = discussion.refresh;
  const comments = useChangesComments({
    enabled: !commit && !combined,
    snapshot: commit || combined
      ? undefined
      : (entry?.snapshot ?? entries.find((e) => e.key === selected)?.snapshot ?? snapshots.at(0)),
    path: entry?.file.path,
    activeKey,
    inline: [],
    refresh: refreshThreads,
    replaceThread: discussion.replace,
  });
  const chatRequest = chatEntry
    ? {
        url: chatEntry.snapshot.url,
        path: chatEntry.file.path,
        baseSha: chatEntry.snapshot.metadata.baseSha,
        headSha: chatEntry.snapshot.metadata.headSha,
        comparison: chatEntry.snapshot.comparison,
        stackComparison: chatEntry.snapshot.stackComparison?.key,
      }
    : null;
  return (
    <section
      ref={workspace}
      className="pr-changes"
      aria-label={commit ? 'Commit changes' : 'PR changes'}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && treeOpen && window.innerWidth <= 700) {
          e.stopPropagation(); setTreeOpen(false); return;
        }
        if (e.key !== 'Escape' || chatOpen) e.stopPropagation();
      }}
    >
      <div className="changes-toolbar">
        {toolbar}
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
            {incomplete && ' · available files'}
          </span>
        )}
        <span className="changes-toolbar-spacer" />
        {commit?.tools}
        {!commit && !combined && comments.controls}
        {!commit && !combined && entry && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh comments"
            title={`Refresh comments for PR #${entry.snapshot.url.split('/').pop()}`}
            onClick={() => void refreshThreads(entry.snapshot.url)}
          >
            <RefreshCw size={14} />
          </Button>
        )}
        <RawFileFilters
          filters={filters}
          paths={entries.map((e) => e.file.path)}
          hidden={hidden}
          generated={[...kinds.values()].filter((k) => k.generated.value).length}
          tests={[...kinds.values()].filter((k) => k.test.value).length}
        />
        <DiffAppearanceMenu
          layout={prefs.diffLayout}
          onLayoutChange={(diffLayout) => savePreferences({ diffLayout })}
          value={appearance}
          onChange={(diffAppearance) => savePreferences({ diffAppearance })}
        />
        {!commit && !combined && (
          <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load(true)}>
            <RefreshCw size={14} />
            {loading ? 'Loading…' : 'Update changes'}
          </Button>
        )}
      </div>
      {snapshots.filter(s => s.filesTruncated && !s.stackComparison).map(snapshot => (
        <div className="changes-notice" role="status" key={snapshot.url}>
          <span>
            <strong>Partial changes · PR #{snapshot.url.split('/').pop()}</strong>{' '}
            {snapshot.comparison
              ? `GitHub’s file limit was reached. Showing ${snapshot.files.length.toLocaleString('en-US')} files; this comparison may be incomplete.`
              : `Showing ${snapshot.files.length.toLocaleString('en-US')} of ${snapshot.metadata.changedFileCount?.toLocaleString('en-US') ?? 'more'} files. GitHub limits PR file lists to 3,000.`}{' '}
            Files load as you open them.
          </span>
          <button onClick={() => void window.electronAPI.openExternal(snapshot.comparison
            ? `https://github.com/${snapshot.metadata.baseRepo}/compare/${snapshot.comparisonBase}...${snapshot.metadata.headSha}`
            : `${snapshot.url}/files`)}>Open on GitHub</button>
        </div>
      ))}
      {snapshots.some(s => s.patchesDeferred) && <div className="changes-notice" role="status">
        Large diffs load as you open each file to keep this view responsive. All available filenames remain searchable.
      </div>}
      {loading && <div className="changes-notice" role="status">
        <span>Loading {pendingMembers.length} {pendingMembers.length === 1 ? 'PR' : 'PRs'}… Available files are ready to review.</span>
        <button onClick={() => { loadController.current?.abort(); setLoadErrors(errors => [...errors, ...pendingMembers.map(url => ({ url, message: 'Loading was stopped.' }))]); setLoading(false); setPendingMembers([]); }}>Stop loading</button>
      </div>}
      {loadErrors.map(failure => <InspectionFailureNotice key={failure.url} failure={failure}
        saved={snapshots.some(s => s.url === failure.url)} kind="changes" busy={pendingMembers.includes(failure.url)} retryDisabled={loading}
        retry={() => void load(true, failure.url)} />)}
      {filters.pending && (
        <div className="changes-notice" role="status">
          File classification has updated. Your visible files are unchanged.
          <button onClick={filters.apply}>Apply updated file filters</button>
        </div>
      )}
      {filters.error && (
        <div className="changes-notice" role="alert">
          {filters.error}
          <button disabled={filters.busy} onClick={() => void filters.retry()}>
            Retry file filters
          </button>
        </div>
      )}
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
      {!commit && !combined && comments.panel}
      <div
        className={`changes-workspace${treeOpen ? '' : ' tree-hidden'}${chatOpen ? ' chat-open' : ''}`}
        style={{ '--changes-tree-width': `${treeWidth}px` } as CSSProperties}
      >
        {treeOpen && <button className="changes-tree-dismiss" aria-label="Close file browser" onClick={() => setTreeOpen(false)} />}
        {treeOpen && (
          <aside className={`changes-tree-pane${commit ? ' commits-sidebar' : ''}`} aria-label="File browser">
            <button className="changes-tree-close" onClick={() => setTreeOpen(false)}>Close file browser</button>
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
                      aria-label={incomplete ? "Find available changed files" : "Find changed files"}
                      placeholder={incomplete ? "Find an available file…" : "Find a file…"}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  )}
                  <label>
                    <input type="checkbox" checked={unviewed} onChange={(e) => setUnviewed(e.target.checked)} />
                    Unviewed only
                  </label>
                </div>
                {incomplete && <p className="file-filter-group">Search covers available files only.</p>}
                {!commit && !combined &&
                  subject.kind === 'stack' &&
                  snapshots
                    .filter((s) => s.files.length > 0 && !visible.some((e) => e.snapshot.url === s.url))
                    .map((s) => (
                      <div className="file-filter-group" key={s.url}>
                        <strong>PR #{s.url.split('/').pop()}</strong>
                        <span>
                          {s.files.length} {s.files.length === 1 ? 'file' : 'files'} hidden
                        </span>
                        <button onClick={reveal}>Show hidden files</button>
                      </div>
                    ))}
                {commit && !commit.snapshot ? (
                  <p className="commit-inherited" role="status">
                    {commit.fileStatus}
                  </p>
                ) : loading && !snapshots.length ? (
                  <p role="status">Loading changed files…</p>
                ) : !visible.length ? (
                  <p role="status">
                    {hidden
                      ? `${hidden} ${hidden === 1 ? 'file' : 'files'} hidden by your filters.`
                      : unviewed
                        ? 'All files viewed. Turn off Unviewed only to browse again.'
                        : loadErrors.length ? 'Changed files are unavailable.' : 'No changed files.'}
                    {hidden > 0 && (
                      <button className="file-filter-reveal" onClick={reveal}>
                        Show hidden files
                      </button>
                    )}
                  </p>
                ) : (
                  <ChangesFileTree
                    entries={treeEntries}
                    selected={entry?.key ?? ''}
                    query={query}
                    onSelect={select}
                    onSetViewed={(keys, viewed) => {
                      const targets = new Set(keys);
                      stream.current?.preservePosition();
                      return progress.markFilesViewed(entries.filter(e => targets.has(e.key)).map(viewKey), viewed);
                    }}
                    onPreview={(key) => {
                      hoverCancel.current();
                      hoverCancel.current = warmFile(key);
                    }}
                    showComments={!commit}
                    revealSelected
                  />
                )}
              </>
            )}
          </aside>
        )}
        {treeOpen && (
          <ChangesFileResize
            width={treeWidth}
            onChange={setTreeWidth}
            onCommit={(width) => {
              try {
                localStorage.setItem('gnosis-changes-tree-width', String(width));
              } catch {
                /* Optional. */
              }
            }}
          />
        )}
        <div className="changes-diff-pane">
          {commit?.header}
          {snapshots.length > 0 || commit ? (
            <CommitDiffStream
              ref={stream}
              files={streamFiles}
              selected={entry?.key ?? ''}
              initialPosition={{ key: position.selected || entry?.key || '', offset: position.scroll[activeKey] ?? 0 }}
              onPosition={(key, offset) => {
                if (awaitingSelection) return;
                const target = entries.find((e) => e.key === key);
                if (!target) return;
                position.selected = key;
                position.scroll[viewKey(target)] = offset;
                persist();
                setSelected((previous) => (previous === key ? previous : key));
              }}
              renderFile={(key, next) => {
                const e = entries.find((e) => e.key === key);
                if (!e) return null;
                return (
                  <PrFileInspection
                    key={viewKey(e)}
                    entry={e}
                    sourceLine={initialFile?.url === e.snapshot.url && initialFile.path === e.file.path && initialFile.headSha === e.snapshot.metadata.headSha ? initialFile.line : undefined}
                    preferences={prefs}
                    classificationControl={
                      <FileKindControl
                        snapshot={e.snapshot}
                        file={e.file}
                        kinds={filters.kind(e.snapshot, e.file)}
                        filters={filters}
                      />
                    }
                    discussion={discussion}
                    onOpenCurrentFile={commit?.onOpenCurrentFile}
                    onOpenSource={combined?.onOpenSource}
                    onViewedNext={next}
                    onAsk={(text) => {
                      setChatEntry(e);
                      setSelection(text);
                      setChatOpen(true);
                    }}
                  />
                );
              }}
              completion={
                <>
                  {commit?.status}
                  {hidden > 0 && (
                    <div className="changes-empty file-filter-hidden" role="status">
                      <strong>
                        {hidden} {hidden === 1 ? 'file is' : 'files are'} hidden
                      </strong>
                      <p>Hidden files still count toward your review progress.</p>
                      <Button variant="outline" size="sm" disabled={filters.busy} onClick={reveal}>
                        Show hidden files
                      </Button>
                    </div>
                  )}
                  {!loading && entries.length > 0 && entries.every((e) => progress.isFileViewed(viewKey(e))) && (
                    <div className="changes-empty commit-viewed-complete" role="status">
                      <strong>{incomplete ? 'All available files viewed' : 'All files viewed'}</strong>
                      <p>
                        {incomplete
                          ? 'This is not the complete change. Inspect the remaining files on GitHub or in a local checkout.'
                          : commit
                          ? 'You’ve finished this comparison. Choose another commit to continue.'
                          : combined ? 'You’ve viewed the net changes. Per-PR review progress is separate.'
                          : 'You’ve viewed every file. Submit your review when you’re ready.'}
                      </p>
                      {unviewed && (
                        <Button variant="outline" size="sm" onClick={() => setUnviewed(false)}>
                          Show all files
                        </Button>
                      )}
                    </div>
                  )}
                </>
              }
            />
          ) : (
            <p className="changes-empty">{loading ? 'Loading changed files…' : loadErrors.length ? 'Changed files are unavailable. Retry or open the PR on GitHub.' : 'No changed files.'}</p>
          )}
        </div>
        {chatOpen && chatRequest && (
          <PrFileChat
            key={chatEntry ? viewKey(chatEntry) : activeKey}
            request={chatRequest}
            focusRequest={chatFocusRequest}
            preferences={prefs}
            selection={selection}
            onClose={() => setChatOpen(false)}
          />
        )}
      </div>
    </section>
  );
}
