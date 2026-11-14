/**
 * Delivers notification events: settles bursts per PR, batches catch-up passes, routes each notification to
 * exactly one surface, rate-limits desktop notifications and counts what happened, locally.
 * No Electron imports: main injects the desktop notification factory, the toast sender and focus state.
 */
import type { DeepLinkTarget } from '../lib/deep-link';
import type { NotificationEvent } from '../lib/notification-events';
import { isPaused, isPrEvent, type NotificationEventType, type NotificationSettings } from '../lib/notification-settings';
import {
  batch,
  coalesce,
  digest,
  nextDesktopSlot,
  plainText,
  routeEvent,
  SETTLE_MS,
  truncate,
  TITLE_LIMIT,
  BODY_LIMIT,
  type DesktopState,
  type NotificationDelivery,
  type NotificationKind,
} from '../lib/notification-routing';
import type { CounterField } from './notification-store';

export interface DesktopNotification {
  on(event: 'show' | 'click' | 'close' | 'failed', listener: () => void): void;
  show(): void;
  close(): void;
}
export interface DesktopNotificationOptions {
  title: string;
  subtitle?: string;
  body: string;
  silent: boolean;
}
export type ToastAction = 'clicked' | 'dismissed' | 'timedOut';
/** Without a `show` event this soon, the desktop notification may have been blocked. Only a hint, never a reroute. */
export const SHOW_CONFIRM_MS = 3_000;
type Timer = ReturnType<typeof setTimeout>;

