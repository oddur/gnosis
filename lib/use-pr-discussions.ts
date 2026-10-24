import { useEffect, useRef, useState } from 'react';
import type { GitHubReviewThread, GitHubReviewThreads } from './review-threads';
interface Discussion {
  data?: GitHubReviewThreads;
  error?: string;
}
/** One cached discussion read per PR supplies every file's comments and counts. */
export function usePrDiscussions(urls: string[]) {
  const [discussions, setDiscussions] = useState<Record<string, Discussion | undefined>>({});
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
      const data = await window.electronAPI.getReviewThreads(url, refresh);
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
    const controller = new AbortController();
    void (async () => {
      for (const url of urls) {
        if (controller.signal.aborted) break;
        await load(url, false);
      }
    })();
    return () => {
      controller.abort();
      alive.current = false;
      versions.current.clear();
    };
  }, [signature]);
  return {
    discussions,
    refresh: (url: string) => load(url, true),
    replace: (url: string, thread: GitHubReviewThread) => {
      if (!alive.current) return;
      nextVersion(url);
      setDiscussions((old) => {
        const data = old[url]?.data;
        return data
          ? {
              ...old,
              [url]: {
                data: {
                  ...data,
                  threads: data.threads.map((t) => (t.id === thread.id ? thread : t)).filter((t) => t.comments.length),
                },
              },
            }
          : old;
      });
    },
  };
}
