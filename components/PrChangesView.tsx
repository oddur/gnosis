import { useRenderSpan } from '../lib/perf-spans';
import { LoadingState, LoadingIndicator } from './LoadingState';
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
import { DiffWorkerPool, diffThemeName } from '../lib/diff-worker-pool';
import { publishDiffLayout, useBeforeDiffLayoutChange, useDiffLayout, useDiffLayoutTarget } from '../lib/use-diff-layout';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useMovesPrefetch, useSyntaxPrefetch } from '../lib/use-syntax-contents';
import { MoveNavigation, type MoveTarget } from '../lib/use-moved-symbols';
import { noiseFilterOf } from '../lib/review-diff';
import { useQuietSummary } from '../lib/use-semantic-noise';
import { anchorReader } from '../lib/quiet-changes';
import { publishDiffAppearance } from '../lib/use-diff-appearance';
import { QuietChangesChip } from './QuietChanges';
import { codeIntelligenceSettings } from '../lib/code-intelligence';
import {
  fileIsReady,
  prepareFile,
  prefetchInspection,
  commitPositionId,
  inspectionData,
} from '../lib/inspection-cache';
import { ChevronDown, ChevronRight, PanelLeft, RefreshCw } from 'lucide-react';
import { ChangesFileTree } from './ChangesFileTree';
import { inTreeOrder } from '../lib/tree-file-order';
import { ChangesFileResize } from './ChangesFileResize';
import { DiffAppearanceMenu } from './DiffAppearanceMenu';
import { useChangesComments } from './useChangesComments';
import { PrFileChat } from './PrFileChat';
import { Button } from './ui/button';
import { changesRevision, type PrChanges } from '../lib/pr-changes';
import { staleDiffRefresh } from '../lib/use-stale-diff-refresh';
import { registerChangeProgress, useFileProgress } from '../lib/file-view-progress';
import type { AgentBriefView } from '../lib/agent-brief';
import type { ReviewSubject } from '../lib/workbench';
import type { Preferences } from '../lib/types';
import { usePrDiscussions } from '../lib/use-pr-discussions';
import { countRender } from '../lib/render-count';
import { openDiffComments } from '../lib/response-needed';

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
export interface ChangesInitialFile {
  url: string;
  path: string;
  line?: number;
  /** Last line of a range, such as the lines a chat answer used. */
  endLine?: number;
  headSha?: string;
  side?: 'before' | 'after';
  /** Set when jumping from an agent brief comment, which belongs to the view it was written in. */
  view?: AgentBriefView;
}
export interface CommitWorkspace {
  breadcrumbs?: ReviewCrumb[];
  snapshot?: PrChanges;
  sidebar: ReactNode;
  header: ReactNode;
  status: ReactNode;
  tools: ReactNode;
  fileStatus: ReactNode;
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
  onOpenBrief,
  onOpenFeedback,
  landOnUnviewed,
}: {
  /** A nonce: select the first file not yet marked viewed, once the files load. A review request lands here. */
  landOnUnviewed?: number;
  account?: string;
  onOpenFeedback?: (url?: string, threadId?: string) => void;
  subject: ReviewSubject;
  preferences: Preferences;
  commit?: CommitWorkspace;
  combined?: { snapshot: PrChanges; onOpenSource: (url: string, path: string) => void };
  toolbar?: ReactNode;
  preferredPath?: string;
  onActiveFile?: (path: string) => void;
  onOpenBrief?: () => void;
  initialFile?: ChangesInitialFile;
}) {
  useRenderSpan('changes render');
  countRender('PrChangesView');
  const positionId = combined ? `combined:${subject.id}` : commit ? commitPositionId(subject.id, commit.snapshot) : subject.id;
  const stream = useRef<CommitDiffStreamHandle>(null);
  const workspace = useRef<HTMLElement>(null);
  const [chatFocusRequest, setChatFocusRequest] = useState(0);
  const [chatEntry, setChatEntry] = useState<Entry>();
  // A chat trace chip jumps like an incoming `initialFile`, without leaving the view.
  const [chatJump, setChatJump] = useState<ChangesInitialFile>();
  useEffect(() => setChatJump(undefined), [initialFile]);
  const jump = chatJump ?? initialFile;
  const [position] = useState<Position>(() => structuredClone(loadPosition(positionId)));
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
  // A tree that closed because the window was narrow opens again the next time this tab is shown wide,
  // as it did when tabs remounted on every visit.
  const narrowClosed = useRef(false);
  const treeOpenNow = useRef(treeOpen);
  treeOpenNow.current = treeOpen;
  // Layout effect: a kept tab misses resizes while hidden, so apply the current width before it paints.
  useLayoutEffect(() => {
    const narrow = window.matchMedia('(max-width: 700px)');
    const resize = () => {
      if (!narrow.matches) return;
      if (treeOpenNow.current) narrowClosed.current = true;
      setTreeOpen(false);
    };
    if (narrow.matches) resize();
    else if (narrowClosed.current) { narrowClosed.current = false; setTreeOpen(true); }
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
  const layout = useDiffLayout(prefs.diffLayout);
  const writes = useRef(Promise.resolve());
  useEffect(
    () =>
      setPrefs((p) => ({
        ...p,
        provider: preferences.provider,
        model: preferences.model,
        codeTheme: preferences.codeTheme,
        codeIntelligence: preferences.codeIntelligence,
      })),
    [preferences.provider, preferences.model, preferences.codeTheme, preferences.diffLayout, preferences.diffAppearance, preferences.codeIntelligence]
  );
  const progress = useFileProgress();
  const discussion = usePrDiscussions(commit ? [] : subject.members.map((member) => member.url));
  const [chatOpen, setChatOpen] = useState(false),
    [selection, setSelection] = useState('');
  const alive = useRef(true),
    generation = useRef(0);
  const persist = () => {
    positions.set(positionId, structuredClone(position));
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
  const shownSnapshots = useRef(loadedSnapshots);
  shownSnapshots.current = loadedSnapshots;
  /**
   * A diff here whose contents do not match its patch (lib/stale-diff-refresh.ts) reads its PR's changes again,
   * listing the suspect files anew (`recheck`), beside any load in progress: it never cancels one. At the same head the
   * refreshed files replace the shown ones, keeping the reader's place. A newer head is offered as New commits, as
   * the head watch offers it: the open diff stays until the reader moves. The reader's own Refresh moves, as Update
   * changes does.
   */
  useEffect(() => {
    if (commit || combined) return;
    const stops = subject.members.map((member) =>
      staleDiffRefresh.register(member.url, async (url, revision, paths, interactive) => {
        const value = await inspectionData.readChanges(member, true, interactive ? false : 'view', undefined, { ...revision, paths });
        const shown = shownSnapshots.current.find((snapshot) => snapshot.url === url);
        if (!alive.current || !shown) return shown?.metadata;
        if (!interactive && changesRevision(value.metadata) !== changesRevision(shown.metadata)) {
          setNewer(true);
          return shown.metadata;
        }
        // The same files listed again: nothing new to show, so the view keeps its snapshot and its state.
        const patch = (snapshot: PrChanges, path: string) => snapshot.files.find((file) => file.path === path)?.patch;
        if (
          changesRevision(value.metadata) === changesRevision(shown.metadata) &&
          value.files.length === shown.files.length &&
          paths.every((path) => patch(value, path) === patch(shown, path))
        )
          return shown.metadata;
        registerChangeProgress(value);
        stream.current?.preservePosition();
        setSnapshots((previous) => previous.map((snapshot) => (snapshot.url === url ? value : snapshot)));
        return value.metadata;
      })
    );
    return () => stops.forEach((stop) => stop());
  }, [subject.id, !!commit, !!combined]);
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
  // A kept tab can outlive a queue update. A newer head the queue already knows needs no GitHub check.
  const queueHeads = subject.members.map((member) => `${member.url}:${member.headSha}`).join('|');
  useEffect(() => {
    if (commit || combined || !snapshots.length) return;
    const moved = snapshots.some((snapshot) => {
      const member = subject.members.find((m) => m.url === snapshot.url);
      return !!member?.headSha && member.headSha !== snapshot.metadata.headSha;
    });
    if (moved) setNewer(true);
  }, [queueHeads, revision]);
  const entries = useMemo<Entry[]>(
    () =>
      inTreeOrder(
        snapshots.flatMap((snapshot) => {
          const index = subject.members.findIndex(member => member.url === snapshot.url);
          const prefix =
            subject.kind === 'stack' && !commit && !combined
              ? `${String(index + 1).padStart(2, '0')} · ${snapshot.metadata.baseRepo?.replace('/', ' · ') ?? 'PR'} #${snapshot.url.split('/').pop()}/`
              : '';
          return snapshot.files.map((file) => ({ key: prefix + file.path, snapshot, file }));
        }),
        (entry) => entry.key
      ),
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
      // A fresh commit opens at its message; filter fallbacks still jump to the next file.
      if (selected || !commit?.header) stream.current?.scrollToFile(entry.key);
    }
  }, [visibleSignature, awaitingSelection]);
  const reveal = async () => {
    setUnviewed(false);
    await filters.update({ filters: { hideGenerated: false, hideTests: false, hiddenExtensions: [] } });
  };
  const viewedSignature = visible.map((e) => (progress.isFileViewed(viewKey(e)) ? '1' : '0')).join('');
  // Hunk scopes (#393): every supported file's contents load in the background, in diff order, while this view is
  // open, after the reads of files in view. Closing the view stops it.
  const prefetchOwner = useId();
  const scopeFiles = useMemo(
    () => visible.map((e) => ({ key: viewKey(e), snapshot: e.snapshot, file: e.file })),
    [entries, visibleSignature]
  );
  const codeSettings = useMemo(() => codeIntelligenceSettings(prefs), [prefs.codeIntelligence]);
  // Quiet changes (#396): what the reader hides, and each file's comparison as it lands, for the tree and progress.
  const noiseFilter = useMemo(() => noiseFilterOf(appearance), [appearance.hideWhitespace, appearance.hideFormatting, appearance.hideComments]);
  useSyntaxPrefetch(prefetchOwner, scopeFiles, (file) => progress.isFileViewed(file.key), codeSettings, noiseFilter);
  // Moved and renamed symbols (#398) are matched across every file of the PR, those a filter hides too.
  const moveFiles = useMemo(() => entries.map((e) => ({ key: viewKey(e), snapshot: e.snapshot, file: e.file })), [entries]);
  useMovesPrefetch(prefetchOwner, moveFiles, codeSettings);
  // Comparisons land for every view's files. This view renders again only when its own quiet files change: a string
  // of them is the store's snapshot, so other views' comparisons cost it a lookup per file and no render.
  const quietKeys = useMemo(() => visible.map((e) => ({ key: e.key, fileKey: viewKey(e) })), [entries, visibleSignature]);
  const quiet = useQuietSummary(quietKeys, noiseFilter);
  // Only the quiet files' labels reach the tree: a new comparison elsewhere in the PR leaves the tree's input alone.
  const quietLabels = [...quiet.files].filter(([, file]) => file.label).map(([key, file]) => `${key}\u0000${file.label}`).join('\n');
  const quietFiles = useMemo(() => new Map(quietLabels ? quietLabels.split('\n').map((row) => row.split('\u0000') as [string, string]) : []), [quietLabels]);
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
            : openDiffComments(
                discussion.discussions[e.snapshot.url]?.data?.threads.filter(
                  (t) => t.path === e.file.path || t.path === e.file.previousPath
                )
              ),
          quiet: quietFiles.get(e.key),
          commentError: combinedDiscussion
            ? combinedDiscussion.failures.length > 0
            : !!discussion.discussions[e.snapshot.url]?.error,
        };
      }),
    [entries, visibleSignature, viewedSignature, discussion.discussions, quietFiles]
  );
  // Files whose every change is noise still count towards review: Viewed is the reviewer's own mark. The progress says
  // how many of the files left are only that, so they read as quick to clear (Viewed & next).
  const quietLeft = visible.filter((e) => quietFiles.has(e.key) && !progress.isFileViewed(viewKey(e)));
  const quietKinds = [...new Set(quietLeft.map((e) => quietFiles.get(e.key)))];
  const quietWord =
    quietKinds.length !== 1 ? 'quiet' : quietKinds[0] === 'Reformatted' ? 'reformatted' : (quietKinds[0] ?? '').replace(/ only$/, '-only').replace(/ and comments$/, ' and comment').toLowerCase();
  const quietNote = quietLeft.length ? `${quietLeft.length} ${quietWord} ${quietLeft.length === 1 ? 'file' : 'files'}` : undefined;
  const changeQuiet = (next: Pick<Preferences['diffAppearance'] & object, 'hideWhitespace' | 'hideFormatting' | 'hideComments'>) => {
    anchorReader();
    const diffAppearance = { ...appearance, ...next };
    publishDiffAppearance(diffAppearance);
    savePreferences({ diffAppearance });
  };
  useEffect(() => {
    if (!initialFile) return;
    const match = entries.find(
      (e) =>
        // The combined diff has one source; its tip may have changed since a brief comment was written.
        (!!combined || e.snapshot.url === initialFile.url) &&
        (e.file.path === initialFile.path || e.file.previousPath === initialFile.path)
    );
    if (match && !initialFile.view && initialFile.headSha && match.snapshot.metadata.headSha !== initialFile.headSha) {
      setError('This annotation belongs to an older commit. Open its source on GitHub from Checks.');
    } else if (match) void select(match.key);
    else if (snapshots.length)
      setError(snapshots.some(s => s.url === initialFile.url && s.filesTruncated)
        ? `“${initialFile.path}” is not in the files GitHub returned. This PR’s file list is incomplete.`
        : `“${initialFile.path}” is not in the current PR changes. Choose another file to comment on.`);
  }, [initialFile, entries]);
  const landedUnviewed = useRef<number>(undefined);
  useEffect(() => {
    if (landOnUnviewed === undefined || landedUnviewed.current === landOnUnviewed || !entries.length) return;
    landedUnviewed.current = landOnUnviewed;
    const first = entries.find((e) => !progress.isFileViewed(viewKey(e)));
    if (first) void select(first.key);
  }, [landOnUnviewed, entries]);
  // Keep selection/scroll independent of tabs, queue navigation, and background discovery.
  function warmFile(key: string) {
    const target = entries.find((e) => e.key === key);
    if (!target) return () => {};
    if (fileIsReady(target.snapshot, target.file)) return () => {};
    return prefetchInspection(viewKey(target), () => prepareFile(target.snapshot, target.file, true));
  }
  useEffect(() => {
    if (!entry) return;
    const index = visible.indexOf(entry);
    const cancel = [index + 1, index + 2, index - 1].flatMap((i) => (visible[i] ? [warmFile(visible[i].key)] : []));
    return () => cancel.forEach((stop) => stop());
  }, [activeKey, entries, visibleSignature]);
  // A move's note in another file goes there, as a chat trace chip does, without leaving the view.
  /** Selects a file and scrolls to its lines, without leaving the view: a chat trace chip, a move's note. */
  const jumpToLines = (entry: Entry, lines: Pick<ChangesInitialFile, 'line' | 'endLine' | 'side'>) => {
    void select(entry.key);
    // Clear first so repeating the same jump scrolls again.
    setChatJump(undefined);
    requestAnimationFrame(() =>
      setChatJump({ url: entry.snapshot.url, path: entry.file.path, headSha: entry.snapshot.metadata.headSha, ...lines })
    );
  };
  const openMoveLatest = useRef<(target: MoveTarget) => void>(() => {});
  openMoveLatest.current = (target) => {
    const found = entries.find((e) => e.snapshot.url === target.url && e.file.path === target.path && e.snapshot.metadata.headSha === target.headSha);
    if (found) jumpToLines(found, { line: target.line, endLine: target.endLine, side: target.side });
  };
  // Stable, so every diff below keeps its context value.
  const [openMove] = useState(() => (target: MoveTarget) => openMoveLatest.current(target));
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
              id: 'member', kind: 'pr' as const,
              pr: subject.members.find((member) => member.url === entry.snapshot.url) ?? null,
              label: `Source #${entry.snapshot.url.split('/').pop()}`,
              pickerLabel: 'Source PR in stack changes',
              value: entry.snapshot.url,
              options: subject.members.map((member) => ({
                value: member.url, kind: 'pr' as const, pr: member,
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
              filePath: entry.file.path,
              label: entry.file.path,
              pickerLabel: 'File in comparison',
              value: entry.key,
              options: visible
                .filter((e) => e.snapshot.url === entry.snapshot.url)
                .map((e) => ({ value: e.key, label: e.file.path, filePath: e.file.path })),
              select,
            },
          ]
        : []),
    ],
    true
  );
  function changeLayout(diffLayout: Preferences['diffLayout']) {
    publishDiffLayout(diffLayout);
    savePreferences({ diffLayout });
  }
  useDiffLayoutTarget(workspace, changeLayout);
  // Keep the line at the top of the stream in place while every file re-renders in the other layout.
  useBeforeDiffLayoutChange(() => {
    if (workspace.current?.checkVisibility()) stream.current?.keepAnchor();
  });
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
    <MoveNavigation.Provider value={openMove}>
    <section
      ref={workspace}
      className="pr-changes"
      data-diff-layout={layout}
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
        <Button variant="ghost" size="sm" onClick={() => setTreeOpen((v) => !v)} aria-expanded={treeOpen} title={commit ? 'Commits & files' : 'File tree'}>
          <PanelLeft size={15} />
          {commit ? (
            <span className="toolbar-label is-secondary">Commits &amp; files</span>
          ) : (
            <>
              <span className="toolbar-label is-secondary">File tree</span> <span>{entries.length}</span>
            </>
          )}
        </Button>
        {!commit && onOpenFeedback && <Button variant="outline" size="sm" onClick={() => onOpenFeedback()}>Address feedback</Button>}
        {(!commit || commit.snapshot) && (
          <span className="changes-progress">
            {entries.filter((e) => progress.isFileViewed(viewKey(e))).length} / {entries.length} viewed
            {incomplete && ' · available files'}
            {quietNote && (
              <span
                className="changes-progress-quiet"
                data-quiet-files={quietLeft.length}
                title={`Of the files left to view, ${quietLeft.length} only ${quietLeft.length === 1 ? 'changes' : 'change'} whitespace, formatting or comments that Diff appearance hides. They still count: mark them Viewed when you have looked.`}
              >
                {' · '}
                {quietNote}
              </span>
            )}
          </span>
        )}
        <span className="changes-toolbar-spacer" />
        {commit?.tools}
        {!commit && !combined && comments.controls}
        {!commit && !combined && entry && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh comments"
            title={`Refresh comments for PR #${entry.snapshot.url.split('/').pop()}`}
            onClick={() => void refreshThreads(entry.snapshot.url)}
          >
            {/* Saved comments are showing while GitHub is read again. */}
            <RefreshCw
              size={14}
              className={
                discussion.discussions[entry.snapshot.url]?.data?.stale &&
                !discussion.discussions[entry.snapshot.url]?.error
                  ? 'animate-spin'
                  : undefined
              }
            />
          </Button>
        )}
        <RawFileFilters
          filters={filters}
          paths={entries.map((e) => e.file.path)}
          hidden={hidden}
          generated={[...kinds.values()].filter((k) => k.generated.value).length}
          tests={[...kinds.values()].filter((k) => k.test.value).length}
        />
        {!commit && <QuietChangesChip summary={quiet} files={visible.length} filter={noiseFilter} onChange={changeQuiet} />}
        <DiffAppearanceMenu
          layout={layout}
          onLayoutChange={changeLayout}
          value={appearance}
          onChange={(diffAppearance) => savePreferences({ diffAppearance })}
        />
        {!commit && !combined && (
          <Button variant="ghost" size="sm" disabled={loading} aria-label="Update changes" title="Update changes" onClick={() => void load(true)}>
            <RefreshCw size={14} className={loading ? 'motion-safe:animate-spin' : undefined} />
            <span>{loading ? 'Loading…' : <>Update<span className="toolbar-label-extra"> changes</span></>}</span>
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
        <LoadingIndicator announce={false}>Loading {pendingMembers.length} {pendingMembers.length === 1 ? 'PR' : 'PRs'}… Available files are ready to review.</LoadingIndicator>
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
                  <LoadingState compact title="Loading changed files…" />
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
                    key={`${positionId}:${revision}`}
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
          {snapshots.length > 0 || commit ? (
            <DiffWorkerPool theme={diffThemeName(prefs.codeTheme)} lineDiffType={appearance.inline}>
            <CommitDiffStream
              ref={stream}
              files={streamFiles}
              header={commit?.header}
              selected={entry?.key ?? ''}
              initialPosition={{ key: position.selected || (commit ? '' : entry?.key) || '', offset: position.scroll[activeKey] ?? 0 }}
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
                    sourceLine={jump?.url === e.snapshot.url && jump.path === e.file.path && jump.headSha === e.snapshot.metadata.headSha ? jump.line : undefined}
                    sourceEndLine={jump?.endLine}
                    sourceSide={jump?.side}
                    briefSubject={commit ? undefined : subject}
                    onOpenBrief={onOpenBrief}
                    preferences={prefs}
                    classificationControl={
                      <FileKindControl
                        part="menu"
                        snapshot={e.snapshot}
                        file={e.file}
                        kinds={filters.kind(e.snapshot, e.file)}
                        filters={filters}
                      />
                    }
                    classificationTags={
                      <FileKindControl
                        part="tags"
                        snapshot={e.snapshot}
                        file={e.file}
                        kinds={filters.kind(e.snapshot, e.file)}
                        filters={filters}
                      />
                    }
                    discussion={discussion}
                    onOpenFeedback={onOpenFeedback}
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
            </DiffWorkerPool>
          ) : (
            loading ? <LoadingState title="Loading changed files…" hint="You can keep browsing." /> :
            <p className="changes-empty">{loadErrors.length ? 'Changed files are unavailable. Retry or open the PR on GitHub.' : 'No changed files.'}</p>
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
            onOpenTraceStep={(step) => {
              const target = chatEntry && entries.find((e) => e.snapshot === chatEntry.snapshot && (e.file.path === step.path || e.file.previousPath === step.path));
              if (!target || !step.path) return;
              jumpToLines(target, { line: step.startLine, endLine: step.endLine, side: step.side });
            }}
          />
        )}
      </div>
    </section>
    </MoveNavigation.Provider>
  );
}
