import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowLeft, ArrowRight, Check, MessageSquare } from 'lucide-react';
import { Button } from './ui/button';
import { FileTypeIcon } from './FileTypeIcon';
import { SubjectIcon } from './SubjectIcon';
import { GitHubReviewThread } from './GitHubReviewThread';
import { useSessionDraft, ReviewDraftScope } from '../lib/session-drafts';
import {
  feedbackCodeContext,
  feedbackItems,
  feedbackKey,
  feedbackFingerprint,
  feedbackReadKey,
  feedbackOptionsKey,
  feedbackReviewers,
  isGitHubActionsFeedback,
  type FeedbackItem,
} from '../lib/feedback';
import { readReviewState, writeReviewState } from '../lib/renderer-review-state';
import type { ReviewSubject } from '../lib/workbench';
import type { GitHubReviewThread as Thread } from '../lib/review-threads';
import type { usePrDiscussions } from '../lib/use-pr-discussions';
import type { ChangeFileEntry } from './PrFileInspection';

export interface FeedbackFileFocus {
  threadId: string;
  line?: number;
  side: 'before' | 'after';
  renderThread: (thread: Thread) => ReactNode;
}

/** A focused code-reading loop, using the same conversations and mutations as Feedback. */
export function ChangesFeedback({
  subject,
  account,
  discussion,
  entries,
  initialThreadId,
  onInspect,
  onInitialThreadHandled,
  renderFile,
  onOpenFeedback,
}: {
  subject: ReviewSubject;
  account: string;
  discussion: ReturnType<typeof usePrDiscussions>;
  entries: ChangeFileEntry[];
  initialThreadId?: string;
  onInspect: (source?: { url: string; path: string }) => void;
  onInitialThreadHandled?: () => void;
  renderFile: (entry: ChangeFileEntry, focus: FeedbackFileFocus) => ReactNode;
  onOpenFeedback?: (url?: string, requestReview?: boolean) => void;
}) {
  const scope = `${account}:${subject.id}`;
  const [selectedKey, setSelectedKey] = useSessionDraft(`changes-feedback:${scope}`, '');
  const [showResolved, setShowResolved] = useSessionDraft(`changes-feedback-resolved:${scope}`, false);
  const [mobileList, setMobileList] = useState(false);
  const [readError, setReadError] = useState('');
  const [visibleVisit, setVisibleVisit] = useState(0);
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === 'visible') setVisibleVisit((n) => n + 1);
    };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, []);
  const [lastResolved, setLastResolved] = useState<{ url: string; id: string; path: string; number: number }>();
  const [actionHost, setActionHost] = useState<HTMLDivElement | null>(null);
  const [retrying, setRetrying] = useState(false);
  const retryLock = useRef(false);
  const returnFocusKey = useRef<string | undefined>(undefined);
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoError, setUndoError] = useState('');
  const pending = useRef(new Set<string>());
  const currentSelection = useRef(selectedKey);
  currentSelection.current = selectedKey;
  const [, render] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const hideActions = readReviewState(feedbackOptionsKey(account)) !== false;
  const all = subject.members
    .flatMap((member) => feedbackItems(member, discussion.discussions[member.url]?.data))
    .filter(
      (item): item is FeedbackItem & { thread: Thread } =>
        !!item.thread && (!hideActions || !isGitHubActionsFeedback(item))
    )
    .sort(
      (a, b) =>
        subject.members.findIndex((m) => m.url === a.member.url) -
          subject.members.findIndex((m) => m.url === b.member.url) ||
        a.thread.path.localeCompare(b.thread.path) ||
        (a.thread.line ?? Infinity) - (b.thread.line ?? Infinity) ||
        a.id.localeCompare(b.id)
    );
  const unresolved = all.filter((item) => !item.thread.isResolved);
  const selected = all.find((item) => feedbackKey(item) === selectedKey);
  const shown = all.filter((item) => showResolved || !item.thread.isResolved || feedbackKey(item) === selectedKey);
  const index = shown.findIndex((item) => feedbackKey(item) === selectedKey);
  const virtual = useVirtualizer({
    count: shown.length,
    getScrollElement: () => list.current,
    estimateSize: () => 128,
    overscan: 4,
    getItemKey: (i) => feedbackKey(shown[i]),
  });
  useLayoutEffect(() => {
    if (!mobileList || !returnFocusKey.current) return;
    const key = returnFocusKey.current;
    returnFocusKey.current = undefined;
    list.current?.focus({ preventScroll: true });
    const row = shown.findIndex((item) => feedbackKey(item) === key);
    if (row < 0) return;
    virtual.scrollToIndex(row);
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() =>
        list.current?.querySelector<HTMLButtonElement>(`[data-index="${row}"] button`)?.focus({ preventScroll: true })
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [mobileList]);
  function backToThreads() {
    returnFocusKey.current = selectedKey;
    setMobileList(true);
  }
  const initialApplied = useRef(false);
  useEffect(() => {
    if (!initialThreadId || initialApplied.current) return;
    const item = all.find((item) => item.id === initialThreadId);
    if (item) {
      initialApplied.current = true;
      setSelectedKey(feedbackKey(item));
      onInitialThreadHandled?.();
    }
  }, [initialThreadId, all]);
  useEffect(() => {
    onInspect(selected ? { url: selected.member.url, path: selected.thread.path } : undefined);
  }, [selectedKey, selected?.thread.path]);
  const fingerprint = selected ? feedbackFingerprint(selected, account) : '';
  useEffect(() => {
    if (!selected || !account || !fingerprint || mobileList || document.visibilityState === 'hidden') return;
    let active = true;
    const key = feedbackReadKey(account, selected);
    if (readReviewState(key) === fingerprint) return;
    void writeReviewState(key, fingerprint).then(
      () => {
        if (active) {
          setReadError('');
          render((n) => n + 1);
        }
      },
      () => {
        if (active) setReadError('Could not save read status. Reopen this conversation to retry.');
      }
    );
    return () => {
      active = false;
    };
  }, [selectedKey, fingerprint, account, mobileList, visibleVisit]);
  const missing = subject.members.filter((member) => !discussion.discussions[member.url]?.data);
  const failures = subject.members.filter((member) => discussion.discussions[member.url]?.error);
  const reviewers = subject.members.flatMap((member) => {
    const data = discussion.discussions[member.url]?.data;
    return data ? feedbackReviewers(data).map((reviewer) => ({ ...reviewer, member })) : [];
  });
  async function retryFeedback(urls: string[]) {
    if (retryLock.current) return;
    retryLock.current = true;
    setRetrying(true);
    try {
      await Promise.allSettled(urls.map((url) => discussion.refresh(url)));
    } finally {
      retryLock.current = false;
      setRetrying(false);
    }
  }
  function choose(item: FeedbackItem) {
    setSelectedKey(feedbackKey(item));
    setMobileList(false);
    requestAnimationFrame(() => {
      content.current?.scrollTo({ top: 0 });
      heading.current?.focus({ preventScroll: true });
    });
  }
  function nextAfterResolve() {
    if (!selected || currentSelection.current !== selectedKey) return;
    const at = all.findIndex((item) => feedbackKey(item) === selectedKey);
    const next = [...all.slice(at + 1), ...all.slice(0, at)].find((item) => !item.thread.isResolved);
    if (next) choose(next);
    else {
      setSelectedKey('');
      requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
    }
  }
  function renderThread(item: FeedbackItem, thread: Thread) {
    return (
      <div key={thread.id} className={thread.id === selected?.id ? 'changes-feedback-active-thread' : undefined}>
        <GitHubReviewThread
          thread={thread}
          expanded={thread.id === selected?.id ? true : undefined}
          onResolvedNext={thread.id === selected?.id ? nextAfterResolve : undefined}
          actionContainer={thread.id === selected?.id ? actionHost : undefined}
          onAction={
            account
              ? async (action, body) => {
                  const key = `${item.member.url}:${thread.id}`;
                  if (pending.current.has(key)) throw new Error('A change to this thread is still being saved.');
                  pending.current.add(key);
                  try {
                    const next = await window.electronAPI.reviewThreadAction({
                      prUrl: item.member.url,
                      threadId: thread.id,
                      action,
                      body,
                    });
                    discussion.replace(item.member.url, next);
                    if (action === 'resolve' && next.viewerCanUnresolve) {
                      setLastResolved({
                        url: item.member.url,
                        id: thread.id,
                        path: thread.path,
                        number: item.member.number,
                      });
                      setUndoError('');
                    }
                    if (action === 'unresolve') setLastResolved((old) => (old?.id === thread.id ? undefined : old));
                  } finally {
                    pending.current.delete(key);
                  }
                }
              : undefined
          }
          onCommentAction={
            account
              ? async (commentId, action, body) => {
                  const key = `${item.member.url}:${thread.id}`;
                  if (pending.current.has(key)) throw new Error('A change to this thread is still being saved.');
                  pending.current.add(key);
                  try {
                    const next = await window.electronAPI.reviewCommentAction({
                      prUrl: item.member.url,
                      threadId: thread.id,
                      commentId,
                      action,
                      body,
                    });
                    discussion.replace(item.member.url, next);
                  } finally {
                    pending.current.delete(key);
                  }
                }
              : undefined
          }
        />
      </div>
    );
  }
  async function undoResolution() {
    if (!lastResolved || undoBusy) return;
    const key = `${lastResolved.url}:${lastResolved.id}`;
    if (pending.current.has(key)) return;
    pending.current.add(key);
    setUndoBusy(true);
    setUndoError('');
    try {
      const next = await window.electronAPI.reviewThreadAction({
        prUrl: lastResolved.url,
        threadId: lastResolved.id,
        action: 'unresolve',
      });
      discussion.replace(lastResolved.url, next);
      const restored = all.find((item) => item.member.url === lastResolved.url && item.id === lastResolved.id);
      if (restored) choose({ ...restored, thread: next });
      setLastResolved((current) => (current?.id === lastResolved.id ? undefined : current));
    } catch {
      setUndoError('Could not reopen the thread. Try Undo again.');
    } finally {
      pending.current.delete(key);
      setUndoBusy(false);
    }
  }
  const target =
    selected &&
    entries.find(
      (e) =>
        e.snapshot.url === selected.member.url &&
        (e.file.path === selected.thread.path || e.file.previousPath === selected.thread.path)
    );
  const data = selected && discussion.discussions[selected.member.url]?.data;
  const context = selected ? feedbackCodeContext(selected.thread, data, target?.snapshot.metadata) : 'unavailable';
  const current = context === 'current' && !!target;
  const earlier = context === 'earlier';
  if (!account)
    return (
      <div className="changes-feedback-empty">
        <h2>Connect GitHub to address feedback</h2>
        <p>Your local notes remain available in Local notes.</p>
      </div>
    );
  return (
    <ReviewDraftScope.Provider value={`feedback:${account}`}>
      <div className="changes-feedback" data-mobile-list={mobileList}>
        <aside className="changes-feedback-sidebar" aria-label="Code feedback">
          <div className="changes-feedback-list-tools">
            <strong>
              {unresolved.length} unresolved{missing.length > 0 ? ' loaded' : ''}
            </strong>
            <label>
              <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Show
              resolved
            </label>
            <span title="File filters do not hide code feedback.">Includes hidden files</span>
          </div>
          <div className="changes-feedback-list" ref={list} tabIndex={-1} aria-label="Code threads">
            <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
              {virtual.getVirtualItems().map((row) => {
                const item = shown[row.index],
                  thread = item.thread;
                const unread =
                  feedbackFingerprint(item, account) !== readReviewState(feedbackReadKey(account, item)) &&
                  !!feedbackFingerprint(item, account);
                return (
                  <div
                    key={row.key}
                    ref={virtual.measureElement}
                    data-index={row.index}
                    style={{ position: 'absolute', top: 0, width: '100%', transform: `translateY(${row.start}px)` }}
                  >
                    <button
                      className="changes-feedback-row"
                      data-feedback-thread={thread.id}
                      data-resolved={thread.isResolved}
                      aria-current={feedbackKey(item) === selectedKey ? 'true' : undefined}
                      onClick={() => choose(item)}
                      onKeyDown={(event) => {
                        const offset = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
                        if (!offset) return;
                        event.preventDefault();
                        const next = Math.max(0, Math.min(shown.length - 1, row.index + offset));
                        virtual.scrollToIndex(next);
                        requestAnimationFrame(() =>
                          list.current?.querySelector<HTMLButtonElement>(`[data-index="${next}"] button`)?.focus()
                        );
                      }}
                    >
                      {subject.kind === 'stack' && (
                        <span className="changes-feedback-pr">
                          <SubjectIcon kind="pr" />#{item.member.number} {item.member.title}
                        </span>
                      )}
                      <span className="changes-feedback-path">
                        <FileTypeIcon filePath={thread.path} />
                        <strong title={thread.path}>{thread.path}</strong>
                      </span>
                      <span className="changes-feedback-excerpt" data-unread={unread}>
                        {item.comments[0]?.body.replace(/\s+/g, ' ')}
                      </span>
                      <span className="changes-feedback-meta">
                        {unread && <i aria-label="Unread" />} {item.comments[0]?.author?.login ?? 'Deleted account'} ·{' '}
                        {item.comments.length} {item.comments.length === 1 ? 'comment' : 'comments'} ·{' '}
                        {thread.isResolved
                          ? 'Resolved'
                          : thread.isOutdated
                            ? 'Earlier revision'
                            : thread.line
                              ? `Line ${thread.line}`
                              : 'No current line'}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
            {!shown.length && (
              <p className="changes-feedback-list-empty">
                {missing.length ? 'Loading conversations…' : 'No unresolved code threads.'}
              </p>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={() => onOpenFeedback?.()}>
            All feedback & review requests
          </Button>
        </aside>
        <section className="changes-feedback-main" aria-label="Feedback and code">
          <div className="changes-feedback-navigation">
            <Button className="changes-feedback-back" variant="ghost" size="sm" onClick={backToThreads}>
              <ArrowLeft size={14} />
              Threads
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous feedback thread"
              disabled={index <= 0}
              onClick={() => choose(shown[index - 1])}
            >
              <ArrowLeft size={16} />
            </Button>
            <span aria-live="polite">
              {index >= 0 ? `Thread ${index + 1} of ${shown.length}` : `${unresolved.length} unresolved threads`}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Next feedback thread"
              disabled={index < 0 || index >= shown.length - 1}
              onClick={() => choose(shown[index + 1])}
            >
              <ArrowRight size={16} />
            </Button>
            <span className="changes-toolbar-spacer" />
            {selected && (
              <span className="changes-feedback-pr" title={selected.member.title}>
                <SubjectIcon kind="pr" />#{selected.member.number} {selected.member.title}
              </span>
            )}
          </div>
          {lastResolved && (
            <div className="changes-feedback-undo" role="status">
              <Check size={14} aria-hidden="true" />
              <span title={`PR #${lastResolved.number} · ${lastResolved.path}`}>
                {lastResolved.id === selected?.id ? 'This thread resolved' : 'Previous thread resolved'} · #
                {lastResolved.number} · {lastResolved.path}
              </span>
              <button disabled={undoBusy} onClick={() => void undoResolution()}>
                {undoBusy ? 'Restoring…' : 'Undo'}
              </button>
            </div>
          )}
          {failures.length > 0 && (
            <div className="changes-feedback-refresh" role="status">
              <div>
                <span>
                  {failures.some((member) => !discussion.discussions[member.url]?.data)
                    ? `Feedback is incomplete for ${failures.length} ${failures.length === 1 ? 'PR' : 'PRs'}.`
                    : `Could not refresh feedback for ${failures.length} ${failures.length === 1 ? 'PR' : 'PRs'}.`}{' '}
                  Saved conversations remain available.
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={retrying}
                  onClick={() => void retryFeedback(failures.map((member) => member.url))}
                >
                  {retrying ? 'Retrying…' : 'Retry feedback'}
                </Button>
              </div>
              <details>
                <summary>Details</summary>
                {failures.map((member) => (
                  <p key={member.url}>
                    PR #{member.number}: {discussion.discussions[member.url]?.error}{' '}
                    <button disabled={retrying} onClick={() => void retryFeedback([member.url])}>
                      Retry PR #{member.number}
                    </button>
                  </p>
                ))}
              </details>
            </div>
          )}
          <div className="changes-feedback-content" ref={content}>
            {undoError && (
              <p className="changes-notice" role="alert">
                {undoError}
              </p>
            )}
            {readError && (
              <p role="alert" className="changes-notice">
                {readError}
              </p>
            )}
            {selected ? (
              <>
                <h2 className={current ? 'sr-only' : 'changes-feedback-heading'} ref={heading} tabIndex={-1}>
                  <FileTypeIcon filePath={selected.thread.path} />
                  {selected.thread.path}
                </h2>
                {current ? (
                  renderFile(target, {
                    threadId: selected.id,
                    line: selected.thread.line ?? undefined,
                    side: selected.thread.diffSide === 'LEFT' ? 'before' : 'after',
                    renderThread: (thread) => renderThread(selected, thread),
                  })
                ) : (
                  <div className="changes-feedback-original">
                    <p className="changes-notice">
                      <strong>{earlier ? 'Earlier revision' : 'Original comment context'}</strong>{' '}
                      {earlier
                        ? 'This thread is not attached to the displayed revision. Read the code as it was when commented.'
                        : 'This thread has no available location in the current diff.'}
                    </p>
                    {selected.comments[0]?.diffHunk ? (
                      <pre className="feedback-code" aria-label="Code when commented">
                        {selected.comments[0].diffHunk.split('\n').map((line, i) => (
                          <span
                            key={i}
                            data-change={line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : undefined}
                          >
                            {line}
                            {'\n'}
                          </span>
                        ))}
                      </pre>
                    ) : (
                      <p>GitHub did not provide the original code context.</p>
                    )}
                    {renderThread(selected, selected.thread)}
                    {target && (
                      <details>
                        <summary>Compare with the current file</summary>
                        {renderFile(target, {
                          threadId: selected.id,
                          side: 'after',
                          renderThread: (thread) => (thread.id === selected.id ? null : renderThread(selected, thread)),
                        })}
                      </details>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="changes-feedback-empty">
                {unresolved.length ? <MessageSquare size={24} /> : <Check size={24} />}
                <h2 ref={heading} tabIndex={-1}>
                  {missing.length
                    ? 'Feedback is still loading'
                    : unresolved.length
                      ? 'Address code feedback'
                      : failures.length
                        ? 'Feedback could not be confirmed'
                        : 'No unresolved code threads'}
                </h2>
                <p>
                  {unresolved.length
                    ? 'Read each conversation beside its code. Reply, resolve, then move to the next thread.'
                    : 'Resolved threads do not approve a PR. Review summaries and general comments may still need a response.'}
                </p>
                {unresolved[0] && <Button onClick={() => choose(unresolved[0])}>Start with the first thread</Button>}
                {reviewers.map((reviewer) => (
                  <div className="changes-feedback-reviewer" key={`${reviewer.member.url}:${reviewer.login}`}>
                    <p>
                      <strong>{reviewer.login}</strong> still requests changes on PR #{reviewer.member.number}.
                      {reviewer.requested && ' Another review has been requested.'}
                    </p>
                    <Button variant="outline" size="sm" onClick={() => onOpenFeedback?.(reviewer.member.url, true)}>
                      Review feedback & request review
                    </Button>
                  </div>
                ))}
                {!reviewers.length && (
                  <Button variant="outline" onClick={() => onOpenFeedback?.()}>
                    Open all feedback
                  </Button>
                )}
              </div>
            )}
          </div>
          {selected && (
            <div
              className="changes-feedback-dock"
              ref={setActionHost}
              aria-label={`Actions for PR #${selected.member.number} thread`}
            />
          )}
        </section>
      </div>
    </ReviewDraftScope.Provider>
  );
}
