import { useEffect, useId, useRef, useState, type ComponentProps } from 'react';
import { ReviewDiff } from './ReviewDiff';
import { GitHubReviewThread } from './GitHubReviewThread';
import {
  threadSource,
  threadPlacementReason,
  type GitHubReviewThread as Thread,
  type GitHubReviewThreads,
  type ReviewThreadAction,
} from '../lib/review-threads';
import type { ReviewGuide } from '../lib/types';

type Props = ComponentProps<typeof ReviewDiff> & { review?: ReviewGuide };

/** Load only PRs represented by the current topic; the main process coalesces file reads. */
export function ReviewFileDiscussion({ review, ...diff }: Props) {
  const source = review ? threadSource(review, diff.filePath) : null;
  const prUrl = source?.prUrl;
  const [data, setData] = useState<GitHubReviewThreads | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const previousPr = useRef<string | undefined>(undefined);
  const [refresh, setRefresh] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const unplacedSection = useRef<HTMLDivElement>(null);
  const unplacedId = useId();
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const version = ++request.current;
    if (previousPr.current !== prUrl) setData(null);
    previousPr.current = prUrl;
    setError('');
    if (!prUrl) return;
    setBusy(true);
    void window.electronAPI
      .getReviewThreads(prUrl, refresh > 0)
      .then((result) => {
        if (request.current === version) setData(result);
      })
      .catch((e: unknown) => {
        if (request.current === version) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (request.current === version) setBusy(false);
      });
    return () => {
      request.current++;
    };
  }, [prUrl, refresh]);
  const threads = data?.threads.filter((t) => t.path === source?.path) ?? [];
  const placed = threads.map((thread) => ({
    thread,
    reason:
      data && source
        ? threadPlacementReason(thread, data, source, diff.hunks, diff.fileStatus)
        : 'Revision unavailable.',
  }));
  const unplaced = placed.filter((p) => p.reason);
  const unresolved = threads.filter((thread) => !thread.isResolved).length;
  async function act(thread: Thread, action: ReviewThreadAction['action'], body?: string) {
    if (!prUrl) return;
    const updated = await window.electronAPI.reviewThreadAction({ prUrl, threadId: thread.id, action, body });
    setData((current) =>
      current ? { ...current, threads: current.threads.map((t) => (t.id === updated.id ? updated : t)) } : current
    );
  }
  const renderThread = (thread: Thread, reason?: string) => (
    <GitHubReviewThread
      key={thread.id}
      thread={thread}
      reason={reason}
      onAction={(action, body) => act(thread, action, body)}
    />
  );
  return (
    <div ref={root} className="review-file-discussion min-w-0">
      {prUrl && (
        <div className="github-discussion-toolbar">
          <span>
            {busy
              ? 'Loading GitHub comments…'
              : `${threads.length} GitHub ${threads.length === 1 ? 'thread' : 'threads'} · ${unresolved} unresolved`}
          </span>
          {unplaced.length > 0 && (
            <button
              aria-controls={unplacedId}
              onClick={() => {
                unplacedSection.current?.focus({ preventScroll: true });
                unplacedSection.current?.scrollIntoView({ block: 'start' });
              }}
            >
              View {unplaced.length} {unplaced.length === 1 ? 'thread' : 'threads'} below diff
            </button>
          )}
          <button
            className="github-discussion-refresh"
            disabled={busy}
            onClick={() => {
              const draft = root.current?.querySelector('textarea');
              if (draft) {
                draft.focus();
                setNotice('Finish or cancel your comment before refreshing GitHub threads.');
                return;
              }
              setNotice('');
              setRefresh((n) => n + 1);
            }}
          >
            Refresh comments
          </button>
        </div>
      )}
      {notice && (
        <p className="github-thread-reason text-xs px-3 py-2" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="github-thread-error" role="alert">
          Could not load GitHub comments. {error}
        </p>
      )}
      <ReviewDiff
        {...diff}
        threads={placed.filter((p) => !p.reason).map((p) => p.thread)}
        renderThread={renderThread}
      />
      {unplaced.length > 0 && (
        <div
          ref={unplacedSection}
          id={unplacedId}
          className="github-unplaced-threads"
          tabIndex={-1}
          role="region"
          aria-label="GitHub comments without matching lines"
        >
          <p>GitHub comments without matching lines in this diff</p>
          {unplaced.map(({ thread, reason }) => renderThread(thread, reason ?? undefined))}
        </div>
      )}
    </div>
  );
}
