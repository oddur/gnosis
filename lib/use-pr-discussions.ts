import { watchGitHub } from './watch-github';
import {
  readDiscussion,
  receiveDiscussion,
  refreshDiscussion,
  peekDiscussion,
  subscribeDiscussions,
  replaceDiscussionThread,
} from './review-discussion-cache';
import { useEffect, useRef, useState } from 'react';
import type { GitHubReviewThread, GitHubReviewThreads } from './review-threads';
interface Discussion {
  data?: GitHubReviewThreads;
  error?: string;
}
/** One cached discussion read per PR supplies every file's comments and counts. */
export function usePrDiscussions(urls: string[]) {
  const [discussions, setDiscussions] = useState<Record<string, Discussion | undefined>>(() =>
    Object.fromEntries(urls.map((url) => [url, { data: peekDiscussion(url) }]))
  );
  const versions = useRef(new Map<string, number>());
  const alive = useRef(true);
  const sequence = useRef(0);
  const signature = JSON.stringify(urls);
  const nextVersion = (url: string) => {
    const version = ++sequence.current;
    versions.current.set(url, version);
    return version;
  };
  async function load(url: string, refresh: boolean) {
    const version = nextVersion(url);
    try {
      const data = await (refresh ? refreshDiscussion(url) : readDiscussion(url));
      if (alive.current && versions.current.get(url) === version)
        setDiscussions((old) => ({ ...old, [url]: { data } }));
    } catch {
      if (alive.current && versions.current.get(url) === version)
        setDiscussions((old) => ({
          ...old,
          [url]: { ...old[url], error: 'GitHub comments are unavailable. Refresh comments to try again.' },
        }));
    }
  }
  useEffect(() => {
    alive.current = true;
    const stop = watchGitHub({ kind: 'discussion', priority: 'active', targets: urls.map(url => ({ url })) }, update => {
      if (update.kind === 'discussion') receiveDiscussion(update.url, update.value);
    }, failure => setDiscussions(old => ({ ...old, [failure.url]: { ...old[failure.url], error: 'Could not update comments. Showing saved comments; retrying automatically.' } })));
    const controller = new AbortController();
    void (async () => {
      for (const url of urls) {
        if (controller.signal.aborted) break;
        await load(url, false);
      }
    })();
    return () => {
      stop?.();
      controller.abort();
      alive.current = false;
      versions.current.clear();
    };
  }, [signature]);
  useEffect(
    () =>
      subscribeDiscussions((url, data) => {
        if (urls.includes(url)) {
          nextVersion(url);
          setDiscussions((old) => ({ ...old, [url]: { data } }));
        }
      }),
    [signature]
  );
  return {
    discussions,
    refresh: (url: string) => load(url, true),
    replace: (url: string, thread: GitHubReviewThread) => replaceDiscussionThread(url, thread),
  };
}
