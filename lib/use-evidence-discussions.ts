import { useEffect, useState } from 'react';
import { peekDiscussion, readDiscussion, receiveDiscussion, subscribeDiscussions } from './review-discussion-cache';
import { watchGitHub } from './watch-github';
import type { ReviewSubject } from './workbench';
import type { GitHubReviewThreads } from './review-threads';

/** Observe the shared cache while collapsed; only an expanded panel registers sync interest. */
export function useEvidenceDiscussions(
  subject: ReviewSubject,
  account: string | null,
  expanded: boolean
): { values: Record<string, GitHubReviewThreads>; errors: Record<string, string> } {
  const key = JSON.stringify(subject.members.map(({ url, headSha }) => ({ url, headSha })));
  const scope = `${account}:${key}`;
  const [state, setState] = useState<{
    scope: string;
    values: Record<string, GitHubReviewThreads>;
    errors: Record<string, string>;
  }>({ scope: '', values: {}, errors: {} });
  useEffect(() => {
    if (!account) return;
    const targets = JSON.parse(key) as { url: string; headSha: string }[];
    const lifecycle = { live: true };
    const urls = new Set(targets.map((target) => target.url));
    setState({
      scope,
      values: Object.fromEntries(
        targets.flatMap(({ url }) => {
          const saved = peekDiscussion(url);
          return saved ? [[url, saved]] : [];
        })
      ),
      errors: {},
    });
    const unsubscribe = subscribeDiscussions((url, value) => {
      if (lifecycle.live && urls.has(url))
        setState((current) => ({
          ...current,
          values: { ...current.values, [url]: value },
          errors: { ...current.errors, [url]: '' },
        }));
    });
    const fail = (url: string, message: string) => {
      if (lifecycle.live) setState((current) => ({ ...current, errors: { ...current.errors, [url]: message } }));
    };
    const stop = expanded
      ? watchGitHub(
          { kind: 'discussion', priority: 'visible', targets },
          (update) => {
            if (update.kind === 'discussion') receiveDiscussion(update.url, update.value);
          },
          (error) => fail(error.url, error.message)
        )
      : undefined;
    if (expanded && !stop) {
      // Preview/older hosts use the existing deduplicated reader. Native sync owns polling and backoff.
      void (async () => {
        for (const { url } of targets) {
          if (!lifecycle.live) break;
          try {
            await readDiscussion(url);
          } catch {
            fail(url, 'Open the PR on GitHub, or reopen this panel to retry.');
          }
        }
      })();
    }
    return () => {
      lifecycle.live = false;
      unsubscribe();
      stop?.();
    };
  }, [scope, key, account, expanded]);
  return state.scope === scope && account ? state : { values: {}, errors: {} };
}
