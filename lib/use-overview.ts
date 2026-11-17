import { useEffect, useMemo, useRef, useState } from 'react';
import { isOwnPr, reviewRequest } from './attention';
import { nextOverviewVisit, overviewModel, overviewVisitKey, parseOverviewVisit, type OverviewModel, type OverviewVisit } from './overview';
import { useLiveQueueSignals } from './use-queue-signals';
import { useStatusNow } from './status-clock';
import type { QueueItem, ReviewMember } from './workbench';

/** At most this many PRs are watched for status. Your own PRs come first. */
const SIGNAL_LIMIT = 150;

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
 * The Overview lanes for the window's queue snapshot (#390). Only status reads are added: saved status first, then the
 * shared watch while `live`. The model is memoized on the snapshot, the status values and the 30-second status clock,
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
}): OverviewModel {
  const { items, login, scope, live, visible, ready, teamRequests, excluded } = input;
  const requests = useMemo(() => {
    if (!login) return [];
    const own: ReviewMember[] = [];
    const others: ReviewMember[] = [];
    for (const item of items)
      for (const member of item.subject.members) {
        if (member.state !== 'open' || member.merged) continue;
        if (isOwnPr(member, login)) own.push(member);
        else if (reviewRequest(member, login)) others.push(member);
      }
    return [...own, ...others].slice(0, SIGNAL_LIMIT).map(({ url, headSha }) => ({ url, headSha }));
  }, [items, login]);
  const values = useLiveQueueSignals(scope, requests, live && !!login);
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
  return model;
}
