import type { GitHubReviewThread, GitHubReviewThreads } from './review-threads';
const values = new Map<string, GitHubReviewThreads>();
const pending = new Map<string, Promise<GitHubReviewThreads>>();
const listeners = new Set<(url: string, data: GitHubReviewThreads) => void>();
const failureListeners = new Set<(url: string, error: unknown) => void>();
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
/** A background refresh of a saved discussion failed. The saved copy stays displayed. */
export function subscribeDiscussionFailures(callback: (url: string, error: unknown) => void) {
  failureListeners.add(callback);
  return () => {
    failureListeners.delete(callback);
  };
}
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
function publish(url: string, data: GitHubReviewThreads) {
  const current = values.get(url);
  // Unchanged content keeps its references, so scroll, selection and open editors are untouched.
  if (current) {
    const threads = same(current.threads, data.threads) ? current.threads : data.threads;
    const feedback = data.feedback && same(current.feedback, data.feedback) ? current.feedback : data.feedback;
    if (threads !== data.threads || feedback !== data.feedback)
      data = { ...data, threads, ...(feedback ? { feedback } : {}) };
  }
  values.set(url, data);
  while (values.size > 100) {
    const key = values.keys().next().value;
    if (key === undefined) break;
    values.delete(key);
  }
  listeners.forEach((fn) => fn(url, data));
}
function request(url: string, version: number, refresh: boolean, revalidate = false) {
  const read = (
    revalidate
      ? window.electronAPI.getReviewThreads(url, refresh, { revalidate: true })
      : window.electronAPI.getReviewThreads(url, refresh)
  )
    .then((data) => {
      if (version !== accountVersion) throw new Error('GitHub account changed. Reopen the PR to load comments.');
      // A write may have replaced this read in flight.
      if (pending.get(url) === read) publish(url, data);
      return values.get(url) ?? data;
    })
    .finally(() => {
      if (pending.get(url) === read) pending.delete(url);
    });
  pending.set(url, read);
  return read;
}
/** Shows the saved copy at once when the main process has one, then refreshes it behind the display. */
async function readSaved(
  url: string,
  version: number,
  lookup: () => Promise<GitHubReviewThreads> | undefined
): Promise<GitHubReviewThreads> {
  let saved: GitHubReviewThreads | undefined;
  try {
    saved = await window.electronAPI.getCachedReviewThreads(url);
  } catch {
    saved = undefined;
  }
  if (version !== accountVersion) throw new Error('GitHub account changed. Reopen the PR to load comments.');
  // A write, refresh or pushed update replaced this read while the saved copy loaded.
  if (pending.get(url) !== lookup()) return values.get(url) ?? pending.get(url) ?? readDiscussion(url);
  if (!saved) return request(url, version, false);
  hydrateDiscussion(url, { ...saved, stale: true });
  const shown = values.get(url) ?? { ...saved, stale: true };
  request(url, version, false, true).catch((error: unknown) => {
    if (version === accountVersion) failureListeners.forEach((fn) => fn(url, error));
  });
  return shown;
}
export function readDiscussion(url: string, refresh = false): Promise<GitHubReviewThreads> {
  const cached = values.get(url);
  if (!refresh && cached) return Promise.resolve(cached);
  const existing = pending.get(url);
  if (existing) return existing;
  const version = accountVersion;
  if (refresh) return request(url, version, true);
  // Browser fixtures and older hosts may not expose the saved read; ask GitHub at once.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!window.electronAPI.getCachedReviewThreads) return request(url, version, false);
  const lookup: Promise<GitHubReviewThreads> = readSaved(url, version, () => lookup).catch((error: unknown) => {
    if (pending.get(url) === lookup) pending.delete(url);
    throw error;
  });
  pending.set(url, lookup);
  return lookup;
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

/** Disk hydration is older evidence: display it immediately, but let an in-flight refresh win. */
export function hydrateDiscussion(url: string, data: GitHubReviewThreads) {
  const current = values.get(url);
  if (!current || (data.checkedAt ?? 0) > (current.checkedAt ?? 0)) publish(url, data);
}
