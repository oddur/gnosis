import { LoadingState, LoadingIndicator } from './LoadingState';
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
import { File } from '@pierre/diffs/react';
import { parseDiffFromFile, type DiffFileInput, type FileDiffMetadata, type FileDiffOptions, type SelectedLineRange } from '@pierre/diffs';
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
import { useDiffLayout } from '../lib/use-diff-layout';
import { diffContextLines } from '../lib/review-diff';
import {
  afterLines,
  diffGaps,
  gapContaining,
  hunksFromDiff,
  matchesAfter,
  pinLines,
  revealGap,
  revealSpan,
  revealedParts,
  shownLines,
  shownSelection,
  withPins,
  type GapDirection,
  type GapPart,
  type GapReveals,
} from '../lib/diff-gaps';
import { ChangesDiff, type GapStatus } from './ChangesDiff';
import { hunkScopes, provisionalScopes } from '../lib/hunk-scopes';
import type { DefinitionReveal } from '../lib/syntax-scope';
import { useSyntaxDefinitions } from '../lib/use-syntax-definitions';
import { applyCodeIntelligence, useSyntaxContents } from '../lib/use-syntax-contents';
import { codeIntelligenceSettings, pathEnabled } from '../lib/code-intelligence';
import { syntaxContentsPlan } from '../lib/syntax-contents';
import { keepDiffLineInView } from '../lib/diff-layout';
import { diffThemeName } from '../lib/diff-worker-pool';
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

