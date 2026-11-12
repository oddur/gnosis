import { watchGitHub } from './watch-github';
import { useEffect, useRef, useState } from 'react';
import type { ReviewSubject } from './workbench';
import type { PrStatus } from './types';
import type { PrChecks } from './pr-checks';

/** Native views share a backend subscription; local cache reads never trigger network requests. */
export function usePrChecks(
  subject: ReviewSubject,
  account: string | null,
  enabled: boolean,
  statuses: Partial<Record<string, PrStatus>>,
  active = true
) {
  const signature = subject.members.map((m) => `${m.url}@${m.headSha}`).join('|');
  const scope = `${account}:${subject.id}`;
  const [state, setState] = useState<{
    scope: string;
    values: Partial<Record<string, PrChecks>>;
    errors: Partial<Record<string, string>>;
    busy: boolean;
  }>({ scope, values: {}, errors: {}, busy: false });
  const [attempt, setAttempt] = useState<{ nonce: number; url?: string }>({ nonce: 0 });
  const previousAttempt = useRef(0);
  const latestStatuses = useRef(statuses);
  latestStatuses.current = statuses;
  // One opened read per mount, for members that have nothing to show yet.
  const openedRead = useRef(false);
  const values = state.scope === scope && account ? { ...state.values } : {};
  if (account)
    for (const member of subject.members) {
      const seed = statuses[member.url]?.checkSnapshot;
      if (seed && seed.checkedAt > (values[member.url]?.checkedAt ?? -1)) values[member.url] = seed;
    }
  useEffect(() => {
    if (!account || !enabled) return;
    let live = true,
      loading = false;
    const force = attempt.nonce !== previousAttempt.current;
    previousAttempt.current = attempt.nonce;
    const update = (fn: (current: typeof state) => typeof state) => {
      if (live)
        setState((current) => fn(current.scope === scope ? current : { scope, values: {}, errors: {}, busy: false }));
    };
    const shown = new Set<string>();
    const load = async (cachedOnly: boolean, force = false, members = subject.members, opened = false) => {
      if (!live || loading || document.visibilityState === 'hidden') return;
      loading = true;
      if (!cachedOnly) update((current) => ({ ...current, busy: true }));
      await Promise.allSettled(
        members
          .filter((member) => !force || !attempt.url || member.url === attempt.url)
          .map(async (member) => {
            try {
              const value = await window.electronAPI.getPrChecks(
                { url: member.url, headSha: member.headSha },
                { cachedOnly, force, background: !force, ...(opened ? { opened } : {}) }
              );
              if (value) {
                shown.add(member.url);
                update((current) =>
                  value.checkedAt >= (current.values[value.url]?.checkedAt ?? -1)
                    ? { ...current, values: { ...current.values, [value.url]: value } }
                    : current
                );
              }
              if (!cachedOnly)
                update((current) => {
                  const errors = { ...current.errors };
                  Reflect.deleteProperty(errors, member.url);
                  return { ...current, errors };
                });
            } catch (error) {
              if (!cachedOnly)
                update((current) => ({
                  ...current,
                  errors: { ...current.errors, [member.url]: error instanceof Error ? error.message : String(error) },
                }));
            }
          })
      );
      loading = false;
      if (!cachedOnly) update((current) => ({ ...current, busy: false }));
    };
    const stop = watchGitHub(
      {
        kind: 'checks',
        priority: active ? 'active' : 'visible',
        targets: subject.members.map((member) => ({ url: member.url, headSha: member.headSha })),
      },
      (value) => {
        if (value.kind !== 'checks') return;
        update((current) =>
          value.value.checkedAt < (current.values[value.url]?.checkedAt ?? -1)
            ? current
            : {
                ...current,
                busy: false,
                values: { ...current.values, [value.url]: value.value },
                errors: { ...current.errors, [value.url]: '' },
              }
        );
      },
      (failure) =>
        update((current) => ({
          ...current,
          busy: false,
          errors: {
            ...current.errors,
            [failure.url]: `${failure.message.replace(/\.$/, '')}. Automatic updates resume at ${new Date(failure.retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`,
          },
        }))
    );
    if (stop)
      update((current) => ({
        ...current,
        busy: subject.members.some((member) => !current.values[member.url] && !current.errors[member.url]),
      }));
    void load(true).then(async () => {
      // With nothing saved and no status seed, the first read joins the status read at interactive priority.
      const empty = subject.members.filter(
        (member) =>
          !shown.has(member.url) && latestStatuses.current[member.url]?.checkSnapshot?.headSha !== member.headSha
      );
      const opened = active && !force && !openedRead.current && empty.length > 0;
      if (opened) {
        openedRead.current = true;
        await load(false, false, empty, true);
      }
      if (!stop || force) {
        const rest = opened ? subject.members.filter((member) => !empty.includes(member)) : subject.members;
        if (rest.length) await load(false, force, rest);
        return;
      }
      update((current) => ({
        ...current,
        busy: subject.members.some((member) => !current.values[member.url] && !current.errors[member.url]),
      }));
    });
    if (stop)
      return () => {
        live = false;
        stop();
      };
    const refresh = () => {
      void load(false);
    };
    const timer = setInterval(refresh, 30_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [scope, signature, enabled, attempt, active]);
  return {
    values,
    errors: state.scope === scope && account ? state.errors : {},
    busy: enabled && state.scope === scope && state.busy,
    refresh: (url?: string) => setAttempt((current) => ({ nonce: current.nonce + 1, url })),
  };
}
