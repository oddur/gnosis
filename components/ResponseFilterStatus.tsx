import { useEffect, useRef, useState } from 'react';
import { watchGitHub } from '../lib/watch-github';
import type { GitHubSyncFailure } from '../lib/github-sync';
import { receiveDiscussion } from '../lib/review-discussion-cache';
import { publishQueueSignals } from '../lib/use-queue-signals';
import type { ReviewMember } from '../lib/workbench';
import { LoadingIndicator } from './LoadingState';
import { Button } from './ui/button';
import { RefreshCw } from 'lucide-react';

/** Register only PRs eligible for this view. The shared scheduler owns polling and backoff. */
export function ResponseFilterStatus({
  account,
  members,
  incomplete,
  onUpdated,
  onUnavailableChange,
}: {
  account: string;
  members: ReviewMember[];
  incomplete: number;
  onUpdated: () => void;
  onUnavailableChange: (count: number) => void;
}) {
  const key = JSON.stringify(members.map(({ url, headSha }) => ({ url, headSha })));
  const scope = `${account}:${key}`;
  const epoch = useRef(0);
  const retryLock = useRef(false);
  const [retrying, setRetrying] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const [state, setState] = useState<{
    scope: string;
    failures: Record<string, GitHubSyncFailure>;
    checkedAt?: number;
  }>({ scope, failures: {} });
  const failures = state.scope === scope ? Object.values(state.failures) : [];
  const affected = new Set(failures.map((failure) => failure.url)).size;
  const nextRetry = Math.min(...failures.map((failure) => failure.retryAt).filter((time) => time > clock));
  useEffect(() => {
    onUnavailableChange(affected);
    return () => onUnavailableChange(0);
  }, [affected, onUnavailableChange]);
  useEffect(() => {
    if (!Number.isFinite(nextRetry)) return;
    const timer = setTimeout(
      () => setClock(Date.now()),
      Math.min(2_147_483_647, Math.max(0, nextRetry - Date.now()) + 50)
    );
    return () => clearTimeout(timer);
  }, [nextRetry]);
  useEffect(() => {
    const version = ++epoch.current;
    const live = () => epoch.current === version;
    const targets = JSON.parse(key) as { url: string; headSha: string }[];
    const stops: (() => void)[] = [];
    const fail = (failure: GitHubSyncFailure) => {
      if (live())
        setState((previous) => ({
          scope,
          failures: {
            ...(previous.scope === scope ? previous.failures : {}),
            [`${failure.kind}:${failure.url}`]: failure,
          },
          checkedAt: previous.scope === scope ? previous.checkedAt : undefined,
        }));
    };
    for (let i = 0; i < targets.length; i += 200) {
      const chunk = targets.slice(i, i + 200);
      for (const kind of ['signals', 'discussion'] as const) {
        const stop = watchGitHub(
          { kind, targets: chunk, priority: 'visible' },
          (update) => {
            if (!live()) return;
            if (update.kind === 'discussion') receiveDiscussion(update.url, update.value);
            if (update.kind === 'signals') publishQueueSignals(account, [update.value]);
            setState((previous) => ({
              scope,
              checkedAt: Date.now(),
              failures: Object.fromEntries(
                Object.entries(previous.scope === scope ? previous.failures : {}).filter(
                  ([id]) => id !== `${kind}:${update.url}`
                )
              ),
            }));
            onUpdated();
          },
          fail
        );
        if (stop) stops.push(stop);
      }
    }
    // Older hosts and previews read once; there is no second polling loop.
    if (!stops.length && targets.length)
      void (async () => {
        for (const target of targets) {
          for (const kind of ['discussion', 'signals'] as const) {
            if (!live()) return;
            try {
              if (kind === 'discussion') {
                const value = await window.electronAPI.getReviewThreads(target.url);
                if (!live()) return;
                receiveDiscussion(target.url, value);
              } else {
                const values = await window.electronAPI.getQueueSignals([target]);
                if (!live()) return;
                publishQueueSignals(account, values);
              }
              onUpdated();
            } catch (error) {
              fail({
                kind,
                url: target.url,
                message: error instanceof Error ? error.message : String(error),
                retryAt: 0,
              });
            }
          }
        }
      })();
    return () => {
      epoch.current++;
      stops.forEach((stop) => stop());
    };
  }, [scope, key, account, onUpdated]);

  async function retry() {
    if (retryLock.current) return;
    const eligible = failures.filter((failure) => failure.retryAt <= Date.now());
    if (!eligible.length) return;
    const version = epoch.current;
    retryLock.current = true;
    setRetrying(true);
    try {
      for (const failure of eligible) {
        if (epoch.current !== version) return;
        const member = members.find((member) => member.url === failure.url);
        if (!member) continue;
        try {
          if (failure.kind === 'discussion') {
            const value = await window.electronAPI.getReviewThreads(member.url, true);
            if (epoch.current !== version) return;
            receiveDiscussion(member.url, value);
          } else {
            const values = await window.electronAPI.getQueueSignals([{ url: member.url, headSha: member.headSha }], {
              force: true,
            });
            if (epoch.current !== version) return;
            if (!values.length) throw new Error('GitHub has not returned updated status yet.');
            publishQueueSignals(account, values);
          }
          setState((previous) => ({
            scope,
            checkedAt: Date.now(),
            failures: Object.fromEntries(
              Object.entries(previous.scope === scope ? previous.failures : {}).filter(
                ([id]) => id !== `${failure.kind}:${failure.url}`
              )
            ),
          }));
          onUpdated();
        } catch (error) {
          if (epoch.current !== version) return;
          setState((previous) => ({
            ...previous,
            failures: {
              ...previous.failures,
              [`${failure.kind}:${failure.url}`]: {
                ...failure,
                message: error instanceof Error ? error.message : String(error),
                retryAt: Date.now() + 30_000,
              },
            },
          }));
          setClock(Date.now());
        }
      }
    } finally {
      retryLock.current = false;
      setRetrying(false);
    }
  }
  const retryTime = Number.isFinite(nextRetry)
    ? new Date(nextRetry).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : undefined;
  const checkedAt = state.scope === scope ? state.checkedAt : undefined;
  if (!affected && !incomplete && !checkedAt) return null;
  return (
    <div className="queue-response-status">
      {affected ? (
        <>
          <span role="status">
            Feedback checks paused for {affected} {affected === 1 ? 'PR' : 'PRs'}.{' '}
            {retryTime ? `Retrying at ${retryTime}.` : 'Showing last known results.'}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={retrying || !failures.some((failure) => failure.retryAt <= clock)}
            title={retryTime ? `Automatic retry at ${retryTime}` : 'Retry unavailable feedback'}
            onClick={() => void retry()}
          >
            <RefreshCw size={14} aria-hidden="true" className={retrying ? 'motion-safe:animate-spin' : undefined} />
            {retrying ? 'Retrying…' : 'Retry now'}
          </Button>
          <details>
            <summary>Details</summary>
            <ul>
              {failures.map((failure) => (
                <li key={`${failure.kind}:${failure.url}`}>
                  <strong>
                    #{members.find((member) => member.url === failure.url)?.number} ·{' '}
                    {failure.kind === 'discussion' ? 'Feedback' : 'Review status'}:
                  </strong>{' '}
                  {failure.message}
                </li>
              ))}
            </ul>
          </details>
        </>
      ) : incomplete ? (
        <LoadingIndicator>
          Checking {incomplete} {incomplete === 1 ? 'PR' : 'PRs'} for feedback…
        </LoadingIndicator>
      ) : (
        <span role="status">
          Feedback checked at{' '}
          {new Date(checkedAt ?? Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
        </span>
      )}
    </div>
  );
}
