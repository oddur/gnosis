import { useEffect, useMemo, useState } from 'react';
import { isAutomationActor } from './github-actors';
import { isPendingComment, type GitHubReviewThreads } from './review-threads';
import { isResponseThread } from './response-needed';
import type { OverviewView } from './use-overview';
import type { SinceEvent } from './since-log';
import type { RereviewTarget } from './rereview-lines';
import { viewerReview, type QueueSignals } from './queue-signals';
import type { QueueItem } from './workbench';

/** "Since yesterday" reads the log again this often while the page shows. Local only. */
const SINCE_REFRESH_MS = 60_000;
const DAY_MS = 86_400_000;

/** Your latest submitted review of a PR on GitHub and the commit it was on, from its status. */
export function reviewedCommit(signals: QueueSignals | undefined, login: string): string | undefined {
  return viewerReview(signals, login)?.headSha ?? undefined;
}
/**
 * The commit "+N lines since your review" counts from: the one main found for your latest review of the PR (the
 * newer of the saved Gnosis review and your GitHub review), else your GitHub review's from status. Undefined when
 * the commit is not known: the row then says "updated since your review" without a count.
 */
export function rereviewFrom(item: Pick<QueueItem, 'sinceReview'>, signals: QueueSignals | undefined, url: string, login: string): string | undefined {
  if (item.sinceReview) return (item.sinceReview[url] as { from: string | null } | undefined)?.from ?? undefined;
  return reviewedCommit(signals, login);
}
/** The thread waiting on your reply, from a saved discussion: who wrote last and what. */
export function waitingReply(discussion: GitHubReviewThreads | undefined, login: string, author: string): { author: string; text: string } | undefined {
  for (const thread of discussion?.threads ?? []) {
    if (!isResponseThread(thread, login, author)) continue;
    const last = thread.comments.filter((comment) => !isPendingComment(comment) && !comment.isMinimized && !isAutomationActor(comment.author)).at(-1);
    if (last?.author) return { author: last.author.login, text: last.body };
  }
  return undefined;
}

/**
 * What the morning page reads beside the lanes (#390): the "Since yesterday" log, lines changed since your review
 * (one cached compare read per re-review PR, background priority), and the words of threads waiting on your reply
 * (saved discussions only, never a read). Nothing runs while the page is hidden.
 */
export function useMorningExtras(view: OverviewView, login: string | null, visible: boolean) {
  const [since, setSince] = useState<{ from: number; events: SinceEvent[] }>({ from: 0, events: [] });
  const from = view.visitAt ?? 0;
  useEffect(() => {
    if (!visible || !login || !window.electronAPI.getOverviewSince) return;
    let cancelled = false;
    const start = from || Date.now() - DAY_MS;
    const read = () =>
      void window.electronAPI.getOverviewSince?.(start).then(
        (events) => { if (!cancelled) setSince({ from: start, events }); },
        () => {}
      );
    read();
    const timer = setInterval(read, SINCE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [visible, login, from]);

  const review = view.lanes.find((lane) => lane.lane === 'review')?.rows ?? [];
  const answer = view.lanes.find((lane) => lane.lane === 'answer')?.rows ?? [];
  const targets = useMemo(() => {
    if (!login) return '';
    const list: RereviewTarget[] = review
      .filter((row) => row.reasons.includes('updated-since-review'))
      .flatMap((row) => {
        const reviewed = rereviewFrom(row.item, view.statusOf(row.focus), row.focus.url, login);
        return reviewed && reviewed !== row.focus.headSha ? [{ url: row.focus.url, from: reviewed, to: row.focus.headSha }] : [];
      })
      .slice(0, 10);
    return JSON.stringify(list);
  }, [review, view, login]);
  const [lines, setLines] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!visible || !targets || targets === '[]' || !window.electronAPI.getRereviewLines) return;
    let cancelled = false;
    void window.electronAPI.getRereviewLines(JSON.parse(targets) as RereviewTarget[]).then(
      (values) => {
        if (cancelled) return;
        setLines((current) => {
          const next = Object.fromEntries(values.map((value) => [value.url, value.lines]));
          return Object.entries(next).every(([url, n]) => current[url] === n) ? current : { ...current, ...next };
        });
      },
      () => {}
    );
    return () => {
      cancelled = true;
    };
  }, [visible, targets]);

  const replyKey = useMemo(
    () => JSON.stringify(answer.filter((row) => row.reasons.includes('replies')).map((row) => [row.focus.url, row.focus.author, row.focus.updatedAt])),
    [answer]
  );
  const [replies, setReplies] = useState<Record<string, { author: string; text: string }>>({});
  useEffect(() => {
    if (!visible || !login || replyKey === '[]') return;
    let cancelled = false;
    void Promise.all(
      (JSON.parse(replyKey) as [string, string, string][]).map(async ([url, author]) => {
        const discussion = await window.electronAPI.getCachedReviewThreads(url).catch(() => undefined);
        return [url, waitingReply(discussion, login, author)] as const;
      })
    ).then((entries) => {
      if (cancelled) return;
      const next = Object.fromEntries(entries.filter((entry): entry is readonly [string, { author: string; text: string }] => !!entry[1]));
      setReplies((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    });
    return () => {
      cancelled = true;
    };
  }, [visible, login, replyKey]);
  return { since, rereviewLines: lines, replies };
}
