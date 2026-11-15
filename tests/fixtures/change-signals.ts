import { createChangeSignals, type ChangedPr, type NotificationThread } from '../../lib/github-change-signals';
import { createHeadInvalidation, type HeadChange } from '../../lib/pr-heads';
import type { GitHubSyncInterest, GitHubSyncUpdate } from '../../lib/github-sync';
import type { QueueItem, ReviewMember } from '../../lib/workbench';

/**
 * A synthetic GitHub for change signals. The real `createChangeSignals` and `createHeadInvalidation` stand in for main:
 * they poll this fixture's notifications feed and changed-PR search on a fake clock, read only the PRs these name,
 * and publish through the sync fixture. Nothing here reaches GitHub.
 */
export function installChangeSignalsFixture(mocks: Record<string, unknown>, items: QueueItem[]) {
  const sync = (window as unknown as {
    syncFixture: { emit: (update: GitHubSyncUpdate) => void; subscriptions: Map<string, GitHubSyncInterest>; changed: () => void };
  }).syncFixture;
  const members = () => items.flatMap((item) => item.subject.members);
  const member = (url: string) => members().find((m) => m.url === url);
  // Real heads, so the head tracker accepts them.
  const hex = (c: string) => c.repeat(40);
  for (const [i, m] of members().entries()) m.headSha = hex('0123456789abcdef'[i % 16]);
  const clock = { now: Date.parse('2026-11-15T09:00:00Z') };
  const stamp = () => new Date(clock.now).toISOString();
  /** GitHub's copy of each PR. Changes here reach the app only through the signals. */
  const github = new Map<string, ReviewMember>(members().map((m) => [m.url, structuredClone(m)]));
  const threads: NotificationThread[] = [];
  let feedVersion = 0;
  const headListeners = new Set<(change: HeadChange) => void>();
  const record = {
    notifications: 0,
    notModified: 0,
    searches: 0,
    refreshed: [] as string[],
    heads: [] as HeadChange[],
    discoveries: 0,
  };
  const apiUrl = (url: string) => url.replace('https://github.com/', 'https://api.github.com/repos/').replace('/pull/', '/pulls/');
  /** What main's refresh does: read the PR, update the queue's saved copy, push it to watching views. */
  const refresh = (urls: string[]) => {
    for (const url of urls) {
      const fresh = github.get(url);
      if (!fresh || !member(url)) continue;
      record.refreshed.push(url);
      heads.note(url, fresh.headSha, { updatedAt: fresh.updatedAt, source: 'metadata' });
      // A new queue snapshot, as main sends over IPC: views that hold the old copy keep it until they read again.
      for (const item of items) {
        if (!item.subject.members.some((m) => m.url === url)) continue;
        const members = item.subject.members.map((m) => (m.url === url ? { ...m, ...structuredClone(fresh) } : m));
        item.subject = { ...item.subject, members, ...(item.subject.kind === 'pr' ? { title: fresh.title } : {}) };
      }
      sync.emit({ kind: 'metadata', url, value: fresh });
    }
    sync.changed();
    return Promise.resolve();
  };
  const heads = createHeadInvalidation({
    known: (url) => member(url),
    dropSaved: () => {},
    dropThreads: () => {},
    invalidateViews: () => {},
    readPr: (url) => void refresh([url]),
    broadcast: (change) => {
      record.heads.push(change);
      headListeners.forEach((listener) => listener(change));
    },
  });
  const signals = createChangeSignals({
    now: () => clock.now,
    mode: () => (document.visibilityState === 'hidden' ? 'off' : 'sync'),
    account: () => 'oddur',
    notifications: ({ etag }) => {
      record.notifications++;
      const current = `W/"feed-${feedVersion}"`;
      if (etag === current) {
        record.notModified++;
        return Promise.resolve({ status: 304, pollInterval: 60 });
      }
      return Promise.resolve({ status: 200, threads: [...threads], etag: current, lastModified: new Date(clock.now).toUTCString(), pollInterval: 60 });
    },
    search: (queries) => {
      record.searches++;
      const since = Date.parse(/updated:>=(\S+)/.exec(queries.involves)?.[1] ?? '');
      const prs: ChangedPr[] = [...github.values()]
        .filter((pr) => Date.parse(pr.updatedAt) >= since)
        .map((pr) => ({ id: `PR_${pr.number}`, url: pr.url, updatedAt: pr.updatedAt, headRefOid: pr.headSha }));
      return Promise.resolve({ prs, cost: 1, truncated: false });
    },
    known: (url) => member(url),
    head: (url, sha, updatedAt) => void heads.note(url, sha, { updatedAt, source: 'search' }),
    refresh,
    discover: () => {
      record.discoveries++;
    },
  });
  Object.assign(mocks, {
    onPrHeadChanged: (callback: (change: HeadChange) => void) => {
      headListeners.add(callback);
      return () => headListeners.delete(callback);
    },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  Object.assign(window, {
    changeFixture: {
      record,
      target: items[1].subject.members[0].url,
      other: items[0].subject.members[0].url,
      /** Main's 1 s sync tick, after `ms` of fake time. */
      async tick(ms = 0) {
        clock.now += ms;
        signals.tick();
        for (let i = 0; i < 5; i++) await settle();
      },
      /** Someone changed the PR on GitHub, and GitHub notified the reader. */
      comment(url: string, title: string) {
        clock.now += 1_000;
        const pr = github.get(url);
        if (!pr) throw Error(`Unknown fixture PR ${url}`);
        github.set(url, { ...pr, title, updatedAt: stamp() });
        threads.unshift({ id: String(threads.length + 1), reason: 'comment', unread: true, updated_at: stamp(), subject: { type: 'PullRequest', url: apiUrl(url), title } });
        feedVersion++;
      },
      /** Someone pushed to the PR, with notifications muted: only the search sees it. */
      push(url: string) {
        clock.now += 1_000;
        const pr = github.get(url);
        if (!pr) throw Error(`Unknown fixture PR ${url}`);
        github.set(url, { ...pr, headSha: hex('f'), updatedAt: stamp() });
      },
    },
  });
}
