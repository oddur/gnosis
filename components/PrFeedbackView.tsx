import { Popover } from 'radix-ui';
import { SearchableSelect } from './SearchableSelect';
import { FileTypeIcon } from './FileTypeIcon';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, FileCode, MessageSquare, RefreshCw, Send, X, Reply } from 'lucide-react';
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
    .slice(0, 180) || feedbackStateLabel(item.state);
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
  onSource,
}: {
  subject: ReviewSubject;
  account: string | null;
  initialPrUrl?: string;
  onSource: (item: FeedbackItem) => void;
}) {
  const discussions = useEvidenceDiscussions(subject, account, true, true);
  const scope = `${account}:${subject.id}`;
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
  const selected = scoped.find((item) => feedbackKey(item) === selectedKey);
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
    returnFocusKey.current = selectedKey;
    setSelectedKey(undefined);
  }
  function select(item: FeedbackItem) {
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
      <div className="feedback-workspace" ref={root} data-conversation-open={!!selected}>
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
            <Popover.Root>
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
                      <span className="feedback-row-location">
                        {item.thread ? <FileCode size={13} /> : <MessageSquare size={13} />}
                        {item.thread?.path ?? kindLabel(item)}
                        {item.thread && (
                          <span>
                            {kindLabel(item)}
                            {item.thread.isOutdated ? ' · Outdated' : ''}
                          </span>
                        )}
                      </span>
                      {subject.kind === 'stack' && (
                        <span className="feedback-source">
                          <SubjectIcon kind="pr" />#{item.member.number} {item.member.title}
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
            {selected ? (
              <>
                <header className="feedback-conversation-header">
                  <Button variant="ghost" size="sm" className="feedback-back" onClick={backToList}>
                    <ArrowLeft size={15} />
                    Conversations
                  </Button>
                  <div>
                    <span className="feedback-source">
                      <SubjectIcon kind="pr" />#{selected.member.number} {selected.member.title}
                    </span>
                    <h2 ref={detail} tabIndex={-1}>
                      {selected.thread && <FileTypeIcon filePath={selected.thread.path} />}
                      {selected.thread?.path ?? kindLabel(selected)}
                    </h2>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => void markUnread()}>
                    Mark unread
                  </Button>
                </header>
                <div className="feedback-conversation-body" key={feedbackKey(selected)}>
                  {selected.thread && (
                    <>
                      {selected.comments[0]?.diffHunk ? (
                        <FeedbackCode
                          content={selected.comments[0].diffHunk}
                          label={
                            selected.thread.isOutdated
                              ? 'Outdated thread · code when commented'
                              : selected.headSha !== selected.member.headSha
                                ? 'Saved thread · code when commented'
                                : 'Code when commented'
                          }
                          onSource={
                            !selected.thread.isOutdated && selected.headSha === selected.member.headSha
                              ? () => onSource(selected)
                              : undefined
                          }
                        />
                      ) : (
                        <p className="feedback-context-unavailable">
                          Code context is unavailable. Open the original comment on GitHub.
                        </p>
                      )}
                      <GitHubReviewThread
                        thread={selected.thread}
                        expanded
                        onAction={async (action, body) => {
                          const next = await window.electronAPI.reviewThreadAction({
                            prUrl: selected.member.url,
                            threadId: selected.id,
                            action,
                            body,
                          });
                          replaceDiscussionThread(selected.member.url, next);
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
                    </>
                  )}
                  {!selected.thread && (
                    <FeedbackMessage
                      key={selected.id}
                      item={selected}
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
              </>
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
function FeedbackMessage({ item, onReply }: { item: FeedbackItem; onReply: (body: string) => Promise<void> }) {
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
            <div className="feedback-reply-actions">
              <Button type="submit" disabled={busy || !draft.trim()} size="sm">
                {busy ? 'Posting…' : 'Reply on GitHub'}
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setReplying(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </form>
      ) : (
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
      )}
    </article>
  );
}

function FeedbackCode({ content, label, onSource }: { content: string; label: string; onSource?: () => void }) {
  const query = '(max-width:760px), (max-height:700px)';
  const [compact, setCompact] = useState(() => window.matchMedia(query).matches);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(query);
    const change = () => setCompact(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  const lines = content.split('\n');
  const shown = expanded ? lines : lines.slice(-8);
  return (
    <details className="feedback-code-context" open={!compact}>
      <summary>{label}</summary>
      {onSource && (
        <Button size="sm" variant="ghost" onClick={onSource}>
          Open in Changes
        </Button>
      )}
      <pre className="feedback-code" aria-label="Code when commented">
        {shown.map((line, index) => (
          <span key={index} data-change={line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : undefined}>
            {line}
            {'\n'}
          </span>
        ))}
      </pre>
      {lines.length > 8 && (
        <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Less code context' : `Show all ${lines.length} lines of context`}
        </Button>
      )}
    </details>
  );
}
