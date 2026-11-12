/**
 * Startup readiness. The window opens before saved data and the GitHub cache load, so IPC handlers
 * wait for the stores they read. `data` covers saved app data, the GitHub budget and the saved login.
 * `all` also covers the GitHub cache.
 */
export interface Startup {
  data: Promise<void>;
  all: Promise<void>;
  resolveData: () => void;
  resolveAll: () => void;
  fail: (error: unknown) => void;
  /** Whether a phase has resolved, so ready handlers skip the extra await. */
  ready: (phase: 'data' | 'all') => boolean;
}

export function createStartup(): Startup {
  const state = { data: false, all: false };
  let resolveData!: () => void, resolveAll!: () => void;
  let rejectData!: (error: unknown) => void, rejectAll!: (error: unknown) => void;
  const data = new Promise<void>((resolve, reject) => { resolveData = resolve; rejectData = reject; });
  const all = new Promise<void>((resolve, reject) => { resolveAll = resolve; rejectAll = reject; });
  // A failed start exits the app; waiting handlers reject, and nothing else may observe the failure.
  data.catch(() => {});
  all.catch(() => {});
  return {
    data,
    all,
    resolveData: () => { state.data = true; resolveData(); },
    resolveAll: () => { state.data = state.all = true; resolveData(); resolveAll(); },
    fail: (error) => { rejectData(error); rejectAll(error); },
    ready: (phase) => state[phase],
  };
}

type Handler = (event: never, ...args: never[]) => unknown;
interface HandlerRegistry<H extends Handler> {
  handle: (channel: string, listener: H) => void;
}

/**
 * Wrap `handle` once, before any handler registers. Every handler waits for `all` unless it is listed:
 * `dataOnly` handlers wait for `data`, and `ungated` handlers run at once. New handlers are safe by default.
 */
export function gateHandlers<H extends Handler>(
  registry: HandlerRegistry<H>,
  startup: Startup,
  { ungated = [], dataOnly = [] }: { ungated?: readonly string[]; dataOnly?: readonly string[] }
): void {
  const handle = registry.handle.bind(registry);
  const gated = (channel: string, listener: H): H => {
    if (ungated.includes(channel)) return listener;
    const phase = dataOnly.includes(channel) ? 'data' : 'all';
    const ready = phase === 'data' ? startup.data : startup.all;
    return (async (event, ...args) => {
      if (!startup.ready(phase)) await ready;
      return listener(event, ...args);
    }) as H;
  };
  registry.handle = (channel, listener) => handle(channel, gated(channel, listener));
}

/** For `ipcMain.on` listeners: messages sent before startup finishes run afterwards, in order. */
export function afterStartup<A extends unknown[]>(startup: Startup, listener: (...args: A) => void) {
  return (...args: A) => {
    void startup.all.then(() => listener(...args), () => {});
  };
}
