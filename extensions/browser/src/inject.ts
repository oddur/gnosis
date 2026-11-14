import { buildGnosisLink, isSupportedPage } from './link.ts';

/** Marks the element the extension owns. There is at most one on the page. */
export const HOST_ATTRIBUTE = 'data-gnosis-open';
export const RELEASES_URL = 'https://github.com/oddur/gnosis/releases/latest';
/** The only value the extension stores: whether the user dismissed the "Gnosis didn't open" hint. */
export const HINT_DISMISSED_KEY = 'gnosisHintDismissed';
export const HINT_DELAY_MS = 1500;

/**
 * Where the button goes, first visible match wins: the React page header actions (pull requests and
 * commits), then the classic pull request header. Pages without either (compare) get a floating button.
 */
const ANCHOR_SELECTORS = ['[data-component="PH_Actions"]', '.gh-header-actions'];

export interface HintStore {
  isDismissed(): Promise<boolean>;
  dismiss(): Promise<void>;
}

export interface OpenInGnosisOptions {
  win: Window & typeof globalThis;
  scheme: string;
  store: HintStore;
  /** Opens the link. Defaults to navigating the page to it, which hands it to the registered app. */
  openLink?: (link: string) => void;
  hintDelayMs?: number;
  /** Whether a header container is shown. Defaults to a layout check; tests replace it. */
  isVisible?: (element: Element) => boolean;
  /** Called when the page starts or stops being supported, so the toolbar action can follow. */
  onSupportChange?: (supported: boolean) => void;
}

export interface OpenInGnosis {
  /** Adds, moves or removes the button to match the current page. Idempotent. */
  sync(): void;
  /** Opens the current page in Gnosis and watches for the "not installed" case. */
  open(): void;
  /** Starts the "not installed" watch only, for a link opened by the toolbar action. */
  watchForMissingApp(): void;
  stop(): void;
}

