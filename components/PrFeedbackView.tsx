import { isResponseThread, isUnresolvedThread } from '../lib/response-needed';
import { FeedbackCodeThread } from './FeedbackCodeThread';
import type { Preferences } from '../lib/types';
import { Popover } from 'radix-ui';
import { SearchableSelect } from './SearchableSelect';
import { memo, startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { GitHubReviewThreads } from '../lib/review-threads';
import {
  ArrowDown,
  ArrowUp,
  AtSign,
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Bot,
  CalendarDays,
  Copy,
  Eye,
  GitCompareArrows,
  GitCommitHorizontal,
  GitPullRequest,
  MessageSquareDot,
  MessageSquareWarning,
  MessagesSquare,
  BellDot,
  GitMerge,
  GitPullRequestClosed,
  History,
  MessageSquare,
  RefreshCw,
  Reply,
  Send,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Timeline, TimelineContent, TimelineHeader, TimelineIndicator, TimelineItem, TimelineSeparator, TimelineTitle } from './ui/timeline';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useVirtualizerSettled } from '../lib/test-settled';
import { Button } from './ui/button';
import { FileTypeIcon } from './FileTypeIcon';
import { GitHubAuthor } from './GitHubAuthor';
import { SubjectIcon } from './SubjectIcon';
import { GitHubReviewThread, HiddenComment, inFrontPanel } from './GitHubReviewThread';
import { minimizedLabel } from '../lib/review-threads';
import { CommentMarkdown } from './CommentMarkdown';
import { Markdown } from './Markdown';
import { DiffStats } from './DiffStats';
import { MarkdownCommentEditor } from './MarkdownCommentEditor';
import { useEvidenceDiscussions } from '../lib/use-evidence-discussions';
import {
  responseFeedbackTarget,
  type ResponseIntent,
  feedbackOptionsKey,
  isGitHubActionsFeedback,
  feedbackItems,
  feedbackKey,
  feedbackReadKey,
  feedbackFingerprint,
  feedbackReviewers,
  feedbackStateLabel,
  chronologicalThread,
  diffHunkAnchor,
  mentionsAccount,
  plainCommentText,
  type FeedbackItem,
} from '../lib/feedback';
import { BIG_GROUP, GROUP_PREVIEW, INDEX_FILES, botSummary, buildTimeline, commitLines, entryItems, summarizeCommits, threadIndex, type TimelineEntry } from '../lib/feedback-timeline';
import { readReviewState, writeReviewState } from '../lib/renderer-review-state';
import { replaceDiscussionThread, refreshDiscussion } from '../lib/review-discussion-cache';
import { useSessionDraft, ReviewDraftBoundary } from '../lib/session-drafts';
import { useKeyboardShortcuts } from '../lib/use-keyboard-shortcuts';
import type { ReviewMember, ReviewSubject } from '../lib/workbench';
import { timeAgo } from '../lib/utils';
import { countRender } from '../lib/render-count';
import { replyDraftSent, useKeptReplyDraft } from '../lib/notification-drafts';
import { optimisticWrite } from '../lib/write-failures';
import { WriteFailureNotice } from './WriteFailureNotice';

type Filter = 'all' | 'unresolved' | 'unread' | 'mentions';
type Row =
  | TimelineEntry
  | { type: 'divider'; key: string; at: string }
  | { type: 'day'; key: string; at: string; label: string; gap?: string };
/** Rows that hold no item: markers on the rail that the keyboard steps over. */
const isMarker = (row: Row): row is Extract<Row, { type: 'divider' | 'day' }> => row.type === 'divider' || row.type === 'day';

/**
 * What a rail node says, in words, with its icon and tone. The tone repeats the words for the eye; the label is the
 * node's accessible name and tooltip, and the title beside it says the same in a sentence.
 */
type NodeKind =
  | 'description' | 'comment' | 'approved' | 'changes-requested' | 'reviewed' | 'dismissed'
  | 'thread-unresolved' | 'thread-resolved' | 'thread-outdated' | 'commits' | 'force-push'
  | 'review-requested' | 'merged' | 'closed' | 'reopened' | 'bot' | 'new' | 'day' | 'earlier';
