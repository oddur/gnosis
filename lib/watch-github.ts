import type { GitHubSyncEvent, GitHubSyncInterest, GitHubSyncUpdate, GitHubSyncFailure } from './github-sync';

/**
 * Every view that watches GitHub shares one `github-sync` listener. Main sends one event per watch, addressed by its
 * id, so each event reaches only the view that asked for it. One listener per view would run every view's handler for
 * every event, and passes Node's limit of 10 listeners once a few PR tabs and queue rows are open.
 */
interface Watch {
  receive: (event: GitHubSyncEvent) => void;
  visibility: () => void;
}
const watches = new Map<string, Watch>();
let stopListening: (() => void) | undefined;
let nextId = 0;

const dispatch = (event: GitHubSyncEvent) => watches.get(event.subscriptionId)?.receive(event);
/** Hidden windows pause their watches; main resumes them when the window shows again. */
const onVisibility = () => {
  for (const watch of watches.values()) watch.visibility();
};

function attach(id: string, watch: Watch) {
  watches.set(id, watch);
  if (!stopListening) {
    stopListening = window.electronAPI.onGitHubSync?.(dispatch);
    document.addEventListener('visibilitychange', onVisibility);
  }
}
function detach(id: string) {
  if (!watches.delete(id) || watches.size) return;
  stopListening?.();
  stopListening = undefined;
  document.removeEventListener('visibilitychange', onVisibility);
}

/** Watches currently registered in this window. Diagnostics and tests read it. */
export const githubWatchCount = () => watches.size;

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
  const visibility = () => window.electronAPI.watchGitHub?.(id, document.visibilityState === 'hidden' ? null : interest);
  attach(id, {
    visibility,
    receive: (event) => {
      if (event.reset) {
        visibility();
        return;
      }
      for (const failure of event.failures ?? []) failed?.(failure);
      for (const update of event.updates) if (update.kind === interest.kind && urls.has(update.url)) receive(update);
    },
  });
  visibility();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    detach(id);
    window.electronAPI.watchGitHub?.(id, null);
  };
}
