import { useEffect, useRef, useState } from 'react';
import type { ReviewSubject } from './workbench';
import type { PrStatus } from './types';
import type { PrChecks } from './pr-checks';

/** The active overview owns one poller; cache reads never trigger network requests. */
export function usePrChecks(
  subject: ReviewSubject,
  account: string | null,
  enabled: boolean,
  statuses: Partial<Record<string, PrStatus>>
) {
  const signature = subject.members.map((m) => `${m.url}@${m.headSha}`).join('|');
  const scope = `${account}:${subject.id}`;
  const [state, setState] = useState<{
    scope: string;
    values: Partial<Record<string, PrChecks>>;
    errors: Partial<Record<string, string>>;
    busy: boolean;
  }>({ scope, values: {}, errors: {}, busy: false });
  const [attempt, setAttempt] = useState(0);
  const previousAttempt = useRef(0);
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
    const force = attempt !== previousAttempt.current;
    previousAttempt.current = attempt;
    const update = (fn: (current: typeof state) => typeof state) => {
      if (live)
        setState((current) => fn(current.scope === scope ? current : { scope, values: {}, errors: {}, busy: false }));
    };
    const load = async (cachedOnly: boolean, force = false) => {
      if (!live || loading || document.visibilityState === 'hidden') return;
      loading = true;
      if (!cachedOnly) update((current) => ({ ...current, busy: true }));
      await Promise.allSettled(
        subject.members.map(async (member) => {
          try {
            const value = await window.electronAPI.getPrChecks(
              { url: member.url, headSha: member.headSha },
              { cachedOnly, force, background: !force }
            );
            if (value)
              update((current) =>
                value.checkedAt >= (current.values[value.url]?.checkedAt ?? -1)
                  ? { ...current, values: { ...current.values, [value.url]: value } }
                  : current
              );
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
    void load(true).then(() => load(false, force));
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
  }, [scope, signature, enabled, attempt]);
  return {
    values,
    errors: state.scope === scope && account ? state.errors : {},
    busy: enabled && state.scope === scope && state.busy,
    refresh: () => setAttempt((n) => n + 1),
  };
}