const NODES: Record<NodeKind, { icon?: LucideIcon; tone: string; label: string }> = {
  description: { icon: GitPullRequest, tone: 'neutral', label: 'Opened the PR' },
  comment: { icon: MessageSquare, tone: 'neutral', label: 'Comment' },
  approved: { icon: CircleCheck, tone: 'success', label: 'Approved' },
  'changes-requested': { icon: MessageSquareWarning, tone: 'danger', label: 'Changes requested' },
  reviewed: { icon: MessagesSquare, tone: 'neutral', label: 'Review' },
  dismissed: { icon: MessagesSquare, tone: 'quiet', label: 'Dismissed review' },
  'thread-unresolved': { icon: MessageSquareDot, tone: 'review', label: 'Unresolved code thread' },
  'thread-resolved': { icon: Check, tone: 'success', label: 'Resolved code thread' },
  'thread-outdated': { icon: History, tone: 'warning', label: 'Outdated code thread' },
  commits: { icon: GitCommitHorizontal, tone: 'quiet', label: 'Commits pushed' },
  'force-push': { icon: GitCompareArrows, tone: 'quiet', label: 'Force-pushed' },
  'review-requested': { icon: Eye, tone: 'quiet', label: 'Review requested' },
  merged: { icon: GitMerge, tone: 'info', label: 'Merged' },
  closed: { icon: GitPullRequestClosed, tone: 'danger', label: 'Closed' },
  reopened: { icon: GitPullRequest, tone: 'success', label: 'Reopened' },
  bot: { icon: Bot, tone: 'quiet', label: 'Bot comments' },
  new: { icon: BellDot, tone: 'review', label: 'New since you last looked' },
  day: { icon: CalendarDays, tone: 'quiet', label: 'Day' },
  earlier: { icon: History, tone: 'quiet', label: 'Earlier events' },
};
/** One row's parts: its node, the sentence beside it, small state badges, quiet meta, actions, and the card below. */
interface Parts {
  node: NodeKind;
  title: ReactNode;
  badges?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  body?: ReactNode;
  /** Bots and events: muted title, no card. */
  quiet?: boolean;
  /** Something in it is new to the reader: the node carries a dot. */
  unread?: boolean;
}
const DAY_MS = 86_400_000;
const dayOf = (at: string) => new Date(at).toDateString();
function dayLabel(at: string) {
  const date = new Date(at);
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  });
}
/** A state badge: words first, tone second. */
function Badge({ tone, children }: { tone: 'new' | 'review' | 'success' | 'warning' | 'danger' | 'neutral'; children: ReactNode }) {
  return (
    <span className="feedback-badge" data-tone={tone}>
      {tone === 'new' && <span className="pr-unread-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

const excerpt = (item: FeedbackItem) =>
  (item.comments[0]?.isMinimized ? minimizedLabel(item.comments[0]) : plainCommentText(item.comments[0]?.body ?? '')).slice(0, 160) ||
  ({ APPROVED: 'Approved this PR', CHANGES_REQUESTED: 'Requested changes', DISMISSED: 'Review dismissed' }[item.state ?? ''] ??
    'Commented on this PR');
const fileName = (path: string) => path.split('/').at(-1) || path;
const lineOf = (item: FeedbackItem) => item.thread?.line ?? diffHunkAnchor(item.comments[0]?.diffHunk)?.line;
const isBot = (login?: string, type?: string) => type === 'Bot' || /\[bot\]$/i.test(login ?? '');
const short = (sha?: string) => sha?.slice(0, 7) ?? '';
/** How long an item stays mostly on screen before it counts as read. */
const READ_DWELL_MS = 1200;

/** A review's verdict in words and a symbol, never colour alone. */
function Verdict({ state }: { state?: string }) {
  const Icon = state === 'APPROVED' ? CircleCheck : state === 'CHANGES_REQUESTED' ? CircleAlert : MessageSquare;
  return (
    <span className="feedback-verdict" data-state={state}>
      <Icon size={13} aria-hidden="true" />
      {feedbackStateLabel(state)}
    </span>
  );
}
function Time({ at }: { at: string }) {
  return (
    <time dateTime={at} title={new Date(at).toLocaleString()}>
      {timeAgo(at)}
    </time>
  );
}
function Source({ member, show }: { member: ReviewMember; show: boolean }) {
  return show ? (
    <span className="feedback-source" title={`#${member.number} ${member.title}`}>
      <SubjectIcon kind="pr" pr={member} />#{member.number}
    </span>
  ) : null;
}

/**
 * Feedback as one page: the PR's conversation in the order it happened (#418). The description, comments, reviews
 * with their verdicts, code threads in their code, pushes and events read top to bottom across the full width.
 * Code threads draw their excerpt with Changes' own diff. Bots stay quiet and collapse when they repeat themselves.
 * A slim bar keeps the counts, filters and next-unresolved navigation in reach, and a divider marks what is new.
 */
export function PrFeedbackView({
  subject,
  account,
  initialPrUrl,
  initialThreadId,
  preferences,
  intent,
  onIntentHandled,
  onSource,
  band,
  sidebar,
  scroller,
  onOpenChanges,
}: {
  subject: ReviewSubject;
  account: string | null;
  initialPrUrl?: string;
  initialThreadId?: string;
  preferences?: Preferences;
  intent?: 'address' | 'request' | ResponseIntent;
  onIntentHandled?: () => void;
  onSource: (item: FeedbackItem) => void;
  /** Above the timeline and side column, scrolling away: the briefing and merge readiness (Conversation page). */
  band?: ReactNode;
  /** The side column beside the timeline, from the same discussions. */
  sidebar?: (values: Record<string, GitHubReviewThreads | undefined>) => ReactNode;
  /** The page that scrolls, when the timeline is part of one; otherwise the timeline scrolls itself. */
  scroller?: RefObject<HTMLElement | null>;
  onOpenChanges?: () => void;
}) {
  countRender('PrFeedbackView');
  const discussions = useEvidenceDiscussions(subject, account, true, true);
  const scope = `${account}:${subject.id}`;
  const [lastResolved, setLastResolved] = useState<FeedbackItem>();
  const [undoBusy, setUndoBusy] = useState(false);
  const [completed, setCompleted] = useState(false);
  const undoLock = useRef(false);
  const [requestsOpen, setRequestsOpen] = useState(intent === 'request');
  const initialSelection = useRef(false);
  const [responseOnly, setResponseOnly] = useState(intent === 'response-threads');
  useEffect(() => {
    if (intent === 'request') onIntentHandled?.();
  }, [intent]);
  const [filter, setFilter] = useSessionDraft<Filter>(`feedback-filter:${scope}`, 'all');
  const [activeKey, setActiveKey] = useSessionDraft<string | undefined>(`feedback-active:${scope}`, undefined);
  const [expanded, setExpanded] = useSessionDraft<string[]>(`feedback-expanded:${scope}`, []);
  const [prUrl, setPrUrl] = useState(initialPrUrl ?? '');
  const [version, rerender] = useState(0);
  const [savingOptions, setSavingOptions] = useState(false);
  const [optionsError, setOptionsError] = useState('');
  const hideGitHubActions = !account || readReviewState(feedbackOptionsKey(account)) !== false;
  const [readError, setReadError] = useState('');
  const [writeError, setWriteError] = useState('');
  const [requesting, setRequesting] = useState('');
  const [requested, setRequested] = useState<Set<string>>(new Set());
  const root = useRef<HTMLDivElement>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const complete = useRef<HTMLHeadingElement>(null);
  const writeLock = useRef(false);
  const readPending = useRef(new Set<string>());
  // Each item's read write while it is on its way, so a Mark unread made meanwhile lands after it, not before.
  const readWrites = useRef(new Map<string, Promise<unknown>>());
  /** Marked unread in this visit: stays unread while on screen, until the reader acts on it. */
  const keptUnread = useRef(new Set<string>());
  const stack = subject.kind === 'stack';
  const members = subject.members.filter((member) => !prUrl || member.url === prUrl);
  const all = useMemo(
    () => subject.members.flatMap((member) => feedbackItems(member, discussions.values[member.url])),
    [subject.members, discussions.values]
  );
  const scoped = all.filter(
    (item) => (!prUrl || item.member.url === prUrl) && (!hideGitHubActions || !isGitHubActionsFeedback(item))
  );
  const hiddenActions =
    hideGitHubActions && all.some((item) => (!prUrl || item.member.url === prUrl) && isGitHubActionsFeedback(item));
  const isUnread = (item: FeedbackItem) => {
    if (!account) return false;
    const fingerprint = feedbackFingerprint(item, account);
    return !!fingerprint && readReviewState(feedbackReadKey(account, item)) !== fingerprint;
  };
  const needsResponse = (item: FeedbackItem) =>
    !!item.thread &&
    (responseOnly && account ? isResponseThread(item.thread, account, item.member.author) : isUnresolvedThread(item.thread));
  const mentions = (item: FeedbackItem) => !!account && mentionsAccount(item, account);
  const counts = {
    all: scoped.length,
    unresolved: scoped.filter(needsResponse).length,
    unread: scoped.filter(isUnread).length,
    mentions: scoped.filter(mentions).length,
  };
  const matches = (item: FeedbackItem) =>
    filter === 'all' ||
    (filter === 'unread' ? isUnread(item) : filter === 'unresolved' ? needsResponse(item) : mentions(item));
  const activeItemKey = activeKey;
  const events = useMemo(
    () => new Map(subject.members.map((m) => [m.url, discussions.values[m.url]?.feedback ?? {}])),
    [subject.members, discussions.values]
  );
  // Rows keep their identity while only the cursor moves, so rows on screen do not render again (MemoRow).
  const shownKey = scoped.filter((item) => matches(item) || feedbackKey(item) === activeItemKey).map(feedbackKey).join('|');
  const entries = useMemo(
    () => {
      const keys = new Set(shownKey.split('|'));
      return buildTimeline(members, scoped.filter((item) => keys.has(feedbackKey(item))), events, { conversationOnly: filter !== 'all' });
    },
    [all, events, shownKey, filter, prUrl]
  );
  const snapshotMissing = subject.members.filter((m) => !discussions.values[m.url]?.feedback);
  const failures = subject.members.filter((m) => discussions.errors[m.url]);
  const showingSaved = subject.members.some((m) => discussions.values[m.url]?.stale);
  // "New since you last looked": fixed for this visit at the first conversation with unread comments, so it does not
  // move while the reader reads. Not shown when everything is new.
  const divider = useRef<string | null | undefined>(undefined);
  if (divider.current === undefined && !snapshotMissing.length && account && entries.length) {
    const full = buildTimeline(members, scoped, events);
    const first = full.findIndex((entry) => entryItems(entry).some(isUnread));
    // Only when something before it was read: a first visit has nothing to divide.
    divider.current = first > 0 && full.slice(0, first).some((entry) => entryItems(entry).length > 0) ? full[first].key : null;
  }
  // Day markers part the rail by day; a jump of two days or more says how long the conversation paused.
  const dividerKey = divider.current;
  const rows = useMemo(() => {
    const result: Row[] = [];
    let previous: string | undefined;
    for (const entry of entries) {
      // The first day needs no marker: the first entry carries its date.
      if (previous && dayOf(previous) !== dayOf(entry.at)) {
        const days = previous ? Math.round((new Date(dayOf(entry.at)).getTime() - new Date(dayOf(previous)).getTime()) / DAY_MS) : 0;
        result.push({ type: 'day', key: `day:${dayOf(entry.at)}`, at: entry.at, label: dayLabel(entry.at), gap: days >= 2 ? `${days} days later` : undefined });
      }
      if (entry.key === dividerKey) result.push({ type: 'divider', key: 'new-since', at: entry.at });
      result.push(entry);
      previous = entry.at;
    }
    return result;
  }, [entries, dividerKey]);
  const newFrom = rows.findIndex((row) => row.type === 'divider');
  const navigable = rows.filter((row) => !isMarker(row));
  const activeIndex = navigable.findIndex((row) => row.key === activeKey);
  const scrollRef = scroller ?? timeline;
  const toolbar = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ margin: 0, bar: 0 });
  // After the commit: the page's ref is attached once its children have mounted.
  useEffect(() => {
    const page = scroller?.current;
    const list = timeline.current;
    if (!page || !list) return;
    page.setAttribute('data-diff-scroller', '');
    page.setAttribute('data-feedback-scroller', '');
    const measure = () => {
      const margin = Math.round(list.getBoundingClientRect().top - page.getBoundingClientRect().top + page.scrollTop);
      const bar = toolbar.current?.offsetHeight ?? 0;
      setLayout((current) => (current.margin === margin && current.bar === bar ? current : { margin, bar }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(page);
    if (root.current) observer.observe(root.current);
    return () => {
      observer.disconnect();
      page.removeAttribute('data-diff-scroller');
      page.removeAttribute('data-feedback-scroller');
    };
  }, [scroller]);
  // The timeline's rows render in a transition after the page shows, never inside the tab switch that reveals it: the
  // page is kept hidden behind other tabs (PrSummary's KeptTab), and rendering its rows, code excerpts and measuring
  // them in the click took about 270 ms on Linux CI (#418). Hidden, the rows unmount; the frame keeps its height, so
  // the page's scroll position holds.
  const [rowsShown, setRowsShown] = useState(false);
  useLayoutEffect(() => {
    startTransition(() => setRowsShown(true));
    return () => setRowsShown(false);
  }, []);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    // In a page, the rows start below the band; the pinned bar covers the top of the view.
    scrollMargin: layout.margin,
    scrollPaddingStart: layout.bar,
    estimateSize: (index) => {
      const row = rows[index];
      if (row.type === 'item') return row.item.thread ? (row.item.thread.isResolved ? 48 : 360) : 140;
      if (row.type === 'commits') return 52 + Math.min(row.commits.length, BIG_GROUP) * 28;
      if (row.type === 'day') return 56;
      return row.type === 'description' ? 200 : 44;
    },
    overscan: 4,
    getItemKey: (index) => rows[index].key,
    paddingStart: 4,
    paddingEnd: 48,
  });
  useVirtualizerSettled('feedback-timeline', virtual, rowsShown);
  /** Scroll an entry to the top of the timeline and move the keyboard cursor to it. */
  function goTo(key: string | undefined, focus = true) {
    if (!key) return;
    const index = rows.findIndex((row) => row.key === key);
    if (index < 0) return;
    setActiveKey(key);
    setCompleted(false);
    virtual.scrollToIndex(index, { align: 'start' });
    let frames = 0;
    const settle = () => {
      const element = timeline.current?.querySelector<HTMLElement>(`[data-entry-key="${CSS.escape(key)}"]`);
      if (element) {
        // Sizes settle as code excerpts mount; align once more on the frame after.
        if (frames++ < 2) virtual.scrollToIndex(index, { align: 'start' });
        if (focus) element.focus({ preventScroll: true });
      }
      if (frames < 3) requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  }
  const keyOf = (item: FeedbackItem) =>
    entries.find((entry) => entryItems(entry).some((i) => feedbackKey(i) === feedbackKey(item)))?.key;
  function select(item: FeedbackItem) {
    setWriteError('');
    goTo(keyOf(item));
  }
  /** The next code thread that needs a response after `from`, wrapping to the top. */
  function nextUnresolved(from = activeIndex, skip?: FeedbackItem) {
    const order = [...navigable.slice(from + 1), ...navigable.slice(0, Math.max(0, from + 1))];
    return order
      .flatMap((row) => (isMarker(row) ? [] : entryItems(row)))
      .find((item) => needsResponse(item) && (!skip || feedbackKey(item) !== feedbackKey(skip)));
  }
  const latest = useRef({ nextUnresolved, select });
  latest.current = { nextUnresolved, select };
  function resolvedNext(item: FeedbackItem) {
    const at = navigable.findIndex((row) => !isMarker(row) && entryItems(row).some((i) => feedbackKey(i) === feedbackKey(item)));
    const next = latest.current.nextUnresolved(at, item);
    if (next) latest.current.select(next);
    else {
      setCompleted(true);
      requestAnimationFrame(() => complete.current?.focus({ preventScroll: true }));
    }
  }
  // Entry: a requested thread or queue reason, else the divider. Once per visit.
  useEffect(() => {
    if (initialSelection.current || !account || !rows.length) return;
    if (intent?.startsWith('response')) {
      if (!subject.members.filter((m) => !prUrl || m.url === prUrl).every((m) => discussions.values[m.url]?.feedback)) return;
      initialSelection.current = true;
      const first = responseFeedbackTarget(scoped, account, intent as ResponseIntent);
      const threadsOnly = intent === 'response-threads' || (intent === 'response' && !!first?.thread);
      setResponseOnly(threadsOnly);
      setFilter(threadsOnly ? 'unresolved' : 'all');
      setCompleted(!first);
      onIntentHandled?.();
      if (first) requestAnimationFrame(() => latest.current.select(first));
      return;
    }
    if (initialThreadId || intent === 'address') {
      const target = initialThreadId ? scoped.find((item) => item.id === initialThreadId) : undefined;
      if (initialThreadId && !target) return;
      initialSelection.current = true;
      setFilter('all');
      const first =
        target ??
        scoped.find((item) => item.state === 'CHANGES_REQUESTED') ??
        scoped.find((item) => item.thread && !item.thread.isResolved) ??
        scoped[0];
      onIntentHandled?.();
      if (first) requestAnimationFrame(() => latest.current.select(first));
      return;
    }
    if (divider.current === undefined) return;
    initialSelection.current = true;
    if (activeKey && rows.some((row) => row.key === activeKey)) goTo(activeKey, false);
    // A page restored to where the reader left it stays there.
    else if (divider.current && !scroller?.current?.scrollTop) virtual.scrollToIndex(rows.findIndex((row) => row.key === 'new-since'), { align: 'start' });
  }, [intent, initialThreadId, rows.length, account, discussions.values, divider.current]);
  function markRead(item: FeedbackItem) {
    if (!account || document.visibilityState === 'hidden') return;
    const key = feedbackReadKey(account, item);
    const fingerprint = feedbackFingerprint(item, account);
    if (!fingerprint || keptUnread.current.has(key) || readReviewState(key) === fingerprint) return;
    if (readPending.current.has(key + fingerprint)) return;
    readPending.current.add(key + fingerprint);
    const write = writeReviewState(key, fingerprint);
    readWrites.current.set(key, write);
    void write
      .then(
        () => {
          setReadError('');
          rerender((n) => n + 1);
        },
        () => setReadError('Could not save read status. Scroll back to the conversation to retry.')
      )
      .finally(() => {
        readPending.current.delete(key + fingerprint);
        if (readWrites.current.get(key) === write) readWrites.current.delete(key);
      });
  }
  async function markUnread(item: FeedbackItem) {
    if (!account) return;
    const key = feedbackReadKey(account, item);
    try {
      keptUnread.current.add(key);
      // A read on its way (its dwell ended just before) must not land after this and mark it read again.
      await readWrites.current.get(key)?.catch(() => undefined);
      await writeReviewState(key, null);
      rerender((n) => n + 1);
    } catch {
      keptUnread.current.delete(key);
      setReadError('Could not save unread status. Try again.');
    }
  }
  async function undoResolution() {
    if (!lastResolved || undoLock.current) return;
    undoLock.current = true;
    setUndoBusy(true);
    setWriteError('');
    try {
      const next = await window.electronAPI.reviewThreadAction({
        prUrl: lastResolved.member.url,
        threadId: lastResolved.id,
        action: 'unresolve',
      });
      replaceDiscussionThread(lastResolved.member.url, next);
      if (prUrl && lastResolved.member.url !== prUrl) setPrUrl(lastResolved.member.url);
      const reopened = lastResolved;
      setLastResolved((current) => (current?.id === reopened.id ? undefined : current));
      requestAnimationFrame(() => latest.current.select(reopened));
    } catch {
      setWriteError('Could not reopen the thread. Try Undo again.');
    } finally {
      undoLock.current = false;
      setUndoBusy(false);
    }
  }
  async function changeActionsFilter(hide: boolean) {
    if (!account || savingOptions) return;
    setSavingOptions(true);
    setOptionsError('');
    try {
      await writeReviewState(feedbackOptionsKey(account), hide);
      rerender((n) => n + 1);
    } catch {
      setOptionsError('Could not save the GitHub Actions filter. Try again.');
    } finally {
      setSavingOptions(false);
    }
  }
  /** The reviewer shows as requested at once; a failure rolls that back with Retry. */
  function requestReview(url: string, login: string, reviewId: string) {
    if (writeLock.current) return;
    writeLock.current = true;
    const key = `${url}:${login}:${reviewId}`;
    setRequesting(key);
    void optimisticWrite({
      key: `request-review:${url}:${login.toLowerCase()}`,
      action: 'request-review',
      write: async () => {
        await window.electronAPI.feedbackAction({ prUrl: url, action: 'request-review', reviewer: login });
        setRequested((previous) => new Set([...previous, key]));
        void refreshDiscussion(url).catch(() =>
          setWriteError('Review requested. Could not refresh feedback; your request was sent.')
        );
      },
    }).finally(() => {
      writeLock.current = false;
      setRequesting('');
    });
  }
  const reviewers = members.flatMap((member) => {
    const snapshot = discussions.values[member.url];
    return snapshot
      ? feedbackReviewers(snapshot).map((reviewer) => ({
          ...reviewer,
          member,
          allowed: snapshot.feedback?.viewerCanUpdate && snapshot.feedback.state === 'OPEN',
        }))
      : [];
  });
  const activeRow = navigable[activeIndex] as TimelineEntry | undefined;
  /** Keys press the active item's own buttons, so they do exactly what a click does. */
  const press = (label: RegExp) => {
    if (!activeRow) return false;
    const element = timeline.current?.querySelector(`[data-entry-key="${CSS.escape(activeRow.key)}"]`);
    const button = [...(element?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (b) => label.test(b.textContent.trim()) && !b.disabled
    );
    if (!button) return false;
    button.click();
  };
  const move = (by: number) => {
    const next = navigable[Math.max(0, Math.min(navigable.length - 1, (activeIndex < 0 ? (by > 0 ? -1 : navigable.length) : activeIndex) + by))];
    if (!next) return false;
    goTo(next.key);
  };
  const goNextUnresolved = () => {
    const next = nextUnresolved();
    if (!next) return false;
    select(next);
  };
  // Feedback's keys run before the PR's own j/k (PrSummary), which move between PRs elsewhere: here they move
  // between timeline items. They apply only while this tab is visible.
  useKeyboardShortcuts(
    {
      // Inside the page, j and k move between items; elsewhere they keep moving between PRs (PrSummary).
      j: () => (root.current?.contains(document.activeElement) ? move(1) : false),
      k: () => (root.current?.contains(document.activeElement) ? move(-1) : false),
      ArrowDown: (e) => (e.target === timeline.current || (e.target as HTMLElement).dataset.entryKey ? move(1) : false),
      ArrowUp: (e) => (e.target === timeline.current || (e.target as HTMLElement).dataset.entryKey ? move(-1) : false),
      n: goNextUnresolved,
      r: () => press(/^Reply$/),
      e: () => press(/^Resolve thread$/),
      u: () => {
        const item = activeRow && entryItems(activeRow)[0];
        if (!item) return false;
        void markUnread(item);
      },
    },
    { capture: true, scope: root, enabled: !!account }
  );
  if (!account)
    return (
      <div className="feedback-empty">
        <MessageSquare aria-hidden="true" />
        <h2>Connect GitHub to read feedback</h2>
        <p>Your local notes remain available in the Local notes tab.</p>
      </div>
    );
  const discussion = {
    discussions: Object.fromEntries(
      Object.entries(discussions.values).map(([url, data]) => [url, { data, error: discussions.errors[url]?.message }])
    ),
    refresh: async (url: string) => {
      await refreshDiscussion(url);
    },
    replace: replaceDiscussionThread,
  };
  const toggle = (key: string) =>
    setExpanded((current) => (current.includes(key) ? current.filter((k) => k !== key) : [...current, key]));
  const pr = (member: ReviewMember) => <Source member={member} show={stack} />;
  const when = (at: string) => <Time at={at} />;
  const itemBadges = (item: FeedbackItem) => (
    <>
      {isUnread(item) && <Badge tone="new">New</Badge>}
      {mentions(item) && (
        <Badge tone="review">
          <AtSign size={11} aria-hidden="true" />
          Mentions you
        </Badge>
      )}
    </>
  );
  const itemActions = (item: FeedbackItem, extra?: ReactNode) => (
    <>
      {extra}
      <Button variant="ghost" size="sm" onClick={() => void markUnread(item)} disabled={isUnread(item)}>
        Mark unread
      </Button>
      {item.comments[0]?.url && (
        <Button variant="ghost" size="sm" onClick={() => void window.electronAPI.openExternal(item.comments.at(-1)?.url || item.comments[0].url)}>
          On GitHub
        </Button>
      )}
    </>
  );
  const Actor = ({ login, bot }: { login: string; bot?: boolean }) => (
    <span className="timeline-actor">
      <GitHubAuthor login={login} bot={bot} />
    </span>
  );
  const renderRow = (row: Row): Parts => {
    switch (row.type) {
      case 'day':
        return { node: 'day', title: row.label, meta: row.gap && <span className="feedback-gap-label">{row.gap}</span>, quiet: true };
      case 'divider':
        return { node: 'new', title: 'New since you last looked', quiet: true };
      case 'description':
        // The description itself sits at the top of the page (PrDescription); the timeline marks when the PR opened.
        return {
          node: 'description',
          quiet: true,
          title: (
            <>
              <strong className="timeline-actor-name">{row.member.author}</strong> opened this PR
            </>
          ),
          meta: (
            <>
              {pr(row.member)}
              {when(row.at)}
            </>
          ),
        };
      case 'earlier':
        return {
          node: 'earlier',
          quiet: true,
          title: 'Earlier commits and events are on GitHub',
          actions: (
            <Button variant="ghost" size="sm" onClick={() => void window.electronAPI.openExternal(row.member.url)}>
              Open the PR
            </Button>
          ),
        };
      case 'commits': {
        // A big push shows what is in it and a few subjects; Show all opens it in place (BIG_GROUP).
        const total = row.commits.length;
        const big = total > BIG_GROUP;
        const open = !big || expanded.includes(row.key);
        const summary = big ? summarizeCommits(row.commits) : undefined;
        const commitItem = (commit: (typeof row.commits)[number]) => (
          <li key={commit.id}>
            <span className="feedback-commit-message" title={commit.message}>{commit.message}</span>
            <code>{short(commit.sha)}</code>
            <Button variant="ghost" size="icon-sm" aria-label={`Copy commit ${short(commit.sha)}`} title="Copy commit SHA" onClick={() => void navigator.clipboard.writeText(commit.sha)}>
              <Copy size={13} />
            </Button>
          </li>
        );
        return {
          node: 'commits',
          quiet: true,
          title: (
            <>
              <strong className="timeline-actor-name">{row.author ?? 'Someone'}</strong>{' '}
              {total === 1 ? 'pushed a commit' : `pushed ${total} commits`}
            </>
          ),
          meta: (
            <>
              {pr(row.member)}
              {when(row.commits.at(-1)?.at ?? row.at)}
            </>
          ),
          body: (
            <div className="feedback-group" data-collapsed={!open || undefined}>
              {summary && <p className="feedback-group-summary">{summary.line}</p>}
              <ul className="feedback-commits">
                {!open && summary
                  ? summary.preview.map(commitItem)
                  : commitLines(row.commits).map((line) => {
                      if (line.type === 'commit') return commitItem(line.commit);
                      const key = `${row.key}:merges:${line.source}`;
                      const shown = expanded.includes(key);
                      return (
                        <li key={key} className="feedback-merge-group">
                          <button className="feedback-merge-toggle" aria-expanded={shown} onClick={() => toggle(key)}>
                            <ChevronRight size={13} aria-hidden="true" className="feedback-chevron" />
                            {line.commits.length} {line.commits.length === 1 ? 'merge' : 'merges'} from <code>{line.source}</code>
                          </button>
                          {shown && <ul className="feedback-commits">{line.commits.map(commitItem)}</ul>}
                        </li>
                      );
                    })}
              </ul>
              {big && (
                <Button variant="ghost" size="sm" className="feedback-group-toggle" aria-expanded={open} onClick={() => toggle(row.key)}>
                  {open ? 'Show less' : `Show all ${total} commits`}
                </Button>
              )}
            </div>
          ),
        };
      }
      case 'events': {
        // Several force-pushes or review requests in a row: one row, its first few lines, then Show all.
        const total = row.events.length;
        const big = total > GROUP_PREVIEW;
        const open = !big || expanded.includes(row.key);
        return {
          node: row.kind,
          quiet: true,
          title: (
            <>
              <strong className="timeline-actor-name">{row.actor ?? 'Someone'}</strong>{' '}
              {row.kind === 'force-push' ? `force-pushed ${total} times` : `requested ${total} reviews`}
            </>
          ),
          meta: (
            <>
              {pr(row.member)}
              {when(row.events.at(-1)?.at ?? row.at)}
            </>
          ),
          body: (
            <div className="feedback-group" data-collapsed={!open || undefined}>
              <ul className="feedback-commits">
                {(open ? row.events : row.events.slice(0, GROUP_PREVIEW)).map((event) => (
                  <li key={event.id}>
                    <span className="feedback-commit-message">
                      {event.kind === 'force-push' ? (
                        event.before && event.after ? (
                          <>
                            from <code>{short(event.before)}</code> to <code>{short(event.after)}</code>
                          </>
                        ) : (
                          'force-pushed'
                        )
                      ) : event.kind === 'review-requested' ? (
                        <>from {event.reviewer}</>
                      ) : null}
                    </span>
                    <Time at={event.at} />
                  </li>
                ))}
              </ul>
              {big && (
                <Button variant="ghost" size="sm" className="feedback-group-toggle" aria-expanded={open} onClick={() => toggle(row.key)}>
                  {open ? 'Show less' : `Show all ${total}`}
                </Button>
              )}
            </div>
          ),
        };
      }
      case 'event': {
        const { event } = row;
        return {
          node: event.kind,
          quiet: true,
          title: (
            <>
              <strong className="timeline-actor-name">{event.actor ?? 'Someone'}</strong>{' '}
              {event.kind === 'force-push' ? (
                <>
                  force-pushed
                  {event.before && event.after ? (
                    <>
                      {' '}from <code>{short(event.before)}</code> to <code>{short(event.after)}</code>
                    </>
                  ) : null}
                </>
              ) : event.kind === 'review-requested' ? (
                <>
                  requested a review from <strong className="timeline-actor-name">{event.reviewer}</strong>
                </>
              ) : event.kind === 'merged' ? (
                'merged this PR'
              ) : event.kind === 'closed' ? (
                'closed this PR'
              ) : (
                'reopened this PR'
              )}
            </>
          ),
          meta: (
            <>
              {pr(row.member)}
              {when(event.at)}
            </>
          ),
        };
      }
      case 'bots': {
        const open = expanded.includes(row.key);
        const unread = row.items.some(isUnread);
        return {
          node: 'bot',
          quiet: true,
          unread,
          title: (
            <>
              <strong className="timeline-actor-name">{row.login.replace(/\[bot\]$/i, '')}</strong>{' '}
              <span className="feedback-bot-tag">bot</span> · {row.items.length} comments
            </>
          ),
          badges: unread && <Badge tone="new">New</Badge>,
          meta: when(row.items.at(-1)?.comments[0]?.createdAt ?? row.at),
          body: (
            <div className="feedback-bots" data-open={open || undefined}>
              <button className="feedback-bots-summary" aria-expanded={open} onClick={() => toggle(row.key)}>
                <ChevronRight size={14} aria-hidden="true" className="feedback-chevron" />
                <span className="feedback-bots-text">{botSummary(row.items.map((item) => excerpt(item)))}</span>
                <span className="feedback-bots-hint">{open ? 'Show less' : `Show all ${row.items.length} comments`}</span>
              </button>
              {open &&
                row.items.map((item) => (
                  <MessageEntry
                    key={item.id}
                    item={item}
                    quiet
                    header={
                      <div className="feedback-message-header">
                        <span>{when(item.comments[0].createdAt)}</span>
                        {isUnread(item) && <Badge tone="new">New</Badge>}
                        <span className="timeline-actions">{itemActions(item)}</span>
                      </div>
                    }
                    onReply={(body) => replyToFeedback(item, body)}
                  />
                ))}
            </div>
          ),
        };
      }
      case 'item': {
        const { item } = row;
        const author = item.comments[0]?.author;
        const actor = author ? <Actor login={author.login} bot={isBot(author.login, author.__typename)} /> : <strong>Deleted account</strong>;
        if (!item.thread) {
          const review = item.kind === 'review';
          const node: NodeKind = row.bot
            ? 'bot'
            : !review
              ? 'comment'
              : item.state === 'APPROVED'
                ? 'approved'
                : item.state === 'CHANGES_REQUESTED'
                  ? 'changes-requested'
                  : item.state === 'DISMISSED'
                    ? 'dismissed'
                    : 'reviewed';
          const verb = !review
            ? 'commented'
            : item.state === 'APPROVED'
              ? 'approved these changes'
              : item.state === 'CHANGES_REQUESTED'
                ? 'requested changes'
                : item.state === 'DISMISSED'
                  ? 'had a review dismissed'
                  : 'reviewed';
          const event = review && !item.comments[0]?.body.trim();
          return {
            node,
            quiet: row.bot,
            unread: isUnread(item),
            title: (
              <>
                {actor} {verb}
              </>
            ),
            badges: (
              <>
                {review && <Verdict state={item.state} />}
                {itemBadges(item)}
              </>
            ),
            meta: (
              <>
                {pr(item.member)}
                {item.comments[0]?.sending ? <span className="github-sending" role="status">Sending…</span> : when(item.comments[0]?.createdAt ?? row.at)}
              </>
            ),
            actions: !event && itemActions(item),
            body: event ? undefined : (
              <MessageEntry
                item={item}
                quiet={row.bot}
                onReply={(body) => replyToFeedback(item, body)}
                related={item.relatedThreads.flatMap((id) => {
                  const thread = all.find((r) => r.member.url === item.member.url && r.id === id);
                  return thread ? [thread] : [];
                })}
                onSelect={select}
              />
            ),
          };
        }
        const thread = chronologicalThread(item.thread);
        const open = !thread.isResolved || !!thread.sending || expanded.includes(row.key);
        const location = `${fileName(thread.path)}${lineOf(item) != null ? `:${lineOf(item)}` : ''}`;
        const toggleButton = thread.isResolved && (
          <Button variant="ghost" size="sm" className="feedback-resolved-summary" aria-expanded={open} onClick={() => toggle(row.key)}>
            <ChevronRight size={14} aria-hidden="true" className="feedback-chevron" />
            {open ? 'Hide conversation' : 'Show conversation'}
          </Button>
        );
        return {
          unread: isUnread(item),
          node: thread.isResolved ? 'thread-resolved' : thread.isOutdated ? 'thread-outdated' : 'thread-unresolved',
          title: (
            <>
              {actor} commented on <code className="timeline-object" title={thread.path}>{location}</code>
            </>
          ),
          badges: (
            <>
              {thread.isResolved ? (
                <Badge tone="success">
                  <Check size={11} aria-hidden="true" />
                  Resolved
                </Badge>
              ) : isUnresolvedThread(thread) ? (
                <Badge tone="review">Unresolved</Badge>
              ) : (
                <Badge tone="neutral">Not submitted</Badge>
              )}
              {thread.isOutdated && <Badge tone="warning">Outdated</Badge>}
              {itemBadges(item)}
              {!open && (
                <span className="timeline-meta-text">
                  {thread.comments.length} {thread.comments.length === 1 ? 'comment' : 'comments'}
                  {thread.resolvedBy ? ` · resolved by ${thread.resolvedBy.login}` : ''}
                </span>
              )}
            </>
          ),
          meta: (
            <>
              {pr(item.member)}
              {when(item.comments.at(-1)?.createdAt ?? row.at)}
            </>
          ),
          actions: toggleButton,
          body: open && (
            <ThreadEntry
              item={item}
              thread={thread}
              preferences={preferences}
              discussion={discussion}
              unread={isUnread(item)}
              onMarkUnread={() => void markUnread(item)}
              onSource={() => onSource(item)}
              onResolvedNext={() => resolvedNext(item)}
              onResolving={() =>
                // Resolving here keeps the thread open in place, before GitHub answers; it collapses on the next visit.
                setExpanded((current) => (current.includes(row.key) ? current : [...current, row.key]))
              }
              onResolved={(next) => {
                if (next.viewerCanUnresolve) setLastResolved(item);
              }}
              onReopened={() => setLastResolved((current) => (current?.id === item.id ? undefined : current))}
            />
          ),
        };
      }
    }
  };
  async function replyToFeedback(item: FeedbackItem, body: string) {
    await window.electronAPI.feedbackAction({ prUrl: item.member.url, action: 'reply', sourceId: item.id, body });
    void refreshDiscussion(item.member.url).catch(() =>
      setWriteError('Reply posted. Could not refresh feedback; your reply was sent.')
    );
  }
  const filterLabels: Record<Filter, string> = { all: 'All', unresolved: 'Unresolved', unread: 'Unread', mentions: 'Mentions' };
  return (
    <ReviewDraftBoundary value={`feedback:${account}`}>
      <div className="feedback-workspace feedback-timeline-workspace" data-page={scroller ? '' : undefined} ref={root}>
        {band && <div className="conversation-band">{band}</div>}
        <div className="conversation-grid" data-sidebar={sidebar ? '' : undefined}>
        <div className="conversation-main">
        {scroller && (
          <section className="conversation-description" aria-label="Pull request description">
            {stack && !prUrl ? (
              <StackDescriptions members={subject.members} onOpenChanges={onOpenChanges} />
            ) : (
              <PrDescription member={subject.members.find((member) => member.url === (prUrl || subject.members[0].url)) ?? subject.members[0]} onOpenChanges={onOpenChanges} stack={stack} />
            )}
          </section>
        )}
        <div className="feedback-toolbar" ref={toolbar} role="toolbar" aria-label="Feedback timeline">
          <div className="feedback-filters" role="group" aria-label="Show in the timeline">
            {(['all', 'unresolved', 'unread', 'mentions'] as const).map((value) => (
              <Button
                key={value}
                variant={filter === value ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={filter === value}
                onClick={() => {
                  setCompleted(false);
                  setResponseOnly(false);
                  setFilter(value);
                }}
              >
                {filterLabels[value]} <span>{counts[value]}</span>
              </Button>
            ))}
          </div>
          <nav className="feedback-thread-navigation" aria-label="Timeline navigation">
            <Button
              variant="outline"
              size="sm"
              disabled={!counts.unresolved}
              title="Next unresolved thread (n)"
              onClick={() => goNextUnresolved()}
            >
              Next unresolved
              <ArrowDown size={14} aria-hidden="true" />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Previous item" title="Previous item (k)" disabled={activeIndex === 0 || !navigable.length} onClick={() => move(-1)}>
              <ArrowUp size={15} />
            </Button>
            <span className="feedback-position" aria-live="polite">
              {activeIndex < 0 ? `${navigable.length} items` : `${activeIndex + 1} of ${navigable.length}`}
            </span>
            <Button variant="ghost" size="icon-sm" aria-label="Next item" title="Next item (j)" disabled={activeIndex >= navigable.length - 1} onClick={() => move(1)}>
              <ArrowDown size={15} />
            </Button>
          </nav>
          {stack && (
            <SearchableSelect
              className="feedback-pr-filter"
              label="Filter by PR"
              value={prUrl || 'all'}
              triggerLabel={prUrl ? undefined : 'All PRs'}
              options={[
                { value: 'all', label: 'All PRs' },
                ...subject.members.map((member) => ({
                  value: member.url,
                  label: `#${member.number} ${member.title}`,
                  kind: 'pr' as const,
                  pr: member,
                })),
              ]}
              onValueChange={(value) => setPrUrl(value === 'all' ? '' : value)}
            />
          )}
          <label className="feedback-actions-filter" title="Hide GitHub Actions comments. Conversations with human replies stay visible.">
            <input
              type="checkbox"
              checked={hideGitHubActions}
              disabled={savingOptions}
              onChange={(event) => void changeActionsFilter(event.target.checked)}
            />
            Hide GitHub Actions
          </label>
          {reviewers.length > 0 && (
            <Popover.Root open={requestsOpen} onOpenChange={setRequestsOpen}>
              <Popover.Trigger asChild>
                <Button size="sm" variant="outline" aria-label="Review requests">
                  <Send size={14} />
                  <span className="feedback-review-requests-label">Review requests</span> <span>{reviewers.length}</span>
                </Button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content className="feedback-reviewers" align="end" sideOffset={8} collisionPadding={16} aria-label="Review requests">
                  <header>
                    <h2>Reviewers who requested changes</h2>
                    <Popover.Close asChild>
                      <Button variant="ghost" size="icon-sm" aria-label="Close review requests">
                        <X size={15} />
                      </Button>
                    </Popover.Close>
                  </header>
                  <p>Request another review after addressing their feedback. Unresolved threads stay open.</p>
                  {reviewers.map((r) => (
                    <WriteFailureNotice key={`${r.member.url}:${r.login}`} failureKey={`request-review:${r.member.url}:${r.login.toLowerCase()}`} className="feedback-post-error" />
                  ))}
                  <div>
                    {reviewers.map((r) => {
                      const key = `${r.member.url}:${r.login}:${r.reviewId}`,
                        sent = r.requested || requested.has(key);
                      return (
                        <div className="feedback-reviewer" key={key}>
                          <div className="feedback-reviewer-person">
                            <GitHubAuthor login={r.login} />
                          </div>
                          {stack && (
                            <span className="feedback-source">
                              <SubjectIcon kind="pr" pr={r.member} />#{r.member.number} {r.member.title}
                            </span>
                          )}
                          <span className="feedback-reviewer-state">
                            {r.unresolved ? `${r.unresolved} unresolved ${r.unresolved === 1 ? 'thread' : 'threads'}` : 'No unresolved threads'}
                          </span>
                          <Button
                            size="sm"
                            variant="outline"
                            data-request-review={r.member.number}
                            aria-label={`${sent ? 'Review requested from' : 'Re-request review from'} ${r.login} on PR #${r.member.number}`}
                            disabled={!r.allowed || !!requesting || sent}
                            title={!r.allowed ? 'Review requests require permission to update an open PR.' : undefined}
                            onClick={() => requestReview(r.member.url, r.login, r.reviewId)}
                          >
                            {sent ? <Check size={14} /> : <Send size={14} />}
                            {requesting === key ? 'Requesting…' : sent ? 'Review requested' : 'Re-request review'}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          )}
          <Button variant="ghost" size="icon-sm" aria-label="Refresh feedback" title="Refresh feedback" disabled={discussions.busy} onClick={() => void discussions.refresh()}>
            <RefreshCw size={15} className={discussions.busy ? 'animate-spin' : ''} />
          </Button>
          <span className={`feedback-sync${!discussions.busy && !failures.length && !showingSaved && !snapshotMissing.length ? ' sr-only' : ''}`} role="status">
            {discussions.busy
              ? 'Refreshing…'
              : failures.length || showingSaved
                ? 'Showing saved feedback'
                : snapshotMissing.length
                  ? `${subject.members.length - snapshotMissing.length}/${subject.members.length} PRs loaded`
                  : 'Updates automatically'}
          </span>
        </div>
        {optionsError && <div className="feedback-notice" role="alert">{optionsError}</div>}
        {!completed && !counts.unresolved && reviewers.length > 0 && !snapshotMissing.length && !failures.length && (
          <div className="feedback-follow-up" role="status">
            <div>
              <strong>No unresolved feedback from others. Review approval is still pending.</strong>
              <p>Resolving threads does not dismiss a changes-requested review. Ask the reviewer to check your updates.</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setRequestsOpen(true)}>
              <Send size={14} aria-hidden="true" />
              Re-request review
            </Button>
          </div>
        )}
        {readError && <p className="feedback-notice" role="alert">{readError}</p>}
        {writeError && <p className="feedback-notice" role="alert">{writeError}</p>}
        {failures.length > 0 && (
          <div className="feedback-notice feedback-sync-error" role="alert">
            <span>
              Could not refresh {failures.length === 1 ? `PR #${failures[0].number}` : `${failures.length} PRs`}. Showing saved feedback.
            </span>
            <Popover.Root>
              <Popover.Trigger asChild>
                <Button size="sm" variant="ghost">Details</Button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content className="feedback-error-details" sideOffset={6} collisionPadding={16} aria-label="Refresh errors">
                  {failures.map((m) => (
                    <p key={m.url}>#{m.number} {m.title}: {discussions.errors[m.url]?.message}</p>
                  ))}
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
            <Button size="sm" variant="ghost" onClick={() => void discussions.refresh()}>Retry</Button>
          </div>
        )}
        {lastResolved && (
          <div className="feedback-resolution" role="status">
            <Check size={14} aria-hidden="true" />
            <span title={`PR #${lastResolved.member.number} · ${lastResolved.thread?.path}`}>
              Thread resolved · #{lastResolved.member.number} · {lastResolved.thread?.path}
            </span>
            <button disabled={undoBusy} onClick={() => void undoResolution()}>
              {undoBusy ? 'Restoring…' : 'Undo'}
            </button>
          </div>
        )}
        {completed && (
          <div className="feedback-complete" role="status">
            <Check aria-hidden="true" />
            <div>
              <h2 ref={complete} tabIndex={-1}>
                {snapshotMissing.length || failures.length
                  ? 'Feedback could not be confirmed'
                  : counts.unresolved
                    ? 'More feedback needs attention'
                    : responseOnly
                      ? 'No unresolved feedback from others'
                      : 'No unresolved code threads'}
              </h2>
              <p>
                {reviewers.length > 0
                  ? 'Review approval is still pending. Resolving threads does not approve a PR. Ask the reviewer to check your updates.'
                  : 'Resolving threads does not approve a PR. Review decisions and general comments may still need a response.'}
                {(snapshotMissing.length > 0 || failures.length > 0) && ' Some PR feedback is unavailable. Refresh feedback to check for remaining threads.'}
              </p>
            </div>
            {counts.unresolved > 0 && (
              <Button size="sm" onClick={() => goNextUnresolved()}>Continue with unresolved feedback</Button>
            )}
            {reviewers.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => setRequestsOpen(true)}>Re-request review</Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => { setFilter('all'); setResponseOnly(false); setCompleted(false); }}>
              All conversations
            </Button>
          </div>
        )}
        <div
          className="feedback-timeline"
          ref={timeline}
          role="feed"
          aria-label="PR timeline"
          aria-busy={discussions.busy || undefined}
          tabIndex={-1}
          data-diff-scroller={scroller ? undefined : ''}
          data-feedback-scroller={scroller ? undefined : ''}
        >
          {rows.length ? (
            <Timeline className="feedback-timeline-rail" style={{ height: virtual.getTotalSize(), position: 'relative' }}>
              {rowsShown && virtual.getVirtualItems().map((v) => {
                const row = rows[v.index];
                return (
                  <TimelineRowShell
                    key={v.key}
                    index={v.index}
                    start={v.start - layout.margin}
                    row={row}
                    active={row.key === activeKey}
                    edge={rows.length === 1 ? 'only' : v.index === 0 ? 'first' : v.index === rows.length - 1 ? 'last' : undefined}
                    tone={newFrom < 0 ? undefined : v.index < newFrom ? 'seen' : 'new'}
                    gap={row.type === 'day' && !!row.gap}
                    measure={virtual.measureElement}
                    root={scrollRef}
                    onRead={() => (isMarker(row) ? undefined : entryItems(row).forEach(markRead))}
                    onActivate={() => !isMarker(row) && setActiveKey(row.key)}
                  >
                    <MemoRow
                      row={row}
                      render={renderRow}
                      state={`${expanded.filter((k) => k === row.key || k.startsWith(`${row.key}:`)).join()}|${isMarker(row) ? '' : entryItems(row).map((i) => `${isUnread(i)}${mentions(i)}`).join()}|${stack}|${version}|${row.type === "description" ? `${expanded.includes(`${row.key}:full`)}${row.member.description}${row.member.changedFileCount ?? ""}` : ""}`}
                    />
                  </TimelineRowShell>
                );
              })}
            </Timeline>
          ) : (
            <div className="feedback-empty">
              {snapshotMissing.length && !failures.length ? (
                <>
                  <RefreshCw className="animate-spin" aria-hidden="true" />
                  <h2>Loading feedback</h2>
                  <p>The conversation appears as each PR loads.</p>
                </>
              ) : (
                <>
                  <MessageSquare aria-hidden="true" />
                  <h2>
                    {snapshotMissing.length
                      ? 'Feedback is incomplete'
                      : filter === 'unread'
                        ? 'No unread feedback'
                        : filter === 'unresolved'
                          ? 'No unresolved threads'
                          : filter === 'mentions'
                            ? 'No mentions of you'
                            : hiddenActions
                              ? 'No matching feedback'
                              : 'No feedback yet'}
                  </h2>
                  <p>
                    {failures.length
                      ? 'Some PRs are unavailable. Retry to check their feedback.'
                      : snapshotMissing.length
                        ? 'Some PRs are still loading.'
                        : hiddenActions
                          ? 'GitHub Actions comments are hidden. Clear Hide GitHub Actions to include them.'
                          : filter === 'all'
                            ? 'GitHub comments and reviews will appear here.'
                            : 'Choose All to see the whole conversation.'}
                  </p>
                </>
              )}
            </div>
          )}
        </div>
        </div>
        {sidebar && <div className="conversation-side">{sidebar(discussions.values)}</div>}
        </div>
      </div>
    </ReviewDraftBoundary>
  );
}

/**
 * The PR's description at the top of the Summary page (#418): who opened it and when, its change stats into Changes,
 * and the whole description at reading size, never cut off. It is not sticky: a long one would take the view. GitHub
 * holds the text, so editing opens the PR there.
 */
function PrDescription({ member: m, onOpenChanges, stack }: { member: ReviewMember; onOpenChanges?: () => void; stack: boolean }) {
  return (
    <div className="conversation-description-pr">
      <header className="conversation-description-header">
        <span className="timeline-actor">
          <GitHubAuthor login={m.author} />
        </span>
        <span>opened this PR</span>
        <Source member={m} show={stack} />
        <Time at={m.createdAt} />
        {onOpenChanges && (
          <Button variant="outline" size="sm" className="feedback-description-stats" onClick={onOpenChanges} aria-label="View changed files">
            {m.changedFileCount === undefined ? (
              `${m.commitCount} ${m.commitCount === 1 ? 'commit' : 'commits'}`
            ) : (
              <>
                {m.changedFileCount} {m.changedFileCount === 1 ? 'file' : 'files'}
                <DiffStats additions={m.additions ?? 0} deletions={m.deletions ?? 0} />
              </>
            )}
          </Button>
        )}
        <Button variant="ghost" size="sm" className="conversation-description-edit" onClick={() => void window.electronAPI.openExternal(m.url)}>
          Edit on GitHub
        </Button>
      </header>
      <div className="feedback-entry-card feedback-description-card">
        <div className="feedback-entry-body">
          <section className="pr-description" aria-label={`Author description for PR #${m.number}`}>
            {m.description.trim() ? (
              <Markdown className="pr-markdown" headingLevel={3} githubSource={{ repo: m.headRepo || m.repo, ref: m.headSha || m.headBranch }}>
                {m.description}
              </Markdown>
            ) : (
              <p className="feedback-description-empty">
                No description provided by <GitHubAuthor login={m.author} />.
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/** A stack's descriptions: one line per PR, opening in place to the whole description. The PR picker shows one PR's. */
function StackDescriptions({ members, onOpenChanges }: { members: ReviewMember[]; onOpenChanges?: () => void }) {
  return (
    <div className="conversation-stack-descriptions">
      {members.map((m) => (
        <details key={m.url} className="conversation-member-description">
          <summary>
            <ChevronRight size={14} aria-hidden="true" className="feedback-chevron" />
            <SubjectIcon kind="pr" pr={m} />
            <strong>#{m.number}</strong>
            <span className="conversation-member-title">{m.title}</span>
            <span className="conversation-member-excerpt">{plainCommentText(m.description).slice(0, 140) || 'No description'}</span>
          </summary>
          <PrDescription member={m} onOpenChanges={onOpenChanges} stack />
        </details>
      ))}
    </div>
  );
}

/** A row renders again only when it or its read, mention or expanded state changes, not when the cursor moves. */
const MemoRow = memo(
  function MemoRow({ row, render }: { row: Row; render: (row: Row) => Parts; state: string }) {
    const parts = render(row);
    const node = NODES[parts.node];
    const Icon = node.icon;
    const label = row.type === 'day' ? `${row.label}${row.gap ? `, ${row.gap}` : ''}` : node.label;
    return (
      <>
        <TimelineIndicator label={parts.unread ? `${label}, new` : label} tone={node.tone} data-node-kind={parts.node} data-unread={parts.unread || undefined}>
          {Icon && <Icon size={row.type === 'day' ? 12 : 14} aria-hidden="true" />}
        </TimelineIndicator>
        <TimelineHeader data-quiet={parts.quiet || undefined}>
          <TimelineTitle>{parts.title}</TimelineTitle>
          {parts.badges && <span className="timeline-badges">{parts.badges}</span>}
          {parts.meta && <span className="timeline-meta">{parts.meta}</span>}
          {parts.actions && <span className="timeline-actions">{parts.actions}</span>}
        </TimelineHeader>
        {parts.body && <TimelineContent>{parts.body}</TimelineContent>}
      </>
    );
  },
  // A description reads its PR, which changes in place when the queue refreshes: it always renders again.
  (a, b) => a.row === b.row && a.state === b.state && a.row.type !== 'description'
);

/**
 * One timeline row: measured for the virtualizer, a keyboard stop, and read once it stays mostly on screen for a
 * moment while the window is visible. Clicking inside makes it the keyboard cursor.
 */
function TimelineRowShell({
  index,
  start,
  row,
  active,
  edge,
  tone,
  gap,
  measure,
  root,
  onRead,
  onActivate,
  children,
}: {
  index: number;
  start: number;
  row: Row;
  active: boolean;
  edge?: 'first' | 'last' | 'only';
  tone?: 'seen' | 'new';
  gap: boolean;
  measure: (element: Element | null) => void;
  root: React.RefObject<HTMLElement | null>;
  onRead: () => void;
  onActivate: () => void;
  children: ReactNode;
}) {
  const element = useRef<HTMLDivElement>(null);
  const latestRead = useRef(onRead);
  latestRead.current = onRead;
  const readable = row.type === 'item' || row.type === 'bots';
  useEffect(() => {
    const node = element.current;
    if (!node || !readable) return;
    let timer = 0;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const view = entry.rootBounds?.height ?? innerHeight;
        const seen = entry.intersectionRatio >= 0.6 || entry.intersectionRect.height >= view * 0.5;
        window.clearTimeout(timer);
        if (seen) timer = window.setTimeout(() => latestRead.current(), READ_DWELL_MS);
      },
      { root: root.current, threshold: [0, 0.25, 0.5, 0.6, 0.75, 1] }
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [readable, root]);
  const items = row.type === 'item' ? [row.item] : row.type === 'bots' ? row.items : [];
  return (
    <TimelineItem
      edge={edge}
      ref={(node) => {
        element.current = node;
        measure(node);
      }}
      data-index={index}
      data-entry-key={isMarker(row) ? undefined : row.key}
      data-entry-type={row.type}
      data-feedback-id={items.length === 1 ? items[0].id : undefined}
      data-at={row.at}
      className="feedback-entry"
      aria-current={active || undefined}
      tabIndex={isMarker(row) ? undefined : -1}
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${start}px)` }}
      onPointerDown={() => onActivate()}
      onFocus={(event) => {
        if (event.target === event.currentTarget || !active) onActivate();
      }}
    >
      <TimelineSeparator tone={gap ? 'gap' : tone} />
      {children}
    </TimelineItem>
  );
}

/** A code thread in place: its excerpt from Changes' diff, the conversation under its line, and its actions. */
function ThreadEntry({
  item,
  thread,
  preferences,
  discussion,
  unread,
  onMarkUnread,
  onSource,
  onResolvedNext,
  onResolving,
  onResolved,
  onReopened,
}: {
  item: FeedbackItem;
  thread: NonNullable<FeedbackItem['thread']>;
  preferences?: Preferences;
  discussion: React.ComponentProps<typeof FeedbackCodeThread>['discussion'];
  unread: boolean;
  onMarkUnread: () => void;
  onSource: () => void;
  onResolvedNext: () => void;
  onResolving: () => void;
  onResolved: (next: NonNullable<FeedbackItem['thread']>) => void;
  onReopened: () => void;
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <div className="feedback-thread-entry">
      <FeedbackCodeThread
        item={item}
        thread={thread}
        preferences={preferences}
        discussion={discussion}
        onSource={onSource}
        actions={
          <>
            <Button size="sm" variant="outline" onClick={onMarkUnread} disabled={unread}>
              Mark unread
            </Button>
            <Button size="sm" variant="outline" onClick={onSource}>
              Open in Changes
            </Button>
          </>
        }
        renderThread={(t) => (
          <div className="feedback-inline-thread">
            <GitHubReviewThread
              key={t.id}
              thread={t}
              actionContainer={host}
              onResolvedNext={onResolvedNext}
              expanded
              onAction={async (action, body) => {
                if (action === 'resolve') onResolving();
                const next = await window.electronAPI.reviewThreadAction({ prUrl: item.member.url, threadId: item.id, action, body });
                replaceDiscussionThread(item.member.url, next);
                if (action === 'resolve') onResolved(next);
                if (action === 'unresolve') onReopened();
              }}
              onCommentAction={async (commentId, action, body) => {
                const next = await window.electronAPI.reviewCommentAction({ prUrl: item.member.url, threadId: item.id, commentId, action, body });
                replaceDiscussionThread(item.member.url, next);
              }}
            />
            <div className="feedback-thread-actions" ref={setHost} aria-label="Thread actions" />
          </div>
        )}
      />
    </div>
  );
}

/**
 * A review's code threads as an index under its text: a heading with how many still need a response, then one row per
 * file (its type icon, name and folder) with a chip per thread line. A chip goes to that thread in the timeline. Six or
 * more files show the first few and Show all.
 */
function ReviewThreadIndex({ item, threads, onSelect }: { item: FeedbackItem; threads: FeedbackItem[]; onSelect?: (item: FeedbackItem) => void }) {
  const [all, setAll] = useSessionDraft(`feedback-review-files:${feedbackKey(item)}`, false);
  const files = threadIndex(threads, (t) => t.thread?.path ?? '', lineOf);
  const unresolved = threads.filter((t) => t.thread && !t.thread.isResolved).length;
  const collapsible = files.length > INDEX_FILES + 1;
  const shown = collapsible && !all ? files.slice(0, INDEX_FILES) : files;
  const id = `review-index-${item.id}`;
  return (
    <nav className="feedback-review-index" aria-labelledby={id}>
      <h3 className="feedback-review-index-head" id={id}>
        <span>
          {threads.length} {threads.length === 1 ? 'comment' : 'comments'} on code
        </span>
        {unresolved ? (
          <Badge tone="review">
            <MessageSquareDot size={11} aria-hidden="true" />
            {unresolved} unresolved
          </Badge>
        ) : (
          <Badge tone="success">
            <Check size={11} aria-hidden="true" />
            All resolved
          </Badge>
        )}
      </h3>
      <ul className="feedback-review-files">
        {shown.map((file) => {
          const name = fileName(file.path);
          const folder = file.path.slice(0, file.path.length - name.length).replace(/\/$/, '');
          return (
            <li key={file.path} className="feedback-review-file">
              <span className="feedback-review-path" title={file.path}>
                <FileTypeIcon filePath={file.path} />
                <span className="feedback-review-name">{name}</span>
                {folder && (
                  <span className="feedback-review-folder">
                    {/* Long folders lose their start, not the part beside the file. */}
                    <bdi dir="ltr">{folder}</bdi>
                  </span>
                )}
              </span>
              <span className="feedback-review-lines">
                {file.lines.map(({ thread, line }) => {
                  const resolved = !!thread.thread?.isResolved;
                  const state = resolved ? 'resolved' : 'unresolved';
                  const Icon = resolved ? Check : MessageSquareDot;
                  return (
                    <button
                      key={thread.id}
                      type="button"
                      className="feedback-line-chip"
                      data-state={state}
                      title={`${line != null ? `Line ${line}` : 'File comment'}, ${state}`}
                      onClick={() => onSelect?.(thread)}
                    >
                      <Icon size={12} aria-hidden="true" />
                      {line != null ? `L${line}` : 'File'}
                      <span className="sr-only">
                        {` in ${name}, ${state}`}
                      </span>
                    </button>
                  );
                })}
              </span>
            </li>
          );
        })}
      </ul>
      {collapsible && (
        <Button variant="ghost" size="sm" className="feedback-review-more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Show fewer files' : `Show all ${files.length} files`}
        </Button>
      )}
    </nav>
  );
}

/** A PR comment or review: quiet for bots, with its verdict, and a reply that posts a PR comment linked to it. */
function MessageEntry({
  item,
  quiet,
  header,
  related = [],
  onSelect,
  onReply,
}: {
  item: FeedbackItem;
  quiet?: boolean;
  /** Inside a bot group, each comment names its own time and actions; elsewhere the timeline title does. */
  header?: ReactNode;
  related?: FeedbackItem[];
  onSelect?: (item: FeedbackItem) => void;
  onReply: (body: string) => Promise<void>;
}) {
  const [draft, setDraft] = useSessionDraft(`feedback-reply:${feedbackKey(item)}`, '');
  const [replying, setReplying] = useSessionDraft(`feedback-replying:${feedbackKey(item)}`, false);
  // A reply from a notification that GitHub refused comes back here as a draft.
  useKeptReplyDraft(
    `feedback:${feedbackKey(item)}`,
    (text) => {
      setDraft((current) => (current.trim() ? current : text));
      setReplying(true);
    },
    (text) => {
      if (draft.trim() === text.trim()) {
        setDraft('');
        setReplying(false);
      }
    },
    () => inFrontPanel(card.current)
  );
  const card = useRef<HTMLElement>(null);
  const [sending, setSending] = useState(false),
    [sent, setSent] = useState(false);
  const comment = item.comments[0];
  const failureKey = `feedback-reply:${feedbackKey(item)}`;
  /** The reply shows at once, marked as sending. A failure brings the text back with Retry. */
  function send() {
    const body = draft;
    if (sending || !body.trim()) return;
    setSending(true);
    setSent(false);
    void optimisticWrite({
      key: failureKey,
      action: 'feedback-reply',
      body,
      clear: () => {
        setDraft('');
        setReplying(false);
      },
      restore: (text) => {
        setDraft((current) => (current.trim() ? current : text));
        setReplying(true);
      },
      write: async () => {
        await onReply(body);
        replyDraftSent(`feedback:${feedbackKey(item)}`, body);
        setSent(true);
      },
    }).finally(() => setSending(false));
  }
  const bot = isBot(comment.author?.login, comment.author?.__typename);
  return (
    <article ref={card} className="feedback-entry-card feedback-message" data-quiet={quiet || bot || undefined} data-sending={comment.sending}>
      {header}
      <div className="feedback-entry-body">
        {comment.isMinimized ? <HiddenComment comment={comment} /> : <CommentMarkdown>{comment.body}</CommentMarkdown>}
      </div>
      {related.length > 0 && <ReviewThreadIndex item={item} threads={related} onSelect={onSelect} />}
      {sending ? (
        <p role="status" className="github-sending">Sending reply…</p>
      ) : (
        sent && <p role="status" className="feedback-sent">Reply posted to the PR discussion.</p>
      )}
      {!replying && <WriteFailureNotice failureKey={failureKey} className="feedback-post-error" />}
      {replying ? (
        <form
          className="feedback-reply-form"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <label htmlFor={`reply-${item.id}`}>Reply to this feedback</label>
          <MarkdownCommentEditor id={`reply-${item.id}`} value={draft} onValueChange={setDraft} maxLength={65000} rows={4} autoFocus />
          <p className="feedback-reply-hint">Posts a PR comment with a link to this feedback.</p>
          <WriteFailureNotice failureKey={failureKey} className="feedback-post-error" />
          <div className="feedback-reply-actions">
            <Button type="submit" disabled={sending || !draft.trim()} size="sm">
              Reply on GitHub
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setReplying(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        !quiet && (
          <footer className="feedback-message-footer">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setReplying(true);
                setSent(false);
              }}
            >
              <Reply size={14} aria-hidden="true" />
              Reply
            </Button>
          </footer>
        )
      )}
    </article>
  );
}
