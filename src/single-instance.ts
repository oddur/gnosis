/**
 * Startup for `gnosis://` links (#309 section 5): the single-instance lock, the macOS `open-url` buffer, the link
 * in our own argv, and OS registration. No Electron import: `src/single-instance-start.ts` passes the real `app`,
 * and tests pass a fake one.
 *
 * - The lock is scoped to the `userData` directory, so two instances with different `--user-data-dir` values each
 *   hold their own lock. It is always taken when packaged. In development it is opt-in (`GNOSIS_DEV_PROTOCOL=1`,
 *   or `GNOSIS_SINGLE_INSTANCE=1` for the lock without OS registration), because dev and packaged builds share
 *   `userData` and an unconditional lock would make `npm start` exit whenever the installed app is open.
 * - The losing instance forwards its link as `additionalData` and calls `app.exit(0)`, never `app.quit()`:
 *   `before-quit` in main.ts would run saves against stores that never opened.
 * - The OS starts the registered command without `--user-data-dir`, so links always reach the default profile.
 *
 * FOLLOW-UP (Windows, needs one manual Windows pass before it ships, decision 3 on #309): handle the Squirrel
 * hooks first, before the lock. `--squirrel-install` and `--squirrel-updated` register the protocol and exit,
 * `--squirrel-uninstall` calls `removeAsDefaultProtocolClient('gnosis')` and exits, `--squirrel-obsolete` exits,
 * all with `app.exit(0)`. Until then Windows registers on every packaged launch, which keeps the registry entry
 * pointing at the current `app-<version>\gnosis.exe`, and an uninstall leaves the key behind.
 */
import path from 'node:path';

export const PACKAGED_SCHEME = 'gnosis';
export const DEV_SCHEME = 'gnosis-dev';
const PENDING_LIMIT = 5;

/** `gnosis://` only when packaged, `gnosis-dev://` only in development. */
export const linkSchemes = (packaged: boolean): string[] => [packaged ? PACKAGED_SCHEME : DEV_SCHEME];

export function instancePolicy(packaged: boolean, env: Record<string, string | undefined>): { lock: boolean; register: boolean } {
  const devProtocol = !packaged && env.GNOSIS_DEV_PROTOCOL === '1';
  return { lock: packaged || devProtocol || env.GNOSIS_SINGLE_INSTANCE === '1', register: packaged || devProtocol };
}

/**
 * The link in a process's own argv: the single argument that starts with an accepted scheme. More than one means
 * none, so an injected second argument cannot ride along. Switches, Squirrel flags and paths are never links.
 */
export function linkFromArgv(argv: readonly string[], schemes: readonly string[]): string | undefined {
  const links = argv.filter((arg) => typeof arg === 'string' && schemes.some((scheme) => arg.toLowerCase().startsWith(`${scheme}:`)));
  return links.length === 1 ? links[0] : undefined;
}

/** `second-instance` reads `additionalData.link` only, never the argv Chromium rewrote. */
export function linkFromInstanceData(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const link = (data as { link?: unknown }).link;
  return typeof link === 'string' ? link : undefined;
}

/** The parts of Electron's `app` this module uses. */
export interface InstanceApp {
  readonly isPackaged: boolean;
  requestSingleInstanceLock(additionalData?: Record<string, unknown>): boolean;
  exit(exitCode?: number): void;
  on(event: string, listener: (...args: never[]) => void): unknown;
  whenReady(): Promise<unknown>;
  setAsDefaultProtocolClient(protocol: string, path?: string, args?: string[]): boolean;
}
export interface InstanceHandlers {
  /** An untrusted link from the OS. */
  receive: (raw: string, source: 'os') => void;
  /** Another launch on this profile without a link: focus the window. */
  show: () => void;
}
export interface SingleInstance {
  /** False in the process that lost the lock; it is already exiting. */
  primary: boolean;
  schemes: string[];
  /** Hands over buffered links once the deep-link service and a window exist. */
  attach: (handlers: InstanceHandlers) => void;
}

export function startSingleInstance(
  app: InstanceApp,
  options: { env: Record<string, string | undefined>; argv: readonly string[]; execPath: string; log?: (line: string) => void }
): SingleInstance {
  const schemes = linkSchemes(app.isPackaged);
  const policy = instancePolicy(app.isPackaged, options.env);
  const launchLink = linkFromArgv(options.argv, schemes);
  const log = options.log ?? ((line: string) => console.log(line));
  // `undefined` is a launch without a link: it only focuses the window.
  let pending: (string | undefined)[] = [];
  let handlers: InstanceHandlers | undefined;
  const forward = (link: string | undefined) => {
    if (!handlers) {
      pending = [...pending, link].slice(-PENDING_LIMIT);
      return;
    }
    if (link) handlers.receive(link, 'os');
    else handlers.show();
  };
  if (policy.lock) {
    if (!app.requestSingleInstanceLock(launchLink ? { link: launchLink } : {})) {
      log('[link] another instance holds this profile; forwarded to it');
      app.exit(0);
      return { primary: false, schemes, attach: () => {} };
    }
    app.on('second-instance', (_event: never, _argv: never, _cwd: never, data: never) => forward(linkFromInstanceData(data)));
  }
  // macOS: a cold launch can deliver the link before `ready`, so this listener is registered now and buffers.
  app.on('open-url', (event: never, url: never) => {
    (event as { preventDefault?: () => void }).preventDefault?.();
    forward(typeof url === 'string' ? url : undefined);
  });
  if (launchLink) pending.push(launchLink);
  if (policy.register) {
    void app.whenReady().then(() => {
      // Windows writes HKCU\Software\Classes\<scheme> with the current exe, which changes on every update, so this
      // runs on every launch. Development binds the Electron binary plus our app path, and only when opted in.
      const registered = app.isPackaged
        ? app.setAsDefaultProtocolClient(PACKAGED_SCHEME)
        : app.setAsDefaultProtocolClient(DEV_SCHEME, options.execPath, [path.resolve(options.argv[1] ?? '.')]);
      log(`[link] registered scheme=${schemes[0]} result=${registered ? 'ok' : 'failed'}`);
    });
  }
  return {
    primary: true,
    schemes,
    attach(next) {
      handlers = next;
      const items = pending;
      pending = [];
      for (const link of items) forward(link);
    },
  };
}
