import { createPortal } from 'react-dom';
import { FeedbackCodeContext } from './FeedbackCodeContext';
import type { Preferences } from '../lib/types';
import { Popover } from 'radix-ui';
import { SearchableSelect } from './SearchableSelect';
import { FileTypeIcon } from './FileTypeIcon';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, FileCode, MessageSquare, RefreshCw, Send, X, Reply } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button } from './ui/button';
import { GitHubAuthor } from './GitHubAuthor';
import { SubjectIcon } from './SubjectIcon';
import { GitHubReviewThread } from './GitHubReviewThread';
import { CommentMarkdown } from './CommentMarkdown';
import { MarkdownCommentEditor } from './MarkdownCommentEditor';
import { useEvidenceDiscussions } from '../lib/use-evidence-discussions';
import {
  feedbackOptionsKey,
  isGitHubActionsFeedback,
  feedbackItems,
  feedbackKey,
  feedbackReadKey,
  feedbackFingerprint,
  feedbackReviewers,
  feedbackStateLabel,
  feedbackActivity,
  type FeedbackItem,
} from '../lib/feedback';
import { readReviewState, writeReviewState } from '../lib/renderer-review-state';
import { replaceDiscussionThread, refreshDiscussion } from '../lib/review-discussion-cache';
import { useSessionDraft, ReviewDraftScope } from '../lib/session-drafts';
import type { ReviewSubject } from '../lib/workbench';
import { timeAgo } from '../lib/utils';

