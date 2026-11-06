import { useEffect, useRef, useState } from 'react';
import {
  peekDiscussion,
  readDiscussion,
  receiveDiscussion,
  hydrateDiscussion,
  subscribeDiscussions,
} from './review-discussion-cache';
import { watchGitHub } from './watch-github';
import type { EvidenceUpdateIssue } from './review-evidence';
import type { ReviewSubject } from './workbench';
import type { GitHubReviewThreads } from './review-threads';

/** Observe the shared cache while collapsed; only an expanded panel registers sync interest. */
export function useEvidenceDiscussions(
  subject: ReviewSubject,
  account: string | null,
  expanded: boolean,
  includeFeedback = false
) {
  const generation = useRef(0);
  const refreshing = useRef(false);
  const [busy, setBusy] = useState(false);
  const key = JSON.stringify(subject.members.map(({ url, headSha }) => ({ url, headSha })));
  const scope = `${account}:${key}`;
  const [state, setState] = useState<{
    scope: string;
    values: Partial<Record<string, GitHubReviewThreads>>;
    errors: Record<string, EvidenceUpdateIssue | undefined>;
  }>(() => ({
    scope,
    values: account
      ? Object.fromEntries(
          subject.members.flatMap(({ url }) => {
            const saved = peekDiscussion(url);
            return saved ? [[url, saved]] : [];
          })
        )
      : {},
    errors: {},
  }));
  useEffect(() => {
    generation.current++;
    refreshing.current = false;
    setBusy(false);
    if (!account) return;
    const targets = JSON.parse(key) as { url: string; headSha: string }[];
    const lifecycle = { live: true };
    const urls = new Set(targets.map((target) => target.url));
    setState((current) => ({
      scope,
      values: Object.fromEntries(
        targets.flatMap(({ url }) => {
          const saved = peekDiscussion(url);
          return saved ? [[url, saved]] : [];
        })
      ),
      errors: current.scope === scope ? current.errors : {},
    }));
    const unsubscribe = subscribeDiscussions((url, value) => {
      if (lifecycle.live && urls.has(url))
        setState((current) => ({
          ...current,
          values: { ...current.values, [url]: value },
          errors: { ...current.errors, [url]: undefined },
        }));
    });
    const fail = (url: string, message: string, retryAt?: number) => {
      if (lifecycle.live)
        setState((current) => ({ ...current, errors: { ...current.errors, [url]: { message, retryAt } } }));
    };
    if (expanded) {
      for (const { url } of targets) {
        void (async () => {
          try {
            // Browser fixtures and older hosts may not expose the cached read.
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            const cached = await window.electronAPI.getCachedReviewThreads?.(url);
            if (!lifecycle.live) return;
            if (cached) hydrateDiscussion(url, cached);
            if (includeFeedback && !peekDiscussion(url)?.feedback) await readDiscussion(url, true);
          } catch (error) {
            fail(url, error instanceof Error ? error.message : String(error));
          }
        })();
      }
    }
    const stop = expanded
      ? watchGitHub(
          { kind: 'discussion', priority: 'visible', targets },
          (update) => {
            if (update.kind === 'discussion') receiveDiscussion(update.url, update.value);
          },
          (error) => fail(error.url, error.message, error.retryAt)
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
      generation.current++;
      unsubscribe();
      stop?.();
    };
  }, [scope, key, account, expanded, includeFeedback]);
  async function refresh() {
    if (!account || !expanded || refreshing.current) return;
    const version = generation.current;
    refreshing.current = true;
    setBusy(true);
    try {
      for (const { url } of subject.members) {
        if (version !== generation.current) return;
        const issue = state.scope === scope ? state.errors[url] : undefined;
        if (issue?.retryAt && issue.retryAt > Date.now()) continue;
        try {
          // Joins in-flight reads; the backend still owns priority and rate-limit backoff.
          await readDiscussion(url, true);
        } catch (error) {
          if (version !== generation.current) return;
          setState((current) => ({
            ...current,
            errors: {
              ...current.errors,
              [url]: {
                message: error instanceof Error ? error.message : String(error),
              },
            },
          }));
        }
      }
    } finally {
      if (version === generation.current) {
        refreshing.current = false;
        setBusy(false);
      }
    }
  }
  const current: Pick<typeof state, 'values' | 'errors'> =
    state.scope === scope && account ? state : { values: {}, errors: {} };
  return { ...current, busy, refresh };
}
