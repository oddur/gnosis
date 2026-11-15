/**
 * ?instant-views: saved copies for every PR, and a slow GitHub. Main's saved-data reads answer at once; reads that
 * wait for the GitHub cache or the network wait as long as the URL asks:
 *
 * - `slow-start=<ms>` delays the queue snapshot and discovery, like main's `all` startup phase on a large cache.
 * - `slow-network=<ms>` delays every GitHub read: status, signals, checks, threads and both inventories.
 *
 * The page records `window.instantViews`: when the first queue row, the first PR description and any visible loading
 * state appeared (performance.now()), the renderer's startup marks, and each GitHub read with its mode.
 */
type Mocks = Record<string, unknown>;
type Read = { name: string; url?: string; mode?: unknown; at: number };

export function installInstantViews(mocks: Mocks) {
  const params = new URLSearchParams(location.search);
  const slowStart = Number(params.get('slow-start') ?? 0);
  const slowNetwork = Number(params.get('slow-network') ?? 0);
  const state = {
    marks: {} as Record<string, number>,
    firstQueueRow: undefined as number | undefined,
    firstDescription: undefined as number | undefined,
    /** The check badges of the first frame with queue rows. */
    firstChecks: [] as string[],
    /** When "Refreshing…" first showed in the queue header, and when it went away. */
    refreshing: undefined as [number, number?] | undefined,
    /** When main first answered with a queue: its snapshot or discovery. */
    snapshotAnswered: undefined as number | undefined,
    loading: [] as { title: string; at: number }[],
    reads: [] as Read[],
    slowStart,
    slowNetwork,
  };
  Object.assign(window, { instantViews: state });
  const wait = (ms: number) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
  const delayed = <A extends unknown[], R>(name: string, ms: number, read: (...args: A) => Promise<R>, url?: (args: unknown[]) => unknown,
    mode?: (args: unknown[]) => unknown) =>
    async (...args: A) => {
      const how = mode?.(args);
      state.reads.push({ name, url: url?.(args) as string | undefined, mode: how, at: performance.now() });
      // The queue's own background preparation is paced well behind the reader.
      await wait(how === 'background' ? ms * 4 : ms);
      return read(...args);
    };
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- Names the mock's signature.
  const fn = <A extends unknown[], R>(name: string) => mocks[name] as (...args: A) => Promise<R>;

  mocks.perfMark = (name: string) => { state.marks[name] ??= performance.now(); };
  // Native builds read saved copies first; preview fixtures opt in here.
  Object.assign(mocks, { githubSyncVersion: 1, watchGitHub: () => {}, onGitHubSync: () => () => {} });
  // Main's snapshot waits for the GitHub cache; discovery waits for GitHub.
  const snapshot = delayed('snapshot', slowStart, fn<[boolean?], unknown>('workbenchSnapshot'));
  mocks.workbenchSnapshot = async (withSignals?: boolean) => {
    const value = await snapshot(withSignals);
    state.snapshotAnswered ??= performance.now();
    return value;
  };
  const discover = delayed('queue', slowStart, fn<[boolean?], unknown>('workbenchQueue'));
  mocks.workbenchQueue = async (force?: boolean) => {
    const value = await discover(force);
    state.snapshotAnswered ??= performance.now();
    return value;
  };

  // Every PR has a saved status and saved discussion for its current head. Reading them waits for nothing.
  const status = fn<[string, boolean?, { cachedOnly?: boolean; headSha?: string }?], Record<string, unknown>>('getPrStatus');
  const liveStatus = delayed('status', slowNetwork, status, (a) => a[0], (a) => (a[1] ? 'force' : 'open'));
  mocks.getPrStatus = async (url: string, force?: boolean, options?: { cachedOnly?: boolean; headSha?: string }) => {
    if (!options?.cachedOnly) return liveStatus(url, force, options);
    const saved = await status(url, false, {});
    return { ...saved, stale: true, headSha: options.headSha, checkedAt: Date.now() - 5 * 60_000 };
  };
  const signals = fn<[{ url: string; headSha: string }[], { cachedOnly?: boolean }?], unknown[]>('getQueueSignals');
  mocks.getQueueSignals = (requests: { url: string; headSha: string }[], options?: { cachedOnly?: boolean }) =>
    options?.cachedOnly ? signals(requests, options) : delayed('signals', slowNetwork, signals, (a) => (a[0] as { url: string }[])[0]?.url)(requests, options);
  mocks.getCachedReviewThreads = (url: string) => {
    const stamp = new Date(Date.now() - 60 * 60_000).toISOString();
    return Promise.resolve({ headSha: 'fixture-head', baseSha: 'fixture-base', checkedAt: Date.now() - 5 * 60_000, threads: [],
      feedback: { comments: [{ id: `saved-${url}`, body: 'Saved discussion for this PR.', author: { login: 'maya', avatarUrl: '' }, createdAt: stamp,
        updatedAt: stamp, url: `${url}#issuecomment-1` }], reviews: [], requestedReviewers: [], viewerCanUpdate: true, state: 'OPEN' } });
  };
  // GitHub answers with the same discussion, later.
  const saved = mocks.getCachedReviewThreads as (url: string) => Promise<Record<string, unknown>>;
  mocks.getReviewThreads = delayed('threads', slowNetwork, async (url: string) => ({ ...(await saved(url)), checkedAt: Date.now() }), (a) => a[0]);
  // Inventories and file bodies: the mode says who asked (user, background, or a prediction label).
  const modeOf = (value: unknown) => (value && typeof value === 'object' && 'predicted' in value ? (value as { predicted: string }).predicted
    : value && typeof value === 'object' && 'background' in value ? ((value as { background?: boolean }).background ? 'background' : 'user')
      : value === true ? 'background' : 'user');
  // Main's GitHub cache keeps the inventories of PRs the reader opened; they come back from disk on the next launch.
  const savedKey = 'instant-views-saved-inventories';
  const savedUrls = new Set<string>(JSON.parse(sessionStorage.getItem(savedKey) ?? '[]') as string[]);
  const changes = fn<[string, boolean?, unknown?], { url: string }>('getPrChanges');
  const commits = fn<[string, boolean?, unknown?], unknown>('getPrCommits');
  mocks.getPreparedInventories = async (revisions: { url: string }[]) => {
    const urls = revisions.map((revision) => revision.url).filter((url) => savedUrls.has(url));
    return { changes: await Promise.all(urls.map((url) => changes(url))), commits: await Promise.all(urls.map((url) => commits(url))) };
  };
  const readChanges = delayed('changes', slowNetwork, changes, (a) => a[0], (a) => modeOf(a[2]));
  mocks.getPrChanges = (url: string, refresh?: boolean, options?: unknown) => {
    if (modeOf(options) === 'user') {
      savedUrls.add(url);
      sessionStorage.setItem(savedKey, JSON.stringify([...savedUrls]));
    }
    return readChanges(url, refresh, options);
  };
  mocks.getPrCommits = delayed('commits', slowNetwork, fn('getPrCommits'), (a) => a[0], (a) => modeOf(a[2]));
  mocks.getPrChangeFile = delayed('file', slowNetwork, fn('getPrChangeFile'), (a) => (a[0] as { url: string }).url, (a) => modeOf(a[1]));
  // Main's preparation of an open PR, a neighbour or a hovered row.
  const committed: { urls: string[]; tiers: number[]; label: string }[] = [];
  const intents: (string[] | null)[] = [];
  Object.assign(state, { committed, intents });
  mocks.prOpenCommitted = (targets: { url: string; tier: number }[] | null, label: string) => {
    if (targets) committed.push({ urls: targets.map((t) => t.url), tiers: targets.map((t) => t.tier), label });
    return wait(slowNetwork);
  };
  mocks.prOpenIntent = (targets: { url: string }[] | null) => { intents.push(targets && targets.map((t) => t.url)); };

  // Record first appearances before the browser paints them.
  const visible = (element: Element) => (element as HTMLElement).offsetParent !== null;
  const observer = new MutationObserver(() => {
    const at = performance.now();
    if (state.firstQueueRow === undefined && [...document.querySelectorAll('.queue-item')].some(visible)) {
      state.firstQueueRow = at;
      state.firstChecks = [...document.querySelectorAll('.queue-checks')].map((element) => element.textContent);
    }
    if (state.firstDescription === undefined && [...document.querySelectorAll('.pr-description')].some(visible)) state.firstDescription = at;
    const refreshing = [...document.querySelectorAll('.queue-freshness.is-refreshing')].some(visible);
    if (refreshing && !state.refreshing) state.refreshing = [at];
    else if (!refreshing && state.refreshing && state.refreshing[1] === undefined) state.refreshing[1] = at;
    for (const element of document.querySelectorAll('.loading-state')) {
      if (!visible(element)) continue;
      const title = element.querySelector('.loading-state-title')?.textContent ?? '';
      if (state.loading.at(-1)?.title !== title) state.loading.push({ title, at: Math.round(at) });
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
}
