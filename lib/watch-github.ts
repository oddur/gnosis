import type { GitHubSyncInterest, GitHubSyncUpdate, GitHubSyncFailure } from './github-sync';
let nextId = 0;
/** Native builds subscribe to shared backend work. Preview fixtures retain their existing fallbacks. */
export function watchGitHub(
  interest: GitHubSyncInterest,
  receive: (update: GitHubSyncUpdate) => void,
  failed?: (failure: GitHubSyncFailure) => void
): (() => void) | undefined {
  if (window.electronAPI.githubSyncVersion !== 1 || !window.electronAPI.watchGitHub || !window.electronAPI.onGitHubSync)
    return;
  const id = `watch-${++nextId}`;
  const urls = new Set(interest.targets.map((target) => target.url));
  const stop = window.electronAPI.onGitHubSync((event) => {
    if (event.subscriptionId !== id) return;
    if (event.reset) {
      visibility();
      return;
    }
    for (const failure of event.failures ?? []) failed?.(failure);
    for (const update of event.updates) if (update.kind === interest.kind && urls.has(update.url)) receive(update);
  });
  const visibility = () =>
    window.electronAPI.watchGitHub?.(id, document.visibilityState === 'hidden' ? null : interest);
  visibility();
  document.addEventListener('visibilitychange', visibility);
  return () => {
    stop();
    document.removeEventListener('visibilitychange', visibility);
    window.electronAPI.watchGitHub?.(id, null);
  };
}
