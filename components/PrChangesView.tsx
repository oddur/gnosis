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
import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { PrHeaderReviewContext } from '../lib/pr-header-review';
import { useSyntaxPrefetch } from '../lib/use-syntax-contents';
import { MoveNavigation, type MoveTarget } from '../lib/use-moved-symbols';
import type { QuietToggles } from '../lib/review-diff';
import { useNoiseFilter, useQuietSummary } from '../lib/use-semantic-noise';
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
import { ChevronDown, ChevronRight, PanelLeft, RefreshCw, RotateCcw, X } from 'lucide-react';
import { finishVHint, useVHint } from '../lib/review-hint';
import { ChangesFileTree } from './ChangesFileTree';
import { ChangesSymbolTree } from './ChangesSymbolTree';
import { beginJump, hasSymbolTarget, peekReadingPlace, peekReviewTarget, peekTreeCursor, readerMoved, requestSymbolJump, setReviewFile, setReviewTarget } from '../lib/tree-symbol-sync';
import { loadTreeSymbols, peekTreeSymbols, treeSymbolsSupported } from '../lib/use-tree-symbols';
import {
  FILE_STOP,
  countedIds,
  createTickStack,
  moveMirrors,
  currentItem,
  itemsLeft,
  readingItem,
  reviewStops,
  stepUnviewed,
  type ReviewFile,
  type ReviewItem,
  type ReviewPlace,
  type ReviewTick,
} from '../lib/tree-symbol-review';
import { ensureCarried, updatedCount, useCarry } from '../lib/symbol-carry';
import { markSeen, pageStep, pagerOf, seenShare, setPaging } from '../lib/review-paging';
import { commentAnchor, openReviewComment, peekLineSelection } from '../lib/review-comment';
import { patchHunks } from '../lib/semantic-noise';
import { markReviewSymbols, registerCountedSymbols, releaseHeld, setBeforeCollapse, useHeldFiles } from '../lib/symbol-file-sync';
import { readingSymbol, rowDestination, type TopLevelChanges, type TreeSymbolNode } from '../lib/tree-symbols';
import type { FileSymbols } from '../lib/tree-symbol-paths';
import { toast } from './ui/toast';
import { TOP_LEVEL_ID, type ChangedSymbol } from '../lib/symbol-outline';
import { inTreeOrder } from '../lib/tree-file-order';
import { ChangesFileResize } from './ChangesFileResize';
import { patchBounds } from '../lib/chat-citations';
import type { ChatCitationSource } from './ChatCitation';
import { DiffAppearanceMenu } from './DiffAppearanceMenu';
import { useChangesComments } from './useChangesComments';
import { PrFileChat } from './PrFileChat';
import { Button } from './ui/button';
import { changesRevision, type PrChanges } from '../lib/pr-changes';
import { staleDiffRefresh } from '../lib/use-stale-diff-refresh';
import { hasViewedMarks, progressVersion, registerChangeProgress, resetViewed, restoreViewed, useFileProgress } from '../lib/file-view-progress';
import type { AgentBriefView } from '../lib/agent-brief';
import type { ReviewSubject } from '../lib/workbench';
import type { Preferences } from '../lib/types';
import { preferencesUpdated } from '../lib/use-repository-settings';
import { usePrDiscussions } from '../lib/use-pr-discussions';
import { countRender } from '../lib/render-count';
import { openDiffComments } from '../lib/response-needed';