const excerpt = (item: FeedbackItem) =>
  item.comments[0]?.body
    .replace(/^[#>*\s]+/, '')
    .replace(/\s+/g, ' ')
    .slice(0, 180) ||
  ({ APPROVED: 'Approved this PR', CHANGES_REQUESTED: 'Requested changes', DISMISSED: 'Review dismissed' }[
    item.state ?? ''
  ] ??
    'Commented on this PR');
const fileName = (path: string) => path.split('/').at(-1) || path;
const kindLabel = (item: FeedbackItem) =>
  item.thread
    ? item.thread.isResolved
      ? 'Resolved'
      : 'Unresolved'
    : item.kind === 'review'
      ? feedbackStateLabel(item.state)
      : 'PR comment';

export function PrFeedbackView({
  subject,
  account,
  initialPrUrl,
  initialThreadId,
  preferences,
  intent,
  onIntentHandled,
  onSource,
}: {
  subject: ReviewSubject;
  account: string | null;
  initialPrUrl?: string;
  initialThreadId?: string;
  preferences?: Preferences;
  intent?: 'address' | 'request';
  onIntentHandled?: () => void;
  onSource: (item: FeedbackItem) => void;
}) {
  const discussions = useEvidenceDiscussions(subject, account, true, true);
  const scope = `${account}:${subject.id}`;
  const [actionHost, setActionHost] = useState<HTMLDivElement | null>(null);
  const [lastResolved, setLastResolved] = useState<FeedbackItem>();
  const [undoBusy, setUndoBusy] = useState(false);
  const [completed, setCompleted] = useState(false);
  const undoLock = useRef(false);
  const [requestsOpen, setRequestsOpen] = useState(intent === 'request');
  const initialSelection = useRef(false);
  useEffect(() => {
    if (intent === 'request') onIntentHandled?.();
  }, [intent]);
  const [filter, setFilter] = useSessionDraft<'all' | 'unread' | 'unresolved'>(`feedback-filter:${scope}`, 'all');
  const [selectedKey, setSelectedKey] = useSessionDraft<string | undefined>(`feedback-selection:${scope}`, undefined);
  const [prUrl, setPrUrl] = useState(initialPrUrl ?? '');
  const [, rerender] = useState(0);
  const [savingOptions, setSavingOptions] = useState(false);
  const [optionsError, setOptionsError] = useState('');
  const hideGitHubActions = !account || readReviewState(feedbackOptionsKey(account)) !== false;
  const [readError, setReadError] = useState('');
  const [writeError, setWriteError] = useState('');
  const [requesting, setRequesting] = useState('');
  const [requestError, setRequestError] = useState('');
  const [visibleVisit, setVisibleVisit] = useState(0);
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === 'visible') setVisibleVisit((n) => n + 1);
    };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, []);
  const [requested, setRequested] = useState<Set<string>>(new Set());
  const root = useRef<HTMLDivElement>(null);
  const detail = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const returnFocusKey = useRef<string | undefined>(undefined);
  const writeLock = useRef(false);
  const readPending = useRef(new Set<string>());
  const all = subject.members
    .flatMap((member) => feedbackItems(member, discussions.values[member.url]))
    .sort((a, b) => feedbackActivity(b).localeCompare(feedbackActivity(a)));
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
  const unread = scoped.filter(isUnread).length;
  const unresolved = scoped.filter((item) => item.thread && !item.thread.isResolved).length;
  const shown = scoped.filter(
    (item) =>
      (!prUrl || item.member.url === prUrl) &&
      (filter === 'all' ||
        feedbackKey(item) === selectedKey ||
        (filter === 'unread' ? isUnread(item) : item.thread && !item.thread.isResolved))
  );
  useEffect(() => {
    if ((!initialThreadId && intent !== 'address') || initialSelection.current || !scoped.length) return;
    const target = initialThreadId ? scoped.find((item) => item.id === initialThreadId) : undefined;
    if (initialThreadId && !target) return;
    initialSelection.current = true;
    setFilter('all');
    const first =
      target ??
      scoped.find((item) => item.state === 'CHANGES_REQUESTED') ??
      scoped.find((item) => item.thread && !item.thread.isResolved) ??
      scoped[0];
    setSelectedKey(feedbackKey(first));
    onIntentHandled?.();
  }, [intent, initialThreadId, scoped]);
  const selected = scoped.find((item) => feedbackKey(item) === selectedKey);
  const currentSelection = useRef(selectedKey);
  currentSelection.current = selectedKey;
  const latestScoped = useRef(scoped);
  latestScoped.current = scoped;
  const selectedIndex = shown.findIndex((item) => feedbackKey(item) === selectedKey);
  function nextAfterResolve() {
    if (!selected || currentSelection.current !== feedbackKey(selected)) return;
    const items = latestScoped.current;
    const at = items.findIndex((item) => feedbackKey(item) === feedbackKey(selected));
    const next = [...items.slice(at + 1), ...items.slice(0, at)].find(
      (item) => item.thread && !item.thread.isResolved && feedbackKey(item) !== feedbackKey(selected)
    );
    if (next) select(next);
    else {
      setCompleted(true);
      setSelectedKey(undefined);
      requestAnimationFrame(() => detail.current?.focus({ preventScroll: true }));
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
      setPrUrl(lastResolved.member.url === prUrl || !prUrl ? prUrl : lastResolved.member.url);
      select(lastResolved);
      setLastResolved((current) => (current?.id === lastResolved.id ? undefined : current));
    } catch {
      setWriteError('Could not reopen the thread. Try Undo again.');
    } finally {
      undoLock.current = false;
      setUndoBusy(false);
    }
  }
  const virtual = useVirtualizer({
    count: shown.length,
    getScrollElement: () => list.current,
    estimateSize: () => (subject.kind === 'stack' ? 140 : 114),
    overscan: 6,
    getItemKey: (index) => feedbackKey(shown[index]),
  });
  const snapshotMissing = subject.members.filter((m) => !discussions.values[m.url]?.feedback);
  const failures = subject.members.filter((m) => discussions.errors[m.url]);
  const fingerprint = selected && account ? feedbackFingerprint(selected, account) : '';
  useEffect(() => {
    if (!selected || !account || document.visibilityState === 'hidden') return;
    const key = feedbackReadKey(account, selected);
    if (readReviewState(key) === fingerprint || readPending.current.has(key + fingerprint)) return;
    readPending.current.add(key + fingerprint);
    void writeReviewState(key, fingerprint)
      .then(
        () => {
          setReadError('');
          rerender((n) => n + 1);
        },
        () => setReadError('Could not save read status. Open the conversation again to retry.')
      )
      .finally(() => readPending.current.delete(key + fingerprint));
  }, [selectedKey, account, fingerprint, visibleVisit]); // Mark the displayed conversation only; never the list.
  useLayoutEffect(() => {
    if (selectedKey) {
      detail.current?.focus({ preventScroll: true });
      return;
    }
    const key = returnFocusKey.current;
    if (!key) return;
    returnFocusKey.current = undefined;
    list.current?.focus({ preventScroll: true });
    const index = shown.findIndex((item) => feedbackKey(item) === key);
    if (index < 0) return;
    virtual.scrollToIndex(index);
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        list.current
          ?.querySelector<HTMLButtonElement>(`[data-feedback-index="${index}"]`)
          ?.focus({ preventScroll: true });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedKey]);
  function backToList() {
    setCompleted(false);
    returnFocusKey.current = selectedKey;
    setSelectedKey(undefined);
    if (!selectedKey) requestAnimationFrame(() => list.current?.focus({ preventScroll: true }));
  }
  function select(item: FeedbackItem) {
    setCompleted(false);
    setSelectedKey(feedbackKey(item));
    setWriteError('');
  }
  async function changeActionsFilter(hide: boolean) {
    if (!account || savingOptions) return;
    setSavingOptions(true);
    setOptionsError('');
    try {
      await writeReviewState(feedbackOptionsKey(account), hide);
      if (hide && selected && isGitHubActionsFeedback(selected)) setSelectedKey(undefined);
      rerender((n) => n + 1);
    } catch {
      setOptionsError('Could not save the GitHub Actions filter. Try again.');
    } finally {
      setSavingOptions(false);
    }
  }
  async function markUnread() {
    if (!selected || !account) return;
    try {
      await writeReviewState(feedbackReadKey(account, selected), null);
      backToList();
      rerender((n) => n + 1);
    } catch {
      setReadError('Could not save unread status. Try again.');
    }
  }
  async function requestReview(url: string, login: string, reviewId: string) {
    if (writeLock.current) return;
    writeLock.current = true;
    const key = `${url}:${login}:${reviewId}`;
    setRequesting(key);
    setRequestError('');
    try {
      await window.electronAPI.feedbackAction({ prUrl: url, action: 'request-review', reviewer: login });
      setRequested((previous) => new Set([...previous, key]));
      void refreshDiscussion(url).catch(() =>
        setWriteError('Review requested. Could not refresh feedback; your request was sent.')
      );
    } catch (error) {
      setRequestError(
        `Could not request a review from ${login}. ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      writeLock.current = false;
      setRequesting('');
    }
  }
  const reviewers = subject.members
    .filter((member) => !prUrl || member.url === prUrl)
    .flatMap((member) => {
      const snapshot = discussions.values[member.url];
      return snapshot
        ? feedbackReviewers(snapshot).map((reviewer) => ({
            ...reviewer,
            member,
            allowed: snapshot.feedback?.viewerCanUpdate && snapshot.feedback.state === 'OPEN',
          }))
        : [];
    });
  if (!account)
    return (
      <div className="feedback-empty">
        <MessageSquare aria-hidden="true" />
        <h2>Connect GitHub to read feedback</h2>
        <p>Your local notes remain available in the Local notes tab.</p>
      </div>
    );
  return (
    <ReviewDraftScope.Provider value={`feedback:${account}`}>
      <div className="feedback-workspace" ref={root} data-conversation-open={!!selected || completed}>
        {optionsError && (
          <div className="feedback-notice" role="alert">
            {optionsError}
          </div>
        )}
        <div className="feedback-toolbar">
          <div className="feedback-filters" role="group" aria-label="Filter feedback">
            {(['all', 'unread', 'unresolved'] as const).map((value) => (
              <Button
                key={value}
                variant={filter === value ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={filter === value}
                onClick={() => {
                  setCompleted(false);
                  setFilter(value);
                  setSelectedKey(undefined);
                }}
              >
                {value === 'all' ? 'All' : value === 'unread' ? 'Unread' : 'Unresolved'}{' '}
                <span>{value === 'all' ? scoped.length : value === 'unread' ? unread : unresolved}</span>
              </Button>
            ))}
          </div>
          {subject.kind === 'stack' && (
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
                })),
              ]}
              onValueChange={(value) => {
                setPrUrl(value === 'all' ? '' : value);
                setSelectedKey(undefined);
              }}
            />
          )}
          <label
            className="feedback-actions-filter"
            title="Hide GitHub Actions comments. Conversations with human replies stay visible."
          >
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
                  Review requests <span>{reviewers.length}</span>
                </Button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  className="feedback-reviewers"
                  align="end"
                  sideOffset={8}
                  collisionPadding={16}
                  aria-label="Review requests"
                >
                  <header>
                    <h2>Reviewers who requested changes</h2>
                    <Popover.Close asChild>
                      <Button variant="ghost" size="icon-sm" aria-label="Close review requests">
                        <X size={15} />
                      </Button>
                    </Popover.Close>
                  </header>
                  <p>Request another review after addressing their feedback. Unresolved threads stay open.</p>
                  {requestError && (
                    <p role="alert" className="feedback-post-error">
                      {requestError}
                    </p>
                  )}
                  <div>
                    {reviewers.map((r) => {
                      const key = `${r.member.url}:${r.login}:${r.reviewId}`,
                        sent = r.requested || requested.has(key);
                      return (
                        <div className="feedback-reviewer" key={key}>
                          <div className="feedback-reviewer-person">
                            <GitHubAuthor login={r.login} />
                          </div>
                          {subject.kind === 'stack' && (
                            <span className="feedback-source">
                              <SubjectIcon kind="pr" />#{r.member.number} {r.member.title}
                            </span>
                          )}
                          <span className="feedback-reviewer-state">
                            {r.unresolved
                              ? `${r.unresolved} unresolved ${r.unresolved === 1 ? 'thread' : 'threads'}`
                              : 'No unresolved threads'}
                          </span>
                          <Button
                            size="sm"
                            variant="outline"
                            data-request-review={r.member.number}
                            aria-label={`${sent ? 'Review requested from' : 'Re-request review from'} ${r.login} on PR #${r.member.number}`}
                            disabled={!r.allowed || !!requesting || sent}
                            title={!r.allowed ? 'Review requests require permission to update an open PR.' : undefined}
                            onClick={() => void requestReview(r.member.url, r.login, r.reviewId)}
                          >
                            {sent ? <Check size={14} /> : <Send size={14} />}
                            {sent ? 'Review requested' : requesting === key ? 'Requesting…' : 'Re-request review'}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh feedback"
            title="Refresh feedback"
            disabled={discussions.busy}
            onClick={() => void discussions.refresh()}
          >
            <RefreshCw size={15} className={discussions.busy ? 'animate-spin' : ''} />
          </Button>
          <span className="feedback-sync" role="status">
            {discussions.busy
              ? 'Refreshing…'
              : failures.length
                ? 'Showing saved feedback'
                : snapshotMissing.length
                  ? `${subject.members.length - snapshotMissing.length}/${subject.members.length} PRs loaded`
                  : 'Updates automatically'}
          </span>
        </div>
        {readError && (
          <p className="feedback-notice" role="alert">
            {readError}
          </p>
        )}
        {writeError && (
          <p className="feedback-notice" role="alert">
            {writeError}
          </p>
        )}
        {failures.length > 0 && (
          <div className="feedback-notice feedback-sync-error" role="alert">
            <span>
              Could not refresh {failures.length === 1 ? `PR #${failures[0].number}` : `${failures.length} PRs`}.
              Showing saved feedback.
            </span>
            <Popover.Root>
              <Popover.Trigger asChild>
                <Button size="sm" variant="ghost">
                  Details
                </Button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  className="feedback-error-details"
                  sideOffset={6}
                  collisionPadding={16}
                  aria-label="Refresh errors"
                >
                  {failures.map((m) => (
                    <p key={m.url}>
                      #{m.number} {m.title}: {discussions.errors[m.url]?.message}
                    </p>
                  ))}
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
            <Button size="sm" variant="ghost" onClick={() => void discussions.refresh()}>
              Retry
            </Button>
          </div>
        )}
        <div className="feedback-panes">
          <div
            className="feedback-list"
            ref={list}
            tabIndex={-1}
            role="navigation"
            aria-label="Feedback conversations"
            onKeyDown={(e) => {
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
              const index = Number(
                (e.target as HTMLElement).closest('[data-feedback-index]')?.getAttribute('data-feedback-index') ?? 0
              );
              const next =
                e.key === 'Home'
                  ? 0
                  : e.key === 'End'
                    ? shown.length - 1
                    : Math.max(0, Math.min(shown.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)));
              if (next < 0 || !shown.length) return;
              e.preventDefault();
              virtual.scrollToIndex(next);
              requestAnimationFrame(() =>
                list.current?.querySelector<HTMLButtonElement>(`[data-feedback-index="${next}"]`)?.focus()
              );
            }}
          >
            {shown.length ? (
              <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
                {virtual.getVirtualItems().map((row) => {
                  const item = shown[row.index],
                    author = item.comments[0]?.author?.login ?? 'Deleted account',
                    last = item.comments.at(-1);
                  if (!last) return null;
                  return (
                    <button
                      key={row.key}
                      ref={virtual.measureElement}
                      data-index={row.index}
                      data-feedback-index={row.index}
                      data-feedback-id={item.id}
                      className={`feedback-row ${isUnread(item) ? 'is-unread' : ''}`}
                      data-resolved={item.thread?.isResolved || undefined}
                      data-event={(!item.thread && !item.comments[0]?.body.trim()) || undefined}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${row.start}px)`,
                      }}
                      aria-current={feedbackKey(item) === selectedKey ? 'true' : undefined}
                      onClick={() => select(item)}
                    >
                      <span className="feedback-row-meta">
                        <span>{author}</span>
                        <time title={new Date(last.createdAt).toLocaleString()}>{timeAgo(last.createdAt)}</time>
                        {isUnread(item) && <span className="pr-unread-dot" aria-label="Unread" />}
                      </span>
                      <span className="feedback-row-title">{excerpt(item)}</span>
                      {item.comments.length > 1 && (
                        <span className="feedback-row-update">
                          <Reply size={12} />
                          <span>
                            {item.comments.at(-1)?.author?.login ?? 'Deleted account'}:{' '}
                            {item.comments.at(-1)?.body.replace(/\s+/g, ' ').slice(0, 120)}
                          </span>
                          <span>{item.comments.length} comments</span>
                        </span>
                      )}
                      {(item.thread || item.comments[0]?.body.trim()) && (
                        <span className="feedback-row-location">
                          {item.thread ? <FileTypeIcon filePath={item.thread.path} /> : <MessageSquare size={13} />}
                          <span className="feedback-row-file" title={item.thread?.path}>
                            {item.thread ? fileName(item.thread.path) : kindLabel(item)}
                          </span>
                          {item.thread && (
                            <span className="feedback-row-state">
                              {item.thread.isResolved && <Check size={12} aria-hidden="true" />}
                              {kindLabel(item)}
                            </span>
                          )}
                        </span>
                      )}
                      {subject.kind === 'stack' && (
                        <span className="feedback-source" title={`#${item.member.number} ${item.member.title}`}>
                          <SubjectIcon kind="pr" />
                          <span>
                            #{item.member.number} {item.member.title}
                          </span>
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="feedback-empty">
                {snapshotMissing.length && !failures.length ? (
                  <>
                    <RefreshCw className="animate-spin" aria-hidden="true" />
                    <h2>Loading feedback</h2>
                    <p>Conversations appear as each PR loads.</p>
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
                              : 'Choose All to see the other conversations.'}
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
          <section className="feedback-conversation" aria-label="Selected conversation">
            {lastResolved && (
              <div className="feedback-resolution" role="status">
                <Check size={14} aria-hidden="true" />
                <span title={`PR #${lastResolved.member.number} · ${lastResolved.thread?.path}`}>
                  {lastResolved.id === selected?.id ? 'This thread resolved' : 'Previous thread resolved'} · #
                  {lastResolved.member.number} · {lastResolved.thread?.path}
                </span>
                <button disabled={undoBusy} onClick={() => void undoResolution()}>
                  {undoBusy ? 'Restoring…' : 'Undo'}
                </button>
              </div>
            )}
            {selected ? (
              <>
                <header className="feedback-conversation-header">
                  <Button variant="ghost" size="sm" className="feedback-back" onClick={backToList}>
                    <ArrowLeft size={15} />
                    Conversations
                  </Button>
                  <div>
                    <span className="feedback-source" title={`#${selected.member.number} ${selected.member.title}`}>
                      <SubjectIcon kind="pr" />#{selected.member.number} {selected.member.title}
                    </span>
                    <h2 ref={detail} tabIndex={-1} title={selected.thread?.path}>
                      {selected.thread && <FileTypeIcon filePath={selected.thread.path} />}
                      <span className="feedback-file-name">{selected.thread ? fileName(selected.thread.path) : kindLabel(selected)}</span>
                    </h2>
                    {selected.thread?.path.includes('/') && (
                      <span className="feedback-file-directory" title={selected.thread.path}>
                        {selected.thread.path.slice(0, selected.thread.path.lastIndexOf('/'))}
                      </span>
                    )}
                  </div>
                  {selected.kind === 'review' &&
                    (() => {
                      const next = scoped.find(
                        (item) => item.thread && !item.thread.isResolved && selected.relatedThreads.includes(item.id)
                      );
                      return (
                        next && (
                          <Button variant="outline" size="sm" onClick={() => select(next)}>
                            Address code threads
                          </Button>
                        )
                      );
                    })()}
                  <Button variant="ghost" size="sm" onClick={() => void markUnread()}>
                    Mark unread
                  </Button>
                  <nav className="feedback-thread-navigation" aria-label="Conversation navigation">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Previous conversation"
                      disabled={selectedIndex <= 0}
                      onClick={() => select(shown[selectedIndex - 1])}
                    >
                      <ArrowLeft size={15} />
                    </Button>
                    <span>
                      {selectedIndex + 1} of {shown.length}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Next conversation"
                      disabled={selectedIndex < 0 || selectedIndex >= shown.length - 1}
                      onClick={() => select(shown[selectedIndex + 1])}
                    >
                      <ArrowRight size={15} />
                    </Button>
                    {selected.thread && (
                      <Button variant="ghost" size="sm" onClick={() => onSource(selected)}>
                        Open in Changes
                      </Button>
                    )}
                  </nav>
                </header>
                <div className="feedback-conversation-body" key={feedbackKey(selected)}>
                  {selected.thread && (
                    <div className="feedback-thread-detail">
                      <GitHubReviewThread
                        thread={selected.thread}
                        actionContainer={actionHost}
                        onResolvedNext={nextAfterResolve}
                        expanded
                        onAction={async (action, body) => {
                          const next = await window.electronAPI.reviewThreadAction({
                            prUrl: selected.member.url,
                            threadId: selected.id,
                            action,
                            body,
                          });
                          replaceDiscussionThread(selected.member.url, next);
                          if (action === 'resolve' && next.viewerCanUnresolve) setLastResolved(selected);
                          if (action === 'unresolve')
                            setLastResolved((current) => (current?.id === selected.id ? undefined : current));
                        }}
                        onCommentAction={async (commentId, action, body) => {
                          const next = await window.electronAPI.reviewCommentAction({
                            prUrl: selected.member.url,
                            threadId: selected.id,
                            commentId,
                            action,
                            body,
                          });
                          replaceDiscussionThread(selected.member.url, next);
                        }}
                      />
                      <FeedbackCodeContext
                        item={selected}
                        thread={selected.thread}
                        preferences={preferences}
                        discussion={{
                          discussions: Object.fromEntries(
                            Object.entries(discussions.values).map(([url, data]) => [
                              url,
                              { data, error: discussions.errors[url]?.message },
                            ])
                          ),
                          refresh: async (url) => {
                            await refreshDiscussion(url);
                          },
                          replace: replaceDiscussionThread,
                        }}
                        onSource={() => onSource(selected)}
                      />
                    </div>
                  )}
                  {!selected.thread && (
                    <FeedbackMessage
                      key={selected.id}
                      item={selected}
                      actionContainer={actionHost}
                      onReply={async (body) => {
                        await window.electronAPI.feedbackAction({
                          prUrl: selected.member.url,
                          action: 'reply',
                          sourceId: selected.id,
                          body,
                        });
                        void refreshDiscussion(selected.member.url).catch(() =>
                          setWriteError('Reply posted. Could not refresh feedback; your reply was sent.')
                        );
                      }}
                    />
                  )}
                  {selected.relatedThreads.length > 0 && (
                    <nav className="feedback-related" aria-label="Threads in this review">
                      <h3>
                        {selected.relatedThreads.length} code{' '}
                        {selected.relatedThreads.length === 1 ? 'thread' : 'threads'} in this review
                      </h3>
                      {selected.relatedThreads.map((id) => {
                        const item = all.find((row) => row.member.url === selected.member.url && row.id === id);
                        return item ? (
                          <button key={id} onClick={() => select(item)}>
                            <FileCode size={14} />
                            <span>
                              {item.thread?.path} — {excerpt(item)}
                            </span>
                            <span>{kindLabel(item)}</span>
                          </button>
                        ) : null;
                      })}
                    </nav>
                  )}
                </div>
                <div
                  className="feedback-response-dock"
                  ref={setActionHost}
                  aria-label={`Actions for PR #${selected.member.number} conversation`}
                />
              </>
            ) : completed ? (
              <div className="feedback-empty feedback-complete">
                <Check aria-hidden="true" />
                <h2 ref={detail} tabIndex={-1}>
                  {snapshotMissing.length || failures.length
                    ? 'Feedback could not be confirmed'
                    : unresolved
                      ? 'More feedback needs attention'
                      : 'No unresolved code threads'}
                </h2>
                <p>
                  {prUrl ? 'In this PR. ' : ''}Resolving threads does not approve a PR. Review decisions and general
                  comments may still need a response.
                </p>
                {(snapshotMissing.length > 0 || failures.length > 0) && (
                  <p>Some PR feedback is unavailable. Refresh feedback to check for remaining threads.</p>
                )}
                {unresolved > 0 && (
                  <Button
                    size="sm"
                    onClick={() => {
                      const next = scoped.find((item) => item.thread && !item.thread.isResolved);
                      if (next) select(next);
                    }}
                  >
                    Continue with unresolved feedback
                  </Button>
                )}
                {reviewers.length > 0 && (
                  <Button variant="outline" size="sm" onClick={() => setRequestsOpen(true)}>
                    Review feedback & request review
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={backToList}>
                  All conversations
                </Button>
              </div>
            ) : (
              <div className="feedback-empty">
                <MessageSquare aria-hidden="true" />
                <h2>Select a conversation</h2>
                <p>Read the context, reply, and resolve code threads here.</p>
              </div>
            )}
          </section>
        </div>
      </div>
    </ReviewDraftScope.Provider>
  );
}
function FeedbackMessage({
  item,
  onReply,
  actionContainer,
}: {
  item: FeedbackItem;
  onReply: (body: string) => Promise<void>;
  actionContainer?: HTMLElement | null;
}) {
  const [draft, setDraft] = useSessionDraft(`feedback-reply:${feedbackKey(item)}`, '');
  const [replying, setReplying] = useSessionDraft(`feedback-replying:${feedbackKey(item)}`, false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [sent, setSent] = useState(false);
  const lock = useRef(false);
  const footer = useRef<HTMLDivElement>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) {
      footer.current?.scrollIntoView({ block: 'nearest' });
      alert.current?.focus({ preventScroll: true });
    }
  }, [error]);
  const comment = item.comments[0];
  async function send() {
    if (lock.current || !draft.trim()) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await onReply(draft);
      setDraft('');
      setReplying(false);
      setSent(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const replyButton = (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        setReplying(true);
        setSent(false);
      }}
    >
      Reply
    </Button>
  );
  const replyActions = (
    <div className="feedback-reply-actions">
      <Button type="submit" form={`feedback-reply-form-${item.id}`} disabled={busy || !draft.trim()} size="sm">
        {busy ? 'Posting…' : 'Reply on GitHub'}
      </Button>
      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setReplying(false)}>
        Cancel
      </Button>
    </div>
  );
  return (
    <article className="feedback-message">
      <header>
        {comment.author ? <GitHubAuthor login={comment.author.login} /> : 'Deleted account'}
        <time dateTime={comment.createdAt}>{timeAgo(comment.createdAt)}</time>
        <a href={comment.url} target="_blank" rel="noreferrer">
          On GitHub
        </a>
      </header>
      <CommentMarkdown>{comment.body || 'No review summary was provided.'}</CommentMarkdown>
      {sent && <p role="status">Reply posted to the PR discussion.</p>}
      {replying ? (
        <form
          id={`feedback-reply-form-${item.id}`}
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label htmlFor={`reply-${item.id}`}>Reply to this feedback</label>
          <MarkdownCommentEditor
            id={`reply-${item.id}`}
            value={draft}
            onValueChange={setDraft}
            disabled={busy}
            maxLength={65000}
            rows={4}
            autoFocus
          />
          <p className="feedback-reply-hint">Posts a PR comment with a link to this feedback.</p>
          <div ref={footer} className="feedback-reply-footer">
            {error && (
              <div className="feedback-post-error">
                <p ref={alert} role="alert" tabIndex={-1}>
                  Reply wasn’t posted. Your draft is saved. Try again.
                </p>
                <details>
                  <summary>Details</summary>
                  <p>{error}</p>
                </details>
              </div>
            )}
            {actionContainer ? createPortal(replyActions, actionContainer) : replyActions}
          </div>
        </form>
      ) : actionContainer ? (
        createPortal(replyButton, actionContainer)
      ) : (
        replyButton
      )}
    </article>
  );
}
