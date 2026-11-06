import { useEffect, useState } from 'react';
import { watchGitHub } from '../lib/watch-github';
import { receiveDiscussion } from '../lib/review-discussion-cache';
import { publishQueueSignals } from '../lib/use-queue-signals';
import type { ReviewMember } from '../lib/workbench';
import { LoadingIndicator } from './LoadingState';

/** Register only the authored PRs eligible for this view. The shared scheduler owns polling and backoff. */
export function ResponseFilterStatus({
  account,
  members,
  incomplete,
  onUpdated,
}: {
  account: string;
  members: ReviewMember[];
  incomplete: number;
  onUpdated: () => void;
}) {
  const key = JSON.stringify(members.map(({ url, headSha }) => ({ url, headSha })));
  const scope = `${account}:${key}`;
  const [failures, setFailures] = useState<{ scope: string; values: Record<string, string> }>({ scope, values: {} });
  useEffect(() => {
    const lifecycle = { live: true };
    const isLive = () => lifecycle.live;
    const targets = JSON.parse(key) as { url: string; headSha: string }[];
    const stops: (() => void)[] = [];
    const fail = (id: string, message: string) => {
      if (lifecycle.live)
        setFailures((previous) => ({
          scope,
          values: { ...(previous.scope === scope ? previous.values : {}), [id]: message },
        }));
    };
    for (let i = 0; i < targets.length; i += 200) {
      const chunk = targets.slice(i, i + 200);
      for (const kind of ['signals', 'discussion'] as const) {
        const stop = watchGitHub(
          { kind, targets: chunk, priority: 'visible' },
          (update) => {
            if (!isLive()) return;
            if (update.kind === 'discussion') receiveDiscussion(update.url, update.value);
            if (update.kind === 'signals') publishQueueSignals(account, [update.value]);
            setFailures((previous) => {
              const values = Object.fromEntries(
                Object.entries(previous.scope === scope ? previous.values : {}).filter(
                  ([id]) => id !== `${kind}:${update.url}`
                )
              );
              return { scope, values };
            });
            onUpdated();
          },
          (failure) => fail(`${kind}:${failure.url}`, failure.message)
        );
        if (stop) stops.push(stop);
      }
    }
    // Preview/older hosts have no sync subscription. Read once, without a second polling loop.
    if (!stops.length && targets.length)
      void (async () => {
        for (const target of targets) {
          if (!isLive()) return;
          try {
            const discussion = await window.electronAPI.getReviewThreads(target.url);
            if (!isLive()) return;
            receiveDiscussion(target.url, discussion);
            const signals = await window.electronAPI.getQueueSignals([target]);
            if (!isLive()) return;
            publishQueueSignals(account, signals);
            onUpdated();
          } catch (error) {
            fail(target.url, error instanceof Error ? error.message : String(error));
          }
        }
      })();
    return () => {
      lifecycle.live = false;
      stops.forEach((stop) => stop());
    };
  }, [scope, key, account, onUpdated]);
  const errors = failures.scope === scope ? [...new Set(Object.values(failures.values))] : [];
  return (
    <div className="queue-response-status">
      {errors.length ? (
        <details>
          <summary>Some feedback could not be checked. Showing cached matches.</summary>
          <p>{errors.join(' ')}</p>
        </details>
      ) : incomplete ? (
        <LoadingIndicator>
          Checking feedback on {incomplete} {incomplete === 1 ? 'PR' : 'PRs'}… Showing known matches.
        </LoadingIndicator>
      ) : (
        <span>Your PRs with changes requested or unresolved feedback. Updates automatically.</span>
      )}
    </div>
  );
}
