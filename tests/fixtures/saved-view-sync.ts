/**
 * ?github-sync&saved-view-sync: main's real GitHub sync scheduler runs in the page, behind the sync fixture's
 * subscriptions. Its reads are recorded in `window.viewSync.reads`, with `refresh` set for reads a view switch asked
 * for. `window.viewSync.advance(ms)` moves its clock; `fresh(url)` reads one PR now, as opening it would.
 * `refreshQueueRows` and `prOpenViewHover` calls are recorded in `window.viewSync.requests` and `.hovers`.
 */
import { createGitHubSyncService } from '../../src/github-sync-service';
import type { GitHubSyncInterest } from '../../lib/github-sync';
import type { OpenTarget } from '../../lib/pr-open-targets';
import type { QueueItem } from '../../lib/workbench';

export function installSavedViewSync(mocks: Record<string, unknown>, items: QueueItem[]) {
  // Only full GitHub revisions can be prepared; the shared fixture uses short placeholders.
  const sha = (text: string) => {
    let hex = '';
    for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16);
    return hex.padEnd(40, '0').slice(0, 40);
  };
  for (const member of items.flatMap((item) => item.subject.members)) {
    member.headSha = sha(member.headSha);
    member.baseSha = sha(member.baseSha);
  }
  let offset = 0;
  const reads: { urls: string[]; refresh: boolean }[] = [];
  const requests: string[][] = [];
  const hovers: string[][] = [];
  const sync = createGitHubSyncService({
    now: () => Date.now() + offset,
    account: () => 'oddur',
    enabled: () => true,
    backoff: () => undefined,
    read: (kind, targets, _priority, _followUp, refresh) => {
      if (kind === 'signals') reads.push({ urls: targets.map((target) => target.url), refresh: !!refresh });
      return Promise.resolve([]);
    },
    publish: () => {},
  });
  const watch = mocks.watchGitHub as (id: string, interest: GitHubSyncInterest | null) => void;
  Object.assign(mocks, {
    watchGitHub: (id: string, interest: GitHubSyncInterest | null) => {
      watch(id, interest);
      sync.observe(id, interest);
    },
    refreshQueueRows: (urls: string[]) => {
      requests.push(urls);
      // As main does: skip rows read within 30 s, and read the rest at once.
      if (sync.refreshRows(urls, ['signals']).length) void sync.tick();
    },
    prOpenViewHover: (targets: OpenTarget[]) => {
      hovers.push(targets.map((target) => target.url));
    },
  });
  setInterval(() => void sync.tick(), 100);
  Object.assign(window, {
    viewSync: {
      reads,
      requests,
      hovers,
      advance: (ms: number) => { offset += ms; },
      fresh: (url: string) => { if (sync.refresh([url], ['signals']).length) void sync.tick(); },
    },
  });
}