const NO_REVEALS: GapReveals = {};
const NO_PINS: readonly (readonly [number, number])[] = [];

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
  sourceEndLine,
  renderFeedbackThread,
  focusThreadId,
  sourceSide = 'after',
  onOpenSource,
  briefSubject,
  onOpenBrief,
  onOpenFeedback,
}: {
  entry: ChangeFileEntry;
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
  onOpenSource?: (url: string, path: string) => void;
  classificationControl?: ReactNode;
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
  const collapsed = viewed && !jumpedOpen && !focusThreadId;
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
  const [afterRead, setAfterRead] = useState<{ key: string; side?: PrFileSide; error?: string }>();
  const currentAfter = afterRead?.key === activeKey ? afterRead : undefined;
  const afterSide = contents?.after ?? fileCache.peekAfter(request) ?? currentAfter?.side;
  function readAfter(retry = false) {
    if (afterSide || (currentAfter && !currentAfter.error && !retry)) return;
    const key = activeKey;
    setAfterRead({ key });
    fileCache.readAfter(request).then(
      (side) => {
        if (alive.current && currentFile.current === key) setAfterRead({ key, side });
      },
      (error: unknown) => {
        if (alive.current && currentFile.current === key)
          setAfterRead({ key, error: error instanceof Error ? error.message : String(error) });
      }
    );
  }
  const afterText = afterSide?.kind === 'text' ? afterSide.content : undefined;
  const after = useMemo(() => (afterText === undefined ? undefined : afterLines(afterText)), [afterText]);
  const afterMatches = useMemo(() => (after && gapHunks ? matchesAfter(gapHunks, after) : undefined), [after, gapHunks]);
  const expandable = entry.file.status !== 'added' && entry.file.status !== 'deleted' && !contents?.lfs;
  // A long definition's signature, shown above its hunk, is a hunk of unchanged lines inside a gap (#393).
  const [pinned, setPinned] = useState<{ key: string; value: readonly (readonly [number, number])[] }>();
  const pins = pinned?.key === activeKey ? pinned.value : NO_PINS;
  const hunks = useMemo(
    () => (gapHunks && after && afterMatches && pins.length ? withPins(gapHunks, pins, after) : gapHunks),
    [gapHunks, after, afterMatches, pins]
  );
  const gaps = useMemo(
    () => (expandable && hunks ? diffGaps(hunks, afterMatches && after ? after.length : undefined) : undefined),
    [expandable, hunks, afterMatches, after]
  );
  const [gapReveals, setGapReveals] = useState<{ key: string; value: GapReveals }>();
  const reveals = gapReveals?.key === activeKey ? gapReveals.value : NO_REVEALS;
  const parts = useMemo(
    (): GapPart[] | undefined =>
      hunks &&
      (gaps
        ? revealedParts(hunks, gaps, reveals, afterMatches ? after : undefined)
        : hunks.map((hunk, index) => ({ kind: 'hunk' as const, key: `h${index}`, hunk }))),
    [hunks, gaps, reveals, afterMatches, after]
  );
  const shown = useMemo(() => (parts ? shownLines(parts) : undefined), [parts]);
  // Enclosing definitions (#393), from text this view already has: the after side gaps reveal from, and the before
  // side when both sides are loaded. A file without a grammar, or with a stale after side, shows as before.
  // The old side is parsed only for hunks that delete lines and add none.
  const onlyDeletes = useMemo(
    () => !!gapHunks?.some((hunk) => hunk.rows.some((row) => row.type === '-') && !hunk.rows.some((row) => row.type === '+')),
    [gapHunks]
  );
  // Settings › Appearance › Code intelligence: a language that is off shows as a file without a grammar.
  const codeSettings = useMemo(() => codeIntelligenceSettings(prefs), [prefs.codeIntelligence]);
  useEffect(() => applyCodeIntelligence(codeSettings), [codeSettings]);
  const structure = pathEnabled(codeSettings, entry.file.path);
  const beforeText =
    onlyDeletes && contents?.before.kind === 'text' && pathEnabled(codeSettings, entry.file.previousPath ?? entry.file.path)
      ? contents.before.content
      : undefined;
  // Most files of a large PR have only their patch here. Once the diff is near the view, its contents load in the
  // background for its scopes, ahead of the PR's prefetch (lib/use-syntax-contents.ts): the after side, as a gap
  // reveal reads it, and both sides for hunks that only delete. Contents already cached are not read again.
  const scopePlan = useMemo(
    () => syntaxContentsPlan(entry.snapshot, entry.file, (path) => pathEnabled(codeSettings, path)),
    [entry.snapshot, entry.file, codeSettings]
  );
  const scopeFile = useMemo(() => ({ key: activeKey, snapshot: entry.snapshot, file: entry.file }), [activeKey, entry.snapshot, entry.file]);
  const structureRead = useSyntaxContents(
    sectionRef,
    scopePlan && expandable && !collapsed && !!preview && !!gaps && !unchangedMove && (scopePlan.both ? !contents : !afterSide)
      ? scopeFile
      : undefined
  );
  const definitions = useSyntaxDefinitions({
    key: activeKey,
    url: entry.snapshot.url,
    path: entry.file.path,
    previousPath: entry.file.previousPath,
    after: afterText,
    before: beforeText,
    enabled: structure && expandable && !collapsed && !!gaps && afterMatches === true,
  });
  const scopes = useMemo(
    () => (parts && shown && definitions.after ? hunkScopes(parts, gaps, definitions, shown.after) : undefined),
    [parts, gaps, definitions.after, definitions.before, shown]
  );
  // Until the definitions arrive, each hunk's location is its patch header's text, as GitHub shows it, or the file.
  const structurePending =
    structureRead.state === 'loading' || (structureRead.state === 'idle' && !!definitions.parsing);
  const provisional = useMemo(
    () =>
      !scopes && parts && gaps && scopePlan && expandable && !unchangedMove && afterMatches !== false
        ? provisionalScopes(parts, entry.file.patch)
        : undefined,
    [scopes, parts, gaps, scopePlan, expandable, unchangedMove, afterMatches, entry.file.patch]
  );
  const shownScopes = scopes ?? provisional;
  const scopeNote = scopes ? undefined : structureRead.state === 'failed' ? (
    <span className="diff-gap-structure" data-structure="failed">
      <span className="diff-gap-message">Couldn’t load structure.</span>
      <button type="button" className="diff-context-button diff-gap-text" onClick={structureRead.retry}>
        Try again
      </button>
    </span>
  ) : structurePending && provisional ? (
    <span className="diff-gap-structure" data-structure="loading">
      <LoadingIndicator announce={false}>Loading structure…</LoadingIndicator>
    </span>
  ) : undefined;
  const showDefinition = (plan: DefinitionReveal) => {
    if (!gaps || !hunks) return;
    if (plan.kind === 'whole') {
      setGapReveals({ key: activeKey, value: revealSpan(reveals, gaps, plan.start, plan.end) });
      return;
    }
    const next = pinLines(hunks, gaps, reveals, plan.start, plan.end);
    if (next.pin) setPinned({ key: activeKey, value: [...pins, next.pin] });
    setGapReveals({ key: activeKey, value: next.reveals });
  };
  // Short definitions show whole once their scopes are known, keeping the line at the top of the view in place.
  const autoOpened = useRef<string>(undefined);
  useEffect(() => {
    if (!scopes || !gaps || autoOpened.current === activeKey) return;
    autoOpened.current = activeKey;
    let next = reveals;
    for (const scope of scopes.values())
      if (scope.opens && scope.reveal?.kind === 'whole') next = revealSpan(next, gaps, scope.reveal.start, scope.reveal.end);
    if (next === reveals) return;
    if (sectionRef.current) keepDiffLineInView(sectionRef.current);
    setGapReveals({ key: activeKey, value: next });
  }, [scopes]);
  const lineCount = useMemo(
    () => Math.max(after?.length ?? 0, ...(gapHunks ?? []).map((hunk) => Math.max(hunk.oldStart, hunk.newStart) + hunk.rows.length)),
    [after, gapHunks]
  );
  const gapStatus: GapStatus =
    after && afterMatches === false
      ? { kind: 'stale' }
      : currentAfter?.error
        ? { kind: 'error', message: `Could not load more lines. ${currentAfter.error}` }
        : afterSide && afterSide.kind !== 'text'
          ? { kind: 'error', message: 'More lines are not available for this file.' }
          : currentAfter && !afterSide
            ? { kind: 'loading' }
            : { kind: 'idle' };
  const revealLines = (gap: NonNullable<typeof gaps>[number], direction: GapDirection) => {
    if (!hunks) return;
    const key = activeKey,
      count = hunks.length;
    setGapReveals((previous) => ({
      key,
      value: revealGap(previous?.key === key ? previous.value : NO_REVEALS, gap, count, direction),
    }));
    readAfter();
  };
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
      if (sourceLine)
        openMarkdownSource({ side: sourceSide, start: sourceLine, end: Math.max(sourceLine, sourceEndLine ?? sourceLine) });
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
  const fileHeader = (
    <header ref={headerRef} className="changes-file-header">
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
        {onViewedNext && <Button variant="outline" size="sm" data-viewed-next onClick={() => mark(true)}>
          Viewed & next
        </Button>}
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
        <Button variant="ghost" size="sm" onClick={() => ask(selectedCode())}>
          <MessageSquare size={14} />
          Ask about this
        </Button>
      </div>
    </header>
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
              <ReviewSelectionActions containerRef={code} resetKey={activeKey} onAsk={ask} />
              {parts && !unchangedMove && (
                <ChangesDiff
                  key={activeKey}
                  parts={parts}
                  file={{ name: entry.file.path, prevName: entry.file.previousPath, status: entry.file.status }}
                  layout={layout}
                  options={options}
                  annotations={annotations}
                  renderAnnotation={comments.renderAnnotation}
                  status={gapStatus}
                  onReveal={gaps ? (part, direction) => revealLines(part.gap, direction) : undefined}
                  scopes={shownScopes}
                  structure={!!shownScopes}
                  scopeNote={scopeNote}
                  onShowDefinition={showDefinition}
                  stickyUnder={headerRef}
                  onRetry={() => readAfter(true)}
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
