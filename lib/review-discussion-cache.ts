import type { GitHubReviewThread, GitHubReviewThreads } from './review-threads';
const values = new Map<string, GitHubReviewThreads>();
const pending = new Map<string, Promise<GitHubReviewThreads>>();
const listeners = new Set<(url: string, data: GitHubReviewThreads) => void>();
let account: string | undefined;
let accountVersion = 0;
export function setDiscussionAccount(next: string) {
  if (account === next) return;
  account = next;
  accountVersion++;
  pending.clear();
  const urls = [...values.keys()];
  values.clear();
  for (const url of urls) listeners.forEach((fn) => fn(url, { headSha: '', baseSha: '', threads: [] }));
}
export const peekDiscussion = (url: string) => values.get(url);
export function subscribeDiscussions(callback: (url: string, data: GitHubReviewThreads) => void) {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}
function publish(url: string, data: GitHubReviewThreads) {
  values.set(url, data);
  while (values.size > 100) {
    const key = values.keys().next().value;
    if (key === undefined) break;
    values.delete(key);
  }
  listeners.forEach((fn) => fn(url, data));
}
export function readDiscussion(url: string, refresh = false) {
  const cached = values.get(url);
  if (!refresh && cached) return Promise.resolve(cached);
  const existing = pending.get(url);
  if (existing) return existing;
  const version = accountVersion;
  const request = window.electronAPI
    .getReviewThreads(url, refresh)
    .then((data) => {
      if (version !== accountVersion) throw new Error('GitHub account changed. Reopen the PR to load comments.');
      // A write may have replaced this read in flight.
      if (pending.get(url) === request) publish(url, data);
      return values.get(url) ?? data;
    })
    .finally(() => {
      if (pending.get(url) === request) pending.delete(url);
    });
  pending.set(url, request);
  return request;
}
export function replaceDiscussionThread(url: string, thread: GitHubReviewThread) {
  pending.delete(url);
  const data = values.get(url);
  if (data)
    publish(url, {
      ...data,
      threads: data.threads.map((t) => (t.id === thread.id ? thread : t)).filter((t) => t.comments.length),
    });
}
export function refreshDiscussion(url: string) {
  pending.delete(url);
  return readDiscussion(url, true);
}

/** Backend refreshes share the same renderer cache as local comment writes. */
export function receiveDiscussion(url: string, data: GitHubReviewThreads) {
  pending.delete(url);
  publish(url, data);
}
