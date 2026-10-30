import type { GitHubSyncEvent, GitHubSyncInterest, GitHubSyncUpdate } from '../../lib/github-sync';
import type { QueueItem } from '../../lib/workbench';
export function installSyncFixture(mocks: Record<string, unknown>, items: QueueItem[]) {
  const subscriptions = new Map<string, GitHubSyncInterest>();
  const receivers = new Set<(event: GitHubSyncEvent) => void>();
  const queueListeners = new Set<() => void>();
  const activityListeners = new Set<() => void>();
  const counts = { queue: 0, snapshot: 0, activity: 0 };
  const originalQueue = mocks.workbenchQueue as () => Promise<unknown>;
  const originalActivity = mocks.listActivity as () => Promise<unknown>;
  Object.assign(mocks, {
    githubSyncVersion: 1,
    watchGitHub: (id: string, interest: GitHubSyncInterest | null) => {
      if (interest) subscriptions.set(id, interest);
      else subscriptions.delete(id);
    },
    onGitHubSync: (callback: (event: GitHubSyncEvent) => void) => {
      receivers.add(callback);
      return () => receivers.delete(callback);
    },
    onWorkbenchChanged: (callback: () => void) => {
      queueListeners.add(callback);
      return () => queueListeners.delete(callback);
    },
    onActivityChanged: (callback: () => void) => {
      activityListeners.add(callback);
      return () => activityListeners.delete(callback);
    },
    workbenchQueue: () => {
      counts.queue++;
      return originalQueue();
    },
    workbenchSnapshot: () => {
      counts.snapshot++;
      return originalQueue();
    },
    listActivity: () => {
      counts.activity++;
      return originalActivity();
    },
  });
  const emit = (update: GitHubSyncUpdate) => {
    for (const [id, interest] of subscriptions)
      if (interest.kind === update.kind && interest.targets.some((target) => target.url === update.url))
        receivers.forEach((callback) => callback({ account: 'oddur', subscriptionId: id, updates: [update] }));
  };
  Object.assign(window, {
    syncFixture: {
      subscriptions,
      counts,
      emit,
      rename: () => {
        items[1].subject.title = 'Updated through background sync';
        items[1].subject.members[0].title = items[1].subject.title;
        queueListeners.forEach((callback) => callback());
      },
      revision: () => {
        const member = items[1].subject.members[0];
        emit({ kind: 'metadata', url: member.url, value: { ...member, headSha: 'new-head' } });
      },
      checks: () => {
        const member = items[1].subject.members[0];
        emit({
          kind: 'checks',
          url: member.url,
          value: {
            url: member.url,
            headSha: member.headSha,
            checkedAt: Date.now() + 1_000,
            checks: [
              {
                id: 'check:100',
                databaseId: 100,
                name: 'Live check completed',
                status: 'completed',
                conclusion: 'success',
                kind: 'check',
                provider: 'GitHub Actions',
                required: true,
                startedAt: null,
                completedAt: null,
                url: '',
              },
            ],
          },
        });
      },
      activity: () => activityListeners.forEach((callback) => callback()),
    },
  });
}
