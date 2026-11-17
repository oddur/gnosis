import { useEffect, useMemo, useRef, useState } from 'react';
import { nextOverviewVisit, overviewModel, overviewStatusRequests, overviewVisitKey, parseOverviewVisit, type OverviewModel, type OverviewVisit } from './overview';
import { useOverviewStatus } from './use-queue-signals';
import { useStatusNow } from './status-clock';
import type { QueueItem } from './workbench';

/** At most this many PRs are read for status: twelve 25-PR batches. Your own PRs come first. */
const SIGNAL_LIMIT = 300;

function readVisit(key: string | null): OverviewVisit | undefined {
  if (!key) return undefined;
  try {
    return parseOverviewVisit(localStorage.getItem(key));
  } catch {
    return undefined;
  }
}
function saveVisit(key: string, visit: OverviewVisit) {
  try {
    localStorage.setItem(key, JSON.stringify(visit));
  } catch {
    // Storage may be full or unavailable; the next visit then shows nothing as new.
  }
}

/**
 * The Overview lanes for the window's queue snapshot (#390). Only status reads are added: saved status first, then,
 * while `live`, a read of every lane candidate without current status (`useOverviewStatus`). `checking` counts the
 * reads in flight. The model is memoized on the snapshot, the status values and the 30-second status clock,
 * so a sync tick that changes nothing builds nothing, and rows compare their own `signature`.
 *
 * "New since your last visit" is local and per account. A visit starts when the Overview is shown (`visible`) and is
 * saved when it is hidden, the window is hidden, or the page unloads.
 */
export function useOverview(input: {
  items: readonly QueueItem[];
  login: string | null;
  /** The status store scope: the signed-in account. */
  scope: string | null;
  live: boolean;
  visible: boolean;
  /** The queue snapshot has loaded, so an empty model means an empty queue. */
  ready: boolean;
  teamRequests?: boolean;
  excluded?: ReadonlySet<string>;
}): OverviewModel & { checking: number } {
  const { items, login, scope, live, visible, ready, teamRequests, excluded } = input;
  const requests = useMemo(
    () => (login ? overviewStatusRequests(items, login, { teamRequests, excluded }).slice(0, SIGNAL_LIMIT) : []),
    [items, login, teamRequests, excluded]
  );
  const { values, checking } = useOverviewStatus(scope, requests, live && !!login);
  const now = useStatusNow() || Date.now();
  const visitKey = login ? overviewVisitKey(login) : null;
  const [previous, setPrevious] = useState<{ key: string | null; visit?: OverviewVisit }>(() => ({ key: visitKey, visit: readVisit(visitKey) }));
  const model = useMemo(() => {
    const byUrl = new Map(values.map((value) => [value.url, value]));
    return overviewModel({
      items,
      signals: (member) => byUrl.get(member.url),
      login: login ?? '',
      now,
      teamRequests,
      previous: previous.key === visitKey ? previous.visit : undefined,
      excluded,
    });
  }, [items, values, login, now, teamRequests, previous, visitKey, excluded]);
  const latest = useRef({ model, ready });
  latest.current = { model, ready };
  useEffect(() => {
    if (!visible || !visitKey) return;
    // This visit compares with the last one; the rows seen now become the next visit's baseline.
    setPrevious({ key: visitKey, visit: readVisit(visitKey) });
    const save = () => {
      if (latest.current.ready) saveVisit(visitKey, nextOverviewVisit(latest.current.model, Date.now()));
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') save();
    };
    window.addEventListener('beforeunload', save);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      save();
      window.removeEventListener('beforeunload', save);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [visible, visitKey]);
  return useMemo(() => ({ ...model, checking }), [model, checking]);
}