const STYLES = `
:host {
  all: initial;
  display: inline-flex;
  position: relative;
  vertical-align: middle;
  font-family: var(--fontStack-sansSerif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  font-size: 12px;
  line-height: 20px;
  color: var(--fgColor-default, #1f2328);
}
:host([data-placement="floating"]) {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 30;
}
.open {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: var(--control-small-size, 28px);
  padding: 0 10px;
  border: 1px solid var(--borderColor-default, #d1d9e0);
  border-radius: var(--borderRadius-full, 999px);
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
}
:host([data-placement="floating"]) .open {
  background: var(--bgColor-default, #ffffff);
  box-shadow: var(--shadow-floating-small, 0 1px 3px rgba(0, 0, 0, 0.12));
}
.open:hover {
  background: var(--bgColor-neutral-muted, rgba(129, 139, 152, 0.12));
}
.open:focus-visible,
.hint a:focus-visible,
.hint button:focus-visible {
  outline: 2px solid var(--focus-outlineColor, #0969da);
  outline-offset: 2px;
}
.open svg {
  width: 12px;
  height: 12px;
  color: var(--fgColor-muted, #59636e);
}
.hint {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 4px 4px 10px;
  border: 1px solid var(--borderColor-default, #d1d9e0);
  border-radius: var(--borderRadius-medium, 6px);
  background: var(--overlay-bgColor, var(--bgColor-default, #ffffff));
  box-shadow: var(--shadow-floating-small, 0 1px 3px rgba(0, 0, 0, 0.12));
  color: var(--fgColor-muted, #59636e);
  white-space: nowrap;
}
:host([data-placement="floating"]) .hint {
  top: auto;
  bottom: calc(100% + 6px);
}
.hint[hidden] {
  display: none;
}
.hint a {
  color: var(--fgColor-accent, #0969da);
  text-decoration: none;
}
.hint a:hover {
  text-decoration: underline;
}
.hint button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: var(--borderRadius-small, 3px);
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.hint button:hover {
  background: var(--bgColor-neutral-muted, rgba(129, 139, 152, 0.12));
}
`;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A plain "leave for another app" arrow, drawn for this extension. Built with DOM calls, not innerHTML. */
function arrowIcon(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  const attributes: Record<string, string> = {
    viewBox: '0 0 12 12',
    'aria-hidden': 'true',
    focusable: 'false',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.5',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  };
  for (const [name, value] of Object.entries(attributes)) svg.setAttribute(name, value);
  for (const d of ['M4 2.5h5.5V8', 'M9.5 2.5 2.5 9.5']) {
    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function defaultIsVisible(element: Element): boolean {
  return element.getClientRects().length > 0;
}

export function createOpenInGnosis(options: OpenInGnosisOptions): OpenInGnosis {
  const { win, scheme, store } = options;
  const doc = win.document;
  const openLink = options.openLink ?? ((link: string) => win.location.assign(link));
  const hintDelayMs = options.hintDelayMs ?? HINT_DELAY_MS;
  const isVisible = options.isVisible ?? defaultIsVisible;

  let lastSupported: boolean | undefined;
  let lastPath: string | undefined;
  let watchTimer: number | undefined;
  let stopWatch: (() => void) | undefined;

  function findAnchor(): Element | undefined {
    for (const selector of ANCHOR_SELECTORS) {
      for (const element of doc.querySelectorAll(selector)) {
        if (!element.closest(`[${HOST_ATTRIBUTE}]`) && isVisible(element)) return element;
      }
    }
    return undefined;
  }

  function hosts(): HTMLElement[] {
    return Array.from(doc.querySelectorAll<HTMLElement>(`[${HOST_ATTRIBUTE}]`));
  }

  function hintOf(host: Element): HTMLElement | null {
    return host.shadowRoot?.querySelector<HTMLElement>('.hint') ?? null;
  }

  function hideHint(): void {
    for (const host of hosts()) hintOf(host)?.setAttribute('hidden', '');
  }

  function cancelWatch(): void {
    if (watchTimer !== undefined) win.clearTimeout(watchTimer);
    watchTimer = undefined;
    stopWatch?.();
    stopWatch = undefined;
  }

  function createHost(): HTMLElement {
    const host = doc.createElement('span');
    host.setAttribute(HOST_ATTRIBUTE, '');
    const root = host.attachShadow({ mode: 'open' });

    const style = doc.createElement('style');
    style.textContent = STYLES;

    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'open';
    button.title = 'Open this page in the Gnosis app';
    const label = doc.createElement('span');
    label.textContent = 'Open in Gnosis';
    button.append(label, arrowIcon(doc));
    button.addEventListener('click', () => controller.open());

    const hint = doc.createElement('span');
    hint.className = 'hint';
    hint.setAttribute('role', 'status');
    hint.setAttribute('hidden', '');
    const message = doc.createElement('span');
    message.textContent = "Gnosis didn't open.";
    const get = doc.createElement('a');
    get.href = RELEASES_URL;
    get.target = '_blank';
    get.rel = 'noopener noreferrer';
    get.textContent = 'Get Gnosis →';
    get.addEventListener('click', () => hideHint());
    const dismiss = doc.createElement('button');
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.title = "Don't show this again";
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => {
      hideHint();
      void store.dismiss().catch(() => undefined);
      button.focus();
    });
    hint.append(message, get, dismiss);

    root.append(style, button, hint);
    return host;
  }

  function showHint(): void {
    const host = hosts().at(0);
    if (!host) return;
    hintOf(host)?.removeAttribute('hidden');
  }

  const controller: OpenInGnosis = {
    sync() {
      const href = win.location.href;
      const supported = isSupportedPage(href);
      if (supported !== lastSupported) {
        lastSupported = supported;
        options.onSupportChange?.(supported);
      }

      const path = win.location.pathname;
      if (path !== lastPath) {
        lastPath = path;
        cancelWatch();
        hideHint();
      }

      const existing = hosts();
      if (!supported) {
        for (const host of existing) host.remove();
        return;
      }
      for (const extra of existing.slice(1)) extra.remove();

      const host = existing.at(0) ?? createHost();
      // Already in a header: stay. GitHub mutates the page often; this avoids a layout check each time.
      const current = host.parentElement;
      if (host.getAttribute('data-placement') === 'inline' && current?.matches(ANCHOR_SELECTORS.join(','))) return;
      const anchor = findAnchor();
      const placement = anchor ? 'inline' : 'floating';
      const parent = anchor ?? doc.body;
      if (host.getAttribute('data-placement') !== placement) host.setAttribute('data-placement', placement);
      if (host.parentElement !== parent) {
        if (anchor) anchor.prepend(host);
        else doc.body.append(host);
      }
    },

    open() {
      // Read the URL now: GitHub changes the path and hash without a page load.
      const link = buildGnosisLink(win.location.href, scheme);
      hideHint();
      openLink(link);
      controller.watchForMissingApp();
    },

    watchForMissingApp() {
      cancelWatch();
      let leftPage = false;
      const onBlur = () => {
        leftPage = true;
      };
      const onVisibility = () => {
        if (doc.visibilityState === 'hidden') leftPage = true;
      };
      win.addEventListener('blur', onBlur);
      doc.addEventListener('visibilitychange', onVisibility);
      stopWatch = () => {
        win.removeEventListener('blur', onBlur);
        doc.removeEventListener('visibilitychange', onVisibility);
      };
      const pathAtClick = win.location.pathname;
      watchTimer = win.setTimeout(() => {
        cancelWatch();
        // An app that took the link takes focus too. If the page still has it, nothing opened.
        if (leftPage || !doc.hasFocus() || doc.visibilityState !== 'visible') return;
        if (win.location.pathname !== pathAtClick) return;
        void store
          .isDismissed()
          .catch(() => false)
          .then((dismissed) => {
            if (!dismissed) showHint();
          });
      }, hintDelayMs);
    },

    stop() {
      cancelWatch();
      for (const host of hosts()) host.remove();
    },
  };

  return controller;
}

/**
 * Keeps the button in step with GitHub's client-side navigation (Turbo, React routes and history
 * changes): any of these events, or any DOM change, schedules one `sync`.
 */
export function startOpenInGnosis(options: OpenInGnosisOptions): OpenInGnosis & { disconnect(): void } {
  const { win } = options;
  const doc = win.document;
  const controller = createOpenInGnosis(options);

  let scheduled: number | undefined;
  const schedule = () => {
    if (scheduled !== undefined) return;
    scheduled = win.setTimeout(() => {
      scheduled = undefined;
      controller.sync();
    }, 0);
  };

  const documentEvents = ['turbo:load', 'turbo:render', 'turbo:frame-load', 'pjax:end'];
  for (const name of documentEvents) doc.addEventListener(name, schedule);
  win.addEventListener('popstate', schedule);
  win.addEventListener('pageshow', schedule);

  // The Navigation API (Chrome, Edge) reports pushState navigations that the isolated world cannot hook.
  const navigation = (win as { navigation?: EventTarget }).navigation;
  navigation?.addEventListener('currententrychange', schedule);

  // Turbo replaces <body>, so watch the root element.
  const observer = new win.MutationObserver(schedule);
  observer.observe(doc.documentElement, { childList: true, subtree: true });

  controller.sync();

  return {
    ...controller,
    disconnect() {
      observer.disconnect();
      for (const name of documentEvents) doc.removeEventListener(name, schedule);
      win.removeEventListener('popstate', schedule);
      win.removeEventListener('pageshow', schedule);
      navigation?.removeEventListener('currententrychange', schedule);
      if (scheduled !== undefined) win.clearTimeout(scheduled);
      controller.stop();
    },
  };
}