/** Keys that scroll the diff when it has focus: pressing one there is the reader moving on their own. */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
/** How long the place `n` went to stays where the next `n` starts, while the diff scrolls there. */
const NAV_CURSOR_MS = 1_500;
/** How long `n` waits for one file's symbols to be read and parsed. */
const NAV_LOAD_MS = 4_000;
/** How long a press keeps waiting for one file's symbols, in NAV_LOAD_MS waits, before it says they are still loading. */
const NAV_GIVE_UP_MS = 30_000;
/** Files one press of `n` reads at most before it asks the reader to press again. */
const NAV_MAX_LOADS = 12;
/** A wait shorter than this shows no "Loading symbols…". */
const LOADING_NOTICE_MS = 200;
/** How long `n`'s notices stay. */
const NOTICE_MS = 2_500;
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
  // A file its ticks just marked Viewed stays listed under Unviewed only until the reader moves on from it.
  const heldFiles = useHeldFiles();
  const visible = allowed.filter((e) => !unviewed || !progress.isFileViewed(viewKey(e)) || heldFiles.has(viewKey(e)));
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
  const noiseFilter = useNoiseFilter(appearance);
  useSyntaxPrefetch(prefetchOwner, scopeFiles, (file) => progress.isFileViewed(file.key), codeSettings, noiseFilter);
  // Comparisons land for every view's files. This view renders again only when its own quiet files change: a string
  // of them is the store's snapshot, so other views' comparisons cost it a lookup per file and no render.
  const quietKeys = useMemo(() => visible.map((e) => ({ key: e.key, fileKey: viewKey(e) })), [entries, visibleSignature]);
  const quiet = useQuietSummary(quietKeys, noiseFilter);
  // Only the quiet files' labels reach the tree: a new comparison elsewhere in the PR leaves the tree's input alone.
  const quietLabels = [...quiet.files].filter(([, file]) => file.label).map(([key, file]) => `${key}\u0000${file.label}`).join('\n');
  const quietFiles = useMemo(() => new Map(quietLabels ? quietLabels.split('\n').map((row) => row.split('\u0000') as [string, string]) : []), [quietLabels]);
  // Settings › Review › "Show changed symbols in the file tree" (Beta): off is the file tree as it was.
  const treeSymbols = preferences.treeSymbols !== false;
  // Settings › Review › "Mark a symbol viewed after you scroll through it" (Beta): off unless chosen, and only with the
  // tree's symbol rows.
  const autoViewSymbols = treeSymbols && preferences.autoViewSymbols === true;
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
          source: treeSymbols ? { fileKey: viewKey(e), snapshot: e.snapshot, file: e.file } : undefined,
        };
      }),
    [entries, visibleSignature, viewedSignature, discussion.discussions, quietFiles, treeSymbols]
  );
  // Files whose every change is noise still count towards review: Viewed is the reviewer's own mark. The progress says
  // how many of the files left are only that, so they read as quick to clear (Viewed & next).
  const quietLeft = visible.filter((e) => quietFiles.has(e.key) && !progress.isFileViewed(viewKey(e)));
  const quietKinds = [...new Set(quietLeft.map((e) => quietFiles.get(e.key)))];
  const quietWord =
    quietKinds.length !== 1 ? 'quiet' : quietKinds[0] === 'Reformatted' ? 'reformatted' : / only$/.test(quietKinds[0] ?? '') ? (quietKinds[0] ?? '').replace(/ only$/, '-only').toLowerCase() : 'quiet';
  const quietNote = quietLeft.length ? `${quietLeft.length} ${quietWord} ${quietLeft.length === 1 ? 'file' : 'files'}` : undefined;
  const changeQuiet = (next: QuietToggles) => {
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
    const found = entries.find((e) => e.snapshot.url === target.url && e.file.path === target.path);
    if (!found) return;
    // The move's lines are the revision it was matched in: a newer head opens just the file.
    if (found.snapshot.metadata.headSha === target.headSha) jumpToLines(found, { line: target.line, endLine: target.endLine, side: target.side });
    else void select(found.key);
  };
  // Stable, so every diff below keeps its context value.
  const [openMove] = useState(() => (target: MoveTarget) => openMoveLatest.current(target));
  async function select(key: string) {
    const target = entries.find((e) => e.key === key);
    if (!target) return;
    // Choosing a file stops a jump still on its way elsewhere, which would scroll the reader back.
    beginJump();
    // The reader moves on: a file its ticks marked Viewed, held open while they were on it, collapses.
    releaseHeld({ except: viewKey(target) });
    if (!allowed.some((e) => e.key === key)) await reveal();
    if (unviewed && progress.isFileViewed(viewKey(target))) setUnviewed(false);
    setSelected(key);
    requestAnimationFrame(() => stream.current?.scrollToFile(key));
    if (window.innerWidth <= 700) setTreeOpen(false);
  }
  /**
   * A symbol row of the file tree goes where the file's outline goes (lib/tree-symbol-sync.ts): through the diff's own
   * navigator, once the file is mounted. A file further away is selected and scrolled to first; the stream then stops
   * holding the file's top in place, so the jump inside it can scroll.
   */
  function goToSymbol(key: string, symbol: ChangedSymbol) {
    const target = entries.find((e) => e.key === key);
    if (!target) return;
    // A jump still on its way in another file stops: this one is the newest (lib/tree-symbol-sync.ts).
    beginJump();
    const fileKey = viewKey(target);
    // Going to a symbol is moving on too, unless it is in the held file itself.
    releaseHeld({ except: fileKey });
    const release = () => stream.current?.releasePosition();
    if (hasSymbolTarget(fileKey)) {
      setSelected(key);
      // A narrow window's tree covers the diff, as when a file is chosen.
      if (window.innerWidth <= 700) setTreeOpen(false);
      requestSymbolJump(fileKey, symbol, release);
      return;
    }
    // Asked for after select's frame scrolls to the file: that scroll holds the file's top in place, which the jump
    // then releases. Asked for sooner, a diff that mounts at once (a Viewed file opening) would jump first and be
    // pulled back to its top.
    void select(key).then(() => requestAnimationFrame(() => requestSymbolJump(fileKey, symbol, release)));
  }
  /**
   * `n` and Shift+N (Settings › Review › "Show changed symbols in the file tree"): the next or previous unviewed changed
   * symbol, in the tree's order across files (lib/tree-symbol-review.ts), from where the reader is. It goes there as a
   * click on its tree row does. A file on the way whose symbols are not known yet is read and parsed then, at the top
   * priority, for NAV_LOAD_MS at most; files further on are not read before the walk gets to them.
   */
  const [treeReveal, setTreeReveal] = useState<{ key: string; id: string; nonce: number; focus?: boolean }>();
  // Where the last `n` went: the next press starts there while the diff is still on its way.
  const navCursor = useRef<ReviewPlace & { at: number }>(undefined);
  const navRun = useRef(0);
  const navFrom = (): ReviewPlace | undefined => {
    // The item the reader was taken to, until they move on their own.
    const target = peekReviewTarget();
    if (target && visible.some((e) => e.key === target.key)) return target;
    const now = Date.now();
    const cursor = navCursor.current;
    if (cursor && now - cursor.at < NAV_CURSOR_MS && visible.some((e) => e.key === cursor.key)) return cursor;
    if (!entry) return undefined;
    const fileKey = viewKey(entry);
    const { place, at } = peekReadingPlace(fileKey);
    // A tree row the reader chose or moved to since they last scrolled.
    const row = peekTreeCursor();
    if (row && row.at > at && visible.some((e) => e.key === row.key)) return row;
    const known = place && treeSymbolsSupported(entry, codeSettings) ? peekTreeSymbols({ fileKey, snapshot: entry.snapshot, file: entry.file }, codeSettings, noiseFilter) : undefined;
    if (known?.state !== 'ready') return { key: entry.key };
    // Outside every definition: the file's top-level changes, when it has them.
    return { key: entry.key, id: place?.length ? readingSymbol(known.nodes, place) : known.top ? TOP_LEVEL_ID : undefined };
  };
  /** The files of the walk, in the tree's order, as the caches have them now (`read`: what this press read). */
  const reviewFiles = (list: readonly Entry[], read: ReadonlyMap<string, FileSymbols> = new Map()) =>
    list.map((e): ReviewFile & { fileKey: string } => {
      const source = { fileKey: viewKey(e), snapshot: e.snapshot, file: e.file };
      return {
        key: e.key,
        fileKey: source.fileKey,
        viewed: progress.isFileViewed(source.fileKey),
        symbols: treeSymbolsSupported(source, codeSettings) ? (read.get(e.key) ?? peekTreeSymbols(source, codeSettings, noiseFilter)) : undefined,
      };
    });
  /** Goes to a file without symbols, a stop of its own: selected, at its top, its row lit by the selection. */
  function goToFileStop(key: string, focus: boolean) {
    beginJump();
    navCursor.current = { key, id: FILE_STOP, at: Date.now() };
    setReviewTarget({ key, id: FILE_STOP });
    setTreeReveal((previous) => ({ key, id: FILE_STOP, nonce: (previous?.nonce ?? 0) + 1, focus }));
    void select(key);
    if (focus) keepFocusInWorkspace();
  }
  /** Goes to a review item: a symbol, a Body, or the file's top level, which go to their first changed line. */
  function goToItem(key: string, id: string, target: TreeSymbolNode | TopLevelChanges | undefined, focus: boolean) {
    const symbol = target && rowDestination(target);
    if (!symbol) return;
    navCursor.current = { key, id, at: Date.now() };
    setReviewTarget({ key, id });
    setTreeReveal((previous) => ({ key, id, nonce: (previous?.nonce ?? 0) + 1, focus }));
    goToSymbol(key, symbol);
    if (focus) keepFocusInWorkspace();
  }
  /** V's focus goes to the next row (the tree does that); with no tree to take it, it stays in the diff. */
  function keepFocusInWorkspace() {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const root = workspace.current;
        if (root && !root.contains(document.activeElement)) root.querySelector<HTMLElement>('.commit-diff-stream')?.focus({ preventScroll: true });
      })
    );
  }
  /**
   * The next (`1`) or previous (`-1`) unviewed item from `from` (by default where the reader is), gone to. A file on
   * the way whose symbols are not known yet is read first. `end` when there is none that way.
   */
  async function stepSymbol(direction: 1 | -1, { from: given, focus = false }: { from?: ReviewPlace; focus?: boolean } = {}): Promise<'went' | 'end' | 'stopped'> {
    const run = ++navRun.current;
    const from = given ?? navFrom();
    if (!from) return 'stopped';
    // What this press read: a file that could not be read is passed, not read again.
    const read = new Map<string, FileSymbols>();
    let loadingToast: string | undefined;
    const loadingTimer = setTimeout(() => {
      loadingToast = toast.add({ title: 'Loading symbols…', timeout: 0 });
    }, LOADING_NOTICE_MS);
    const finish = () => {
      clearTimeout(loadingTimer);
      if (loadingToast) toast.close(loadingToast);
    };
    try {
      for (let loads = 0; ; ) {
        const files = reviewFiles(visible, read);
        const fileKeys = new Map(files.map((file) => [file.key, file.fileKey]));
        const step = stepUnviewed(files, from, direction, (key, id) => progress.isSymbolViewed(fileKeys.get(key) ?? '', id));
        if (step.kind === 'end') return 'end';
        if (step.kind === 'go') {
          goToItem(step.key, step.id, step.node ?? step.top, focus);
          return 'went';
        }
        if (step.kind === 'file') {
          goToFileStop(step.key, focus);
          return 'went';
        }
        const source = visible.find((e) => e.key === step.key);
        if (!source) return 'stopped';
        if (++loads > NAV_MAX_LOADS) {
          toast.add({ title: 'Still looking for unviewed symbols', description: 'Press the key again to read further.', timeout: NOTICE_MS });
          return 'stopped';
        }
        // The press waits for this file's symbols while the reader waits for it (the Loading symbols notice shows): a
        // busy parse queue on a large PR can take longer than one wait, and a press that gave up would be lost. Another
        // press, or the reader moving on, ends it; NAV_GIVE_UP_MS is only the backstop.
        let value = await loadTreeSymbols({ fileKey: viewKey(source), snapshot: source.snapshot, file: source.file }, codeSettings, noiseFilter, NAV_LOAD_MS);
        for (const until = Date.now() + NAV_GIVE_UP_MS; value.state === 'loading' && run === navRun.current && Date.now() < until; )
          value = await loadTreeSymbols({ fileKey: viewKey(source), snapshot: source.snapshot, file: source.file }, codeSettings, noiseFilter, NAV_LOAD_MS);
        // Another press, or the reader moved on: this one is over.
        if (run !== navRun.current) return 'stopped';
        if (value.state === 'loading') {
          const name = step.key.slice(step.key.lastIndexOf('/') + 1);
          toast.add({ title: `Still loading the symbols of ${name}`, description: 'Press the key again in a moment.', timeout: NOTICE_MS });
          return 'stopped';
        }
        // The walk goes on from the same place: the file just read is now known.
        read.set(step.key, value);
      }
    } finally {
      finish();
    }
  }
  // What is left to review, in stops of the walk (symbols, Body, Top level, files without symbols), for the toolbar.
  // Re-review only what changed (lib/symbol-carry.ts): each file of a PR's new revision takes its earlier ticks once
  // what it lists is known (files without symbols at once); the tree does the same for files whose parse lands. The
  // walk's files, what is left and what changed are worked out again only when the files, the marks or a carry do.
  const carryVersion = useCarry();
  const allowedSignature = allowed.map((e) => e.key).join('\n');
  const marksVersion = progressVersion();
  const leftFiles = useMemo(
    () => (treeSymbols ? reviewFiles(allowed) : []),
    [treeSymbols, entries, allowedSignature, marksVersion, carryVersion, codeSettings, noiseFilter]
  );
  const { left, updated } = useMemo(() => {
    const keys = new Map(leftFiles.map((file) => [file.key, file.fileKey]));
    return {
      left: itemsLeft(leftFiles, (key, id) => progress.isSymbolViewed(keys.get(key) ?? '', id)),
      updated: updatedCount(leftFiles.map((file) => file.fileKey)),
    };
  }, [leftFiles]);
  useEffect(() => {
    if (!treeSymbols || commit || combined) return;
    for (const file of leftFiles) ensureCarried(file.fileKey, file.symbols);
  }, [leftFiles]);
  const endNotice = (direction: 1 | -1) =>
    toast.add({ title: direction === 1 ? 'No unviewed items after this' : 'No unviewed items before this', timeout: NOTICE_MS });
  /**
   * V (Changes, symbol rows on): ticks the item the reader is on and goes on to the next unviewed one, as `n` does.
   * What it ticks (lib/tree-symbol-review.ts `currentItem`): the item V, `n`, Shift+V or a tree row took the reader to,
   * until they move on their own (lib/tree-symbol-sync.ts `readerMoved`); else the item under the reading position;
   * else nothing, and V only goes on. On a tree row (its own V, `intent`), the row's file or the review items under
   * it. Each V is kept for Shift+V to take back.
   */
  const ticks = useRef(createTickStack());
  const currentReviewItem = (): ReviewItem | undefined => {
    const target = peekReviewTarget();
    let reading: ReviewItem | undefined;
    const file = entry && reviewFiles([entry])[0];
    if (!target && entry && file?.symbols?.state === 'ready') {
      const { place, line } = peekReadingPlace(file.fileKey);
      const id = place ? readingItem(file.symbols.nodes, file.symbols.top, readingSymbol(file.symbols.nodes, place), place.length === 0, line) : undefined;
      if (id) reading = { key: entry.key, id };
    }
    return currentItem({ target, reading, paging: pagingNow() });
  };
  /**
   * Long items: V pages through an item taller than the screen before it ticks it (lib/review-paging.ts). What of the
   * item V is paging through has been on screen since it became current, sampled at each V and each scroll's end.
   */
  const paging = useRef<{ key: string; fileKey: string; id: string; seen: Set<string> }>(undefined);
  const pagingNow = () => {
    const state = paging.current;
    const pager = state && pagerOf(state.fileKey);
    const lines = state && pager?.lines(state.id);
    if (!state || !pager || !lines?.length) return undefined;
    const range = pager.range();
    markSeen(state.seen, lines, pager.place, range);
    const onScreen = !!range && lines.some((line) => {
      const at = pager.place(line);
      return at !== undefined && at >= range[0] && at <= range[1];
    });
    return { item: { key: state.key, id: state.id }, onScreen, done: seenShare(lines, state.seen) >= 100 };
  };
  /** Pages through the item instead of ticking it, while some of its changed lines have not been seen; true if it did. */
  function pageFirst(item: ReviewItem): boolean {
    const target = item.id === FILE_STOP ? undefined : entries.find((e) => e.key === item.key);
    const fileKey = target && viewKey(target);
    const pager = fileKey ? pagerOf(fileKey) : undefined;
    const lines = pager?.lines(item.id);
    if (!fileKey || !pager || !lines?.length) return false;
    if (paging.current?.key !== item.key || paging.current.id !== item.id) paging.current = { key: item.key, fileKey, id: item.id, seen: new Set() };
    const state = paging.current;
    const range = pager.range();
    markSeen(state.seen, lines, pager.place, range);
    const step = pageStep({ lines, place: pager.place, seen: state.seen, range, atEnd: false });
    // A page is a jump of its own: one still on its way elsewhere stops.
    if (step.kind === 'down') beginJump();
    // Seen whole, or nothing more to scroll to: V ticks it.
    if (step.kind === 'tick' || (step.kind === 'down' && !pager.page())) {
      paging.current = undefined;
      setPaging(undefined);
      return false;
    }
    if (step.kind === 'to') pager.goToPlace(step.place);
    // The item stays the reader's target: the page is the program's scroll.
    setReviewTarget({ key: item.key, id: item.id });
    setPaging({ key: item.key, fileKey, id: item.id, share: seenShare(lines, state.seen) });
    return true;
  }
  // What the reader's own scrolling shows of the item being paged through counts as seen too.
  useEffect(() => {
    const root = workspace.current;
    if (!root) return;
    const ended = () => {
      const state = paging.current;
      const pager = state && pagerOf(state.fileKey);
      const lines = state && pager?.lines(state.id);
      if (!state || !pager || !lines) return;
      markSeen(state.seen, lines, pager.place, pager.range());
      setPaging({ key: state.key, fileKey: state.fileKey, id: state.id, share: seenShare(lines, state.seen) });
    };
    root.addEventListener('scrollend', ended, { capture: true, passive: true });
    return () => {
      root.removeEventListener('scrollend', ended, { capture: true });
      setPaging(undefined);
    };
  }, []);
  // The reader moving on their own ends the target: their wheel, touch or pointer in the diff, or a key that scrolls
  // it. The jumps' own scrolls come with none of these, so they never end it; neither does the reading place changing.
  useEffect(() => {
    const root = workspace.current;
    if (!root) return;
    const inDiff = (event: Event) => event.composedPath().some((node) => node instanceof Element && node.classList.contains('commit-diff-stream'));
    // The reader moving on their own also ends a press still waiting for a file's symbols: it must not jump them later.
    const movedOn = () => {
      readerMoved();
      navRun.current++;
    };
    const moved = (event: Event) => {
      if (inDiff(event)) movedOn();
    };
    const key = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey && inDiff(event)) movedOn();
    };
    const types = ['wheel', 'touchstart', 'pointerdown'] as const;
    for (const type of types) root.addEventListener(type, moved, { capture: true, passive: true });
    root.addEventListener('keydown', key, { capture: true });
    return () => {
      for (const type of types) root.removeEventListener(type, moved, { capture: true });
      root.removeEventListener('keydown', key, { capture: true });
      // Leaving Changes leaves no target behind.
      readerMoved();
    };
  }, []);
  /** Ticks an item, and says what that did, or undefined when it was ticked already. */
  async function tickItem(key: string, ids: readonly string[] | 'file'): Promise<ReviewTick | undefined> {
    const target = entries.find((e) => e.key === key);
    if (!target) return undefined;
    const fileKey = viewKey(target);
    if (progress.isFileViewed(fileKey)) return undefined;
    if (ids === 'file') {
      await progress.markFileViewed(fileKey, true);
      return { key, id: FILE_STOP, ids: [], markedFile: true };
    }
    const fresh = ids.filter((id) => !progress.isSymbolViewed(fileKey, id));
    if (!fresh.length) return undefined;
    await markReviewSymbols(fileKey, fresh, true);
    return { key, id: ids[ids.length - 1], ids: fresh, markedFile: progress.isFileViewed(fileKey) };
  }
  const vHint = useVHint();
  async function reviewAndMove(intent?: { key: string; ids: string[]; viewed: boolean; file: boolean }) {
    // The first V: the tip about it has done its job.
    finishVHint();
    let from: ReviewPlace | undefined;
    let ticked: ReviewTick | undefined;
    if (intent) {
      const target = entries.find((e) => e.key === intent.key);
      if (!target) return;
      // V on a row that reads viewed takes it back, and stays.
      if (!intent.viewed) {
        releaseHeld({ only: viewKey(target) });
        stream.current?.preservePosition();
        if (intent.file) void progress.markFileViewed(viewKey(target), false);
        else void markReviewSymbols(viewKey(target), intent.ids, false);
        return;
      }
      // One item, taller than the screen: V pages through it first.
      if (!intent.file && intent.ids.length === 1 && pageFirst({ key: intent.key, id: intent.ids[0] })) return;
      ticked = await tickItem(intent.key, intent.file ? 'file' : intent.ids);
      from = { key: intent.key, id: intent.file ? FILE_STOP : intent.ids.at(-1) };
    } else {
      const item = currentReviewItem();
      // Taller than the screen, and not all seen yet: V pages through it first.
      if (item && pageFirst(item)) return;
      if (item) {
        ticked = await tickItem(item.key, item.id === FILE_STOP ? 'file' : [item.id]);
        from = item;
      }
    }
    if (ticked) ticks.current.push(ticked);
    // The last item: everything is viewed. The review is next.
    if (ticked) {
      const all = reviewFiles(allowed);
      const keys = new Map(all.map((file) => [file.key, file.fileKey]));
      if (itemsLeft(all, (key, id) => progress.isSymbolViewed(keys.get(key) ?? '', id)) === 0) {
        everythingViewed();
        return;
      }
    }
    const moved = await stepSymbol(1, { from, focus: true });
    if (moved === 'end') endNotice(1);
  }
  // Leaving Changes (closed, or hidden by another tab) ends the run of V's that Shift+V walks back through.
  useEffect(() => {
    const stack = ticks.current;
    return () => stack.clear();
  }, []);
  /**
   * Enter: a comment on the item under review (lib/review-comment.ts), in the inline composer of its file, which must
   * be the selected one, as it is once V, n or a click went there. On the lines the reader selected, if any; else over
   * the item's changed lines (`commentAnchor`). Closing the composer hands the keyboard back to the tree row or the diff,
   * or, with ⌘⇧↩, ticks the item and goes on as V does. False when there is nothing to comment on.
   */
  function commentOnItem(item: ReviewItem, origin: 'tree' | 'diff'): boolean {
    const target = entries.find((e) => e.key === item.key);
    if (!target || entry?.key !== item.key || !comments.canComment) return false;
    const fileKey = viewKey(target);
    let range = peekLineSelection(fileKey);
    if (!range) {
      const lines = item.id === FILE_STOP ? undefined : pagerOf(fileKey)?.lines(item.id);
      if (item.id !== FILE_STOP && !lines?.length) return false;
      const anchor = commentAnchor({ lines, first: item.id === TOP_LEVEL_ID, hunks: patchHunks(target.file.patch) });
      if (!anchor) return false;
      range = { side: anchor.side === 'LEFT' ? 'deletions' : 'additions', start: anchor.startLine ?? anchor.line, end: anchor.line };
    }
    // Where the keyboard was when Enter was pressed (the tree row, inside its shadow root, or the diff), to give it back.
    let from: Element | null = document.activeElement;
    while (from?.shadowRoot?.activeElement) from = from.shadowRoot.activeElement;
    const returnTo = from instanceof HTMLElement ? from : null;
    openReviewComment((how) => {
      // The composer is still mounted here, and its unmount drops focus to the page: hand the keyboard back after it
      // has gone, so the next V, n or Enter works without a click.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (how === 'next') {
            void reviewAndMove({ key: item.key, ids: item.id === FILE_STOP ? [] : [item.id], viewed: true, file: item.id === FILE_STOP });
            return;
          }
          // Back on the item: it is the target again, even if a click into the composer counted as the reader moving.
          setReviewTarget({ key: item.key, id: item.id });
          if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
          else if (from === null || origin === 'diff') workspace.current?.querySelector<HTMLElement>('.commit-diff-stream')?.focus({ preventScroll: true });
          else setTreeReveal((previous) => ({ key: item.key, id: item.id, nonce: (previous?.nonce ?? 0) + 1, focus: true }));
          keepFocusInWorkspace();
        })
      );
    });
    comments.begin(range);
    focusComposer();
    return true;
  }
  /**
   * Puts the keyboard in the composer once it is drawn. Its textarea has autoFocus, but the key that opened it (Enter on
   * a tree row) hands focus back to the row as it finishes, so the composer is focused again after that, for a few
   * frames at most while its file's diff draws it.
   */
  function focusComposer(frames = 30) {
    const find = (root: Document | ShadowRoot | Element | null): HTMLTextAreaElement | null => {
      if (!root) return null;
      const own = root.querySelector<HTMLTextAreaElement>('.changes-comment-composer textarea');
      if (own) return own;
      for (const element of root.querySelectorAll('*')) {
        const inner = element.shadowRoot && find(element.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    requestAnimationFrame(() => {
      const textarea = find(workspace.current);
      if (textarea) textarea.focus({ preventScroll: true });
      if ((!textarea || document.activeElement !== textarea && !textarea.matches(':focus')) && frames > 0) focusComposer(frames - 1);
    });
  }
  function everythingViewed() {
    const number = entry?.snapshot.url.split('/').pop();
    const reviewable = ownReview && subject.kind !== 'stack' && !!number;
    const id = toast.add({
      type: 'success',
      title: 'Everything viewed',
      ...(reviewable
        ? {
            actionProps: {
              children: `Review PR #${number}`,
              onClick: () => {
                toast.close(id);
                headerReview.current.openReview();
              },
            },
          }
        : {}),
    });
  }
  /** Shift+V: takes back the newest V (its ticks, and the file it marked), and goes back to its item. */
  async function undoTick() {
    const tick = ticks.current.pop();
    if (!tick) return;
    const target = entries.find((e) => e.key === tick.key);
    if (!target) return;
    const fileKey = viewKey(target);
    releaseHeld({ only: fileKey });
    stream.current?.preservePosition();
    if (tick.id === FILE_STOP) await progress.markFileViewed(fileKey, false);
    else {
      await markReviewSymbols(fileKey, tick.ids, false);
      if (tick.markedFile && progress.isFileViewed(fileKey)) await progress.markFileViewed(fileKey, false);
    }
    if (tick.id === FILE_STOP) {
      goToFileStop(tick.key, true);
      return;
    }
    const symbols = reviewFiles([target])[0]?.symbols;
    if (symbols?.state !== 'ready') return;
    const stop = reviewStops(symbols.nodes, symbols.top).find((item) => item.id === tick.id);
    if (stop) goToItem(tick.key, stop.id, stop.node ?? stop.top, true);
  }
  useEffect(
    () => () => {
      navRun.current++;
    },
    []
  );
  // In symbol mode a file follows its ticks (lib/symbol-file-sync.ts): each file whose symbols are known counts what
  // its progress counts, for this revision. A held file that collapses on its own keeps the reader's place.
  const latestSync = useRef({ visible, codeSettings, noiseFilter });
  latestSync.current = { visible, codeSettings, noiseFilter };
  useEffect(() => {
    if (!treeSymbols) return;
    const stops = visible.map((e) => {
      const fileKey = viewKey(e);
      return registerCountedSymbols(fileKey, () => {
        const { codeSettings: settings, noiseFilter: filter } = latestSync.current;
        const source = { fileKey, snapshot: e.snapshot, file: e.file };
        if (!treeSymbolsSupported(source, settings)) return undefined;
        const symbols = peekTreeSymbols(source, settings, filter);
        const ids = countedIds(symbols);
        if (!ids || symbols.state !== 'ready') return undefined;
        return { ids, prints: symbols.prints, ...moveMirrors(symbols.nodes) };
      });
    });
    return () => stops.forEach((stop) => stop());
  }, [visibleSignature, revision, treeSymbols]);
  useEffect(() => {
    setBeforeCollapse(() => stream.current?.preservePosition());
    return () => {
      setBeforeCollapse(undefined);
      // Closed or reopened, a held file shows collapsed like any Viewed file.
      releaseHeld();
    };
  }, []);
  // A held key does not race through the symbols: one step per press. A press while a file loads takes over.
  const inTree = (event: KeyboardEvent) => event.composedPath().some((node) => node instanceof Element && node.classList.contains('changes-file-tree'));
  // The selected file is where the review target is: its outline offers Enter to comment on it.
  useEffect(() => setReviewFile(entry ? viewKey(entry) : undefined), [activeKey]);
  /** Enter in the diff comments on the item under review: only on the diff itself or its code, not a control in it. */
  const enterInDiff = (event: KeyboardEvent) => {
    const path = event.composedPath();
    if (!path.some((node) => node instanceof Element && node.classList.contains('commit-diff-stream'))) return false;
    return !path.some((node) => node instanceof Element && node.matches('button, a, input, textarea, select, summary, [role=button], [contenteditable=true]'));
  };
  const symbolKeys = {
    Enter: (event: KeyboardEvent) => {
      if (event.repeat || inTree(event) || !enterInDiff(event)) return false;
      const item = currentReviewItem();
      if (!item || !commentOnItem(item, 'diff')) return false;
    },
    n: (event: KeyboardEvent) => void (event.repeat || stepSymbol(1).then((moved) => moved === 'end' && endNotice(1))),
    N: (event: KeyboardEvent) => void (event.repeat || stepSymbol(-1).then((moved) => moved === 'end' && endNotice(-1))),
    // V anywhere in Changes; a tree row's own V acts on the row (ChangesSymbolTree's onReviewKey).
    v: (event: KeyboardEvent) => {
      if (inTree(event)) return false;
      if (!event.repeat) void reviewAndMove();
    },
    // Shift+V takes the last V back. Caps Lock's V without Shift is V.
    V: (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (!event.shiftKey) {
        if (inTree(event)) return false;
        void reviewAndMove();
        return;
      }
      void undoTick();
    },
  };
  // Only with the tree's symbol rows on: otherwise `n` is not Changes' key.
  useKeyboardShortcuts(symbolKeys, { enabled: treeSymbols && visible.length > 0, capture: true, scope: workspace });
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
  /**
   * "Show file symbols" beside Unviewed only: the same preference as Settings › Review › "Show changed symbols in the
   * file tree". It is saved, then announced, so every open Changes view and the Settings dialog agree.
   */
  /**
   * Reset viewed: every file of these changes (all of them, not only those the filters show) loses its Viewed mark
   * and every symbol tick, at once, keeping the reader's place. A toast offers Undo, which puts back exactly what was
   * cleared.
   */
  const allFileKeys = useMemo(() => entries.map(viewKey), [entries]);
  const anyViewed = useMemo(() => hasViewedMarks(allFileKeys), [allFileKeys, progressVersion()]);
  function resetAllViewed() {
    for (const fileKey of allFileKeys) releaseHeld({ only: fileKey });
    stream.current?.preservePosition();
    const { snapshot, saved } = resetViewed(allFileKeys);
    // Nothing left for Shift+V to take back.
    ticks.current.clear();
    void saved;
    if (!snapshot.marks.length) return;
    const id = toast.add({
      type: 'success',
      title: 'Viewed state reset',
      description: 'Every file and symbol in these changes is unviewed.',
      actionProps: {
        children: 'Undo',
        onClick: () => {
          toast.close(id);
          stream.current?.preservePosition();
          void restoreViewed(snapshot);
        },
      },
    });
  }
  function setTreeSymbols(on: boolean) {
    setPreferenceError('');
    writes.current = writes.current
      .catch(() => {})
      .then(async () => {
        const next = { ...(await window.electronAPI.loadPreferences()), treeSymbols: on };
        await window.electronAPI.savePreferences(next);
        preferencesUpdated(next);
      })
      .catch(() => setPreferenceError('Could not save the file tree setting.'));
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
  // In a PR's workspace, Drafts and Review PR are in the header (#542): hand them this diff's drafts while shown.
  // Activity hides this view with its effects, so the header takes them back on every other tab.
  const toHeader = useContext(PrHeaderReviewContext);
  const headerReview = useRef(comments.header);
  headerReview.current = comments.header;
  const { draftCount, draftsDisabled, reviewBlocked } = comments.header;
  const ownReview = !commit && !combined;
  useEffect(() => {
    if (!toHeader || !ownReview) return;
    toHeader({
      draftCount,
      draftsDisabled,
      reviewBlocked,
      toggleDrafts: () => headerReview.current.toggleDrafts(),
      openReview: () => headerReview.current.openReview(),
    });
    return () => toHeader(undefined);
  }, [toHeader, ownReview, draftCount, draftsDisabled, reviewBlocked]);
  // Citations in the file conversation resolve to the files of its snapshot, within what their patches show.
  const chatJumpTo = useRef(jumpToLines);
  chatJumpTo.current = jumpToLines;
  const chatSnapshot = chatEntry?.snapshot;
  const chatCitations = useMemo<ChatCitationSource | undefined>(() => {
    if (!chatSnapshot) return undefined;
    const own = entries.filter((e) => e.snapshot === chatSnapshot);
    return {
      files: own.map((e) => e.file.path),
      bounds: (path) => {
        const entry = own.find((e) => e.file.path === path);
        return entry && patchBounds(entry.file);
      },
      open: (cited) => {
        const target = own.find((e) => e.file.path === cited.path);
        if (target) chatJumpTo.current(target, { line: cited.startLine, endLine: cited.endLine, side: 'after' });
      },
    };
  }, [entries, chatSnapshot]);
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
            {entries.filter((e) => progress.isFileViewed(viewKey(e))).length} / {entries.length} {entries.length === 1 ? 'file' : 'files'} viewed
            {treeSymbols && left > 0 && (
              <span className="changes-progress-left" title="Left to review: changed functions, classes, top-level changes and files without symbols that are not viewed yet">
                {' '}· {left} left to review
              </span>
            )}
            {updated > 0 && (
              <span className="changes-progress-updated" title="Changed since you viewed them, in an earlier revision">
                {' '}· {updated} changed
              </span>
            )}
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
        {!commit && !combined && !toHeader && comments.controls}
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
                  {/* One line under the search: the tree's two view options, then the rare reset, apart at the end. */}
                  <div className="changes-tree-options">
                    <div className="changes-tree-toggles">
                      <label>
                        <input type="checkbox" checked={unviewed} onChange={(e) => setUnviewed(e.target.checked)} />
                        Unviewed only
                      </label>
                      {/* "Symbols", not "Show file symbols": the tree's default width fits both options on one line. */}
                      <label title="Show file symbols: expand a file to see the functions and classes its changes touch">
                        <input type="checkbox" checked={treeSymbols} onChange={(e) => setTreeSymbols(e.target.checked)} />
                        Symbols
                      </label>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="changes-tree-reset"
                      disabled={!anyViewed}
                      aria-label="Reset viewed"
                      title="Reset viewed: clear Viewed for every file and symbol in these changes"
                      onClick={resetAllViewed}
                    >
                      <RotateCcw size={14} aria-hidden="true" />
                    </Button>
                  </div>
                  {/* Once, until the first V or its ×: the review loop's key, where the reader starts. */}
                  {treeSymbols && vHint && (
                    <p className="changes-tree-hint" role="note">
                      <span>
                        Press <kbd className="kbd">V</kbd> to mark what you’re reading and go on to the next change
                      </span>
                      <button type="button" aria-label="Dismiss tip" title="Dismiss" onClick={finishVHint}>
                        <X size={12} aria-hidden="true" />
                      </button>
                    </p>
                  )}
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
                ) : treeSymbols ? (
                  <ChangesSymbolTree
                    key={`${positionId}:${revision}:symbols`}
                    entries={treeEntries}
                    selected={entry?.key ?? ''}
                    query={query}
                    onSelect={select}
                    onGoToSymbol={goToSymbol}
                    onSetViewed={(keys, viewed) => {
                      const targets = new Set(keys);
                      // Unviewed by hand: a file its ticks held open no longer needs holding.
                      if (!viewed) for (const e of entries) if (targets.has(e.key)) releaseHeld({ only: viewKey(e) });
                      stream.current?.preservePosition();
                      return progress.markFilesViewed(entries.filter(e => targets.has(e.key)).map(viewKey), viewed);
                    }}
                    onPreview={(key) => {
                      hoverCancel.current();
                      hoverCancel.current = warmFile(key);
                    }}
                    showComments={!commit}
                    revealSelected
                    codeSettings={codeSettings}
                    noiseFilter={noiseFilter}
                    reveal={treeReveal}
                    onReviewKey={(intent) => void reviewAndMove(intent)}
                    onCommentKey={(item) => commentOnItem(item, 'tree')}
                    onReviewCurrent={() => void reviewAndMove()}
                  />
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
                    symbolTree={treeSymbols}
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
                    autoViewSymbols={autoViewSymbols}
                    onAsk={(text) => {
                      setChatEntry(e);
                      setSelection(text);
                      setChatOpen(true);
                      // Opening or not, the chat takes focus with the selection in its prompt.
                      setChatFocusRequest((request) => request + 1);
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
            citations={chatCitations}
          />
        )}
      </div>
    </section>
    </MoveNavigation.Provider>
  );
}