export function createNotificationService(deps: {
  settings: () => NotificationSettings;
  focus: () => { focused: boolean; activeUrl?: string };
  desktop: { supported: () => boolean; create: (options: DesktopNotificationOptions) => DesktopNotification };
  /** Shows a toast in the focused window, or the main window. False when no renderer can show it. */
  toast: (delivery: NotificationDelivery) => boolean;
  open: (target: DeepLinkTarget) => void;
  /** A click on a notification without a target, such as "Update ready", only shows Gnosis. */
  show?: () => void;
  count?: (kind: NotificationKind, field: CounterField) => void;
  platform?: string;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((timer: Timer) => clearTimeout(timer));
  const count = (kind: NotificationKind, field: CounterField) => deps.count?.(kind, field);
  let sequence = 0;
  const nextId = () => `notification-${++sequence}`;
  const settling = new Map<string, { events: NotificationEvent[]; timer: Timer }>();
  let catchUp: NotificationEvent[] | undefined;
  let held: NotificationEvent[] = [];
  let heldTimer: Timer | undefined;
  const shownAt: number[] = [];
  let overflow: NotificationDelivery[] = [];
  let overflowTimer: Timer | undefined;
  let waitingToasts: NotificationDelivery[] = [];
  const live = new Set<DesktopNotification>();
  const localKeys = new Set<string>();
  let failed = false;
  let unconfirmed = 0;
  let introOffered = false;

  const desktopState = (): DesktopState => (!deps.desktop.supported() ? 'unsupported' : failed ? 'failed' : 'available');
  const text = (value: string) => (deps.platform === 'linux' ? plainText(value) : value);

  function showToast(delivery: NotificationDelivery) {
    const settings = deps.settings();
    const introduce = !settings.introduced && !introOffered && delivery.types.some(isPrEvent);
    if (introduce) introOffered = true;
    const value = introduce ? { ...delivery, introduce: true } : delivery;
    if (deps.toast(value)) count(delivery.kind, 'toastShown');
    else waitingToasts = [...waitingToasts, value];
  }
  function showDesktop(delivery: NotificationDelivery) {
    const notification = deps.desktop.create({
      title: text(truncate(delivery.title, TITLE_LIMIT)),
      ...(delivery.subtitle ? { subtitle: text(delivery.subtitle) } : {}),
      body: text(truncate(delivery.body, BODY_LIMIT)),
      silent: true,
    });
    let confirmed = false;
    live.add(notification);
    const forget = () => live.delete(notification);
    notification.on('show', () => {
      confirmed = true;
      unconfirmed = 0;
      count(delivery.kind, 'desktopShown');
    });
    notification.on('click', () => {
      forget();
      count(delivery.kind, 'clicked');
      if (delivery.target) deps.open(delivery.target);
      else deps.show?.();
    });
    notification.on('close', forget);
    notification.on('failed', () => {
      forget();
      failed = true;
      count(delivery.kind, 'desktopFailed');
      // The OS refused it: show the same notification in the app, where it waits for the user's return.
      if (deps.settings().inApp) showToast(delivery);
    });
    notification.show();
    shownAt.push(now());
    while (shownAt.length > 10) shownAt.shift();
    setTimer(() => {
      if (!confirmed) unconfirmed++;
    }, SHOW_CONFIRM_MS);
  }
  function flushOverflow() {
    overflowTimer = undefined;
    if (!overflow.length) return;
    const waiting = overflow;
    overflow = [];
    const next = waiting.length === 1 ? waiting[0] : digest(waiting, nextId());
    if (waiting.length > 1) for (const item of waiting) count(item.kind, 'coalesced');
    route(next, true);
  }
  function route(delivery: NotificationDelivery, fromOverflow = false) {
    const type: NotificationEventType = delivery.types[0] ?? 'review-requested';
    const result = routeEvent({ type, url: delivery.url }, { ...deps.focus(), desktop: desktopState(), settings: deps.settings(), now: now() });
    if (result.surface === 'none') {
      count(delivery.kind, `suppressed:${result.reason}`);
      return;
    }
    if (result.surface === 'hold') return;
    if (result.surface === 'toast') {
      showToast(delivery);
      return;
    }
    const slot = nextDesktopSlot(shownAt, now());
    if (slot > now() || (!fromOverflow && overflow.length)) {
      overflow.push(delivery);
      overflowTimer ??= setTimer(flushOverflow, Math.max(0, slot - now()));
      return;
    }
    showDesktop(delivery);
  }
  function settle(url: string) {
    const pending = settling.get(url);
    settling.delete(url);
    if (!pending) return;
    const delivery = coalesce(pending.events, nextId());
    if (!delivery) return;
    if (pending.events.length > 1) count(delivery.kind, 'coalesced');
    route(delivery);
  }
  function hold(events: NotificationEvent[]) {
    held = [...held, ...events];
    for (const event of events) count(event.type, 'suppressed:paused');
    const until = deps.settings().pausedUntil;
    if (heldTimer) clearTimer(heldTimer);
    heldTimer = setTimer(() => service.settingsChanged(), Math.max(1_000, until - now() + 1_000));
  }
  const service = {
    /** PR events from the observer. */
    deliver(events: readonly NotificationEvent[]) {
      const settings = deps.settings();
      const enabled = events.filter((event) => {
        if (settings.events[event.type]) return true;
        count(event.type, 'suppressed:type-off');
        return false;
      });
      if (!enabled.length) return;
      if (isPaused(settings, now())) {
        hold(enabled);
        return;
      }
      if (catchUp) {
        catchUp.push(...enabled);
        return;
      }
      for (const event of enabled) {
        const url = event.url ?? event.key;
        const pending = settling.get(url);
        if (pending) pending.events.push(event);
        else settling.set(url, { events: [event], timer: setTimer(() => settle(url), SETTLE_MS) });
      }
    },
    /** A local result, such as "Explanation ready" or "Update ready": no settle window. */
    local(event: NotificationEvent) {
      if (localKeys.has(event.key)) return;
      localKeys.add(event.key);
      const settings = deps.settings();
      if (!settings.events[event.type]) {
        count(event.type, 'suppressed:type-off');
        return;
      }
      if (isPaused(settings, now())) {
        hold([event]);
        return;
      }
      const delivery = coalesce([event], nextId());
      if (delivery) route(delivery);
    },
    /** The first discovery after launch, resume or a gap: its events become one batch. */
    beginCatchUp() {
      catchUp ??= [];
    },
    endCatchUp() {
      const events = catchUp;
      catchUp = undefined;
      if (!events?.length) return;
      const deliveries = batch(events, nextId);
      if (deliveries.length === 1 && deliveries[0].kind === 'summary') for (const event of events) count(event.type, 'coalesced');
      for (const delivery of deliveries) route(delivery);
    },
    catchingUp: () => !!catchUp,
    /** Settings changed, or a pause ended: held events become one summary. */
    settingsChanged() {
      if (isPaused(deps.settings(), now()) || !held.length) return;
      if (heldTimer) clearTimer(heldTimer);
      heldTimer = undefined;
      const events = held;
      held = [];
      for (const delivery of batch(events, nextId, `${events.length} updates while notifications were paused`)) route(delivery);
    },
    /** The user marked PRs read: their waiting events are no longer news. */
    read(urls: readonly string[]) {
      for (const url of urls) {
        const pending = settling.get(url);
        if (pending) clearTimer(pending.timer);
        settling.delete(url);
      }
      const set = new Set(urls);
      held = held.filter((event) => !event.url || !set.has(event.url));
      waitingToasts = waitingToasts.filter((delivery) => !delivery.url || !set.has(delivery.url));
    },
    /** A renderer became ready: show toasts that had no window. More than three become one digest. */
    rendererReady() {
      const waiting = waitingToasts;
      waitingToasts = [];
      if (!waiting.length) return;
      const items = waiting.length > 3 ? [digest(waiting, nextId())] : waiting;
      for (const item of items) if (deps.toast(item)) count(item.kind, 'toastShown');
      else waitingToasts.push(item);
    },
    toastAction(kind: NotificationKind, action: ToastAction) {
      count(kind, action);
    },
    /** "Send test notification" and "Turn on": always a desktop notification when one can be shown. */
    test(): 'desktop' | 'toast' | 'none' {
      const delivery: NotificationDelivery = {
        id: nextId(),
        kind: 'test',
        title: 'Gnosis notifications are on',
        body: 'This is how Gnosis tells you when a PR needs you.',
        keys: [],
        types: [],
      };
      if (deps.settings().desktop && desktopState() !== 'unsupported') {
        showDesktop(delivery);
        return 'desktop';
      }
      if (deps.toast(delivery)) return 'toast';
      return 'none';
    },
    /** For Settings: whether desktop delivery looks blocked. Conservative: a `failed` event, or three unconfirmed shows. */
    status: () => ({ supported: deps.desktop.supported(), blocked: failed || unconfirmed >= 3 }),
    /** Flushes every settle window now. Tests and quit. */
    flush() {
      for (const url of [...settling.keys()]) {
        const pending = settling.get(url);
        if (pending) clearTimer(pending.timer);
        settle(url);
      }
      if (overflowTimer) clearTimer(overflowTimer);
      flushOverflow();
    },
    dispose() {
      for (const pending of settling.values()) clearTimer(pending.timer);
      settling.clear();
      if (overflowTimer) clearTimer(overflowTimer);
      if (heldTimer) clearTimer(heldTimer);
      live.clear();
    },
  };
  return service;
}
export type NotificationService = ReturnType<typeof createNotificationService>;
