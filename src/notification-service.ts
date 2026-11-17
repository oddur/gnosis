/**
 * Delivers notification events: settles bursts per PR, batches catch-up passes, routes each notification to
 * exactly one surface, rate-limits desktop notifications and counts what happened, locally.
 * No Electron imports: main injects the desktop notification factory, the toast sender and focus state.
 */
import type { DeepLinkTarget } from '../lib/deep-link';
import type { NotificationEvent, NotificationReplyTarget, ResolvedTypes } from '../lib/notification-events';
import { desktopExtras, type DesktopExtras, type QuickAction } from '../lib/notification-actions';
import { isPaused, isPrEvent, type NotificationEventType, type NotificationSettings } from '../lib/notification-settings';
import {
  batch,
  coalesce,
  digest,
  eventGate,
  nextDesktopSlot,
  plainText,
  QUIET_MS,
  quietSummary,
  routeEvent,
  SETTLE_MS,
  urgencyOf,
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
  /** macOS inline reply: the text typed. */
  on(event: 'reply', listener: (text: string) => void): void;
  /** macOS action button: its index in `actions`. */
  on(event: 'action', listener: (index: number) => void): void;
  show(): void;
  close(): void;
}
export interface DesktopNotificationOptions extends DesktopExtras {
  title: string;
  subtitle?: string;
  body: string;
  silent: boolean;
}
/** A reply GitHub did not take. The text is kept as a draft on the thread, and the app offers Retry. */
export interface ReplyFailure {
  delivery: NotificationDelivery;
  reply: NotificationReplyTarget;
  text: string;
  message: string;
}
export type ToastAction = 'clicked' | 'dismissed' | 'timedOut';
/** Without a `show` event this soon, the desktop notification may have been blocked. Only a hint, never a reroute. */
export const SHOW_CONFIRM_MS = 3_000;
const LIVE_LIMIT = 20;
type Timer = ReturnType<typeof setTimeout>;

export function createNotificationService(deps: {
  settings: () => NotificationSettings;
  focus: () => { focused: boolean; activeUrl?: string };
  desktop: { supported: () => boolean; create: (options: DesktopNotificationOptions) => DesktopNotification };
  /** Shows a toast in the focused window, or the main window. False when no renderer can show it. */
  toast: (delivery: NotificationDelivery) => boolean;
  /** Closes the toasts of these PRs in every window. */
  closeToasts?: (urls: string[]) => void;
  /** "10:42", for the summary that ends a PR's quiet period. */
  formatTime?: (at: number) => string;
  open: (target: DeepLinkTarget) => void;
  /** A click on a notification without a target, such as "Update ready", only shows Gnosis. */
  show?: () => void;
  count?: (kind: NotificationKind, field: CounterField) => void;
  platform?: string;
  /** The event icon file for Windows and Linux. */
  icon?: (kind: NotificationKind) => string | undefined;
  /** Posts an inline reply through the app's optimistic comment path. Rejects when GitHub refuses it. */
  reply?: (target: NotificationReplyTarget, text: string) => Promise<void>;
  replyFailed?: (failure: ReplyFailure) => void;
  /** "Snooze 1 h" or "Mark read": local only, never a GitHub write. */
  act?: (action: QuickAction, delivery: NotificationDelivery) => void;
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
  /** Shown desktop notifications, one per PR (keyed by URL; others by delivery id). */
  const live = new Map<string, DesktopNotification>();
  /**
   * Per-PR state for "one notification per PR": the urgency and time of the last banner, and what waits for the
   * end of the quiet period. Dropped when the PR's notification is handled.
   */
  const prs = new Map<string, { urgency: number; bannerAt: number; kind: NotificationKind; waiting: NotificationDelivery[]; timer?: Timer }>();
  const formatTime = deps.formatTime ?? ((at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
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
  /** The inline reply: posted, or kept for Retry when GitHub refuses it. With replies off, it only opens the thread. */
  async function sendReply(delivery: NotificationDelivery, typed: string) {
    const reply = delivery.reply;
    const body = typed.trim();
    if (!reply || !body) return;
    if (!deps.settings().allowReplies || !deps.reply) {
      if (delivery.target) deps.open(delivery.target);
      return;
    }
    try {
      await deps.reply(reply, body);
      count(delivery.kind, 'replied');
    } catch (error) {
      count(delivery.kind, 'replyFailed');
      deps.replyFailed?.({ delivery, reply, text: body, message: error instanceof Error ? error.message : String(error) });
    }
  }
  /** Closes the PR's shown desktop notification, which also removes it from Notification Centre and Action Center. */
  function replaceFor(prKey: string) {
    const previous = live.get(prKey);
    if (!previous) return;
    live.delete(prKey);
    previous.close();
  }
  function showDesktop(delivery: NotificationDelivery) {
    const prKey = delivery.url ?? delivery.id;
    replaceFor(prKey);
    const { extras, actions } = desktopExtras(delivery, {
      platform: deps.platform,
      allowReplies: deps.settings().allowReplies,
      icon: deps.platform === 'darwin' ? undefined : deps.icon?.(delivery.kind),
    });
    // Windows and Linux have no subtitle: the body names the repository there when it fits. The title names the PR.
    const named = `${delivery.body} · ${delivery.subtitle ?? ''}`;
    const body = (deps.platform === 'win32' || deps.platform === 'linux') && delivery.subtitle && named.length <= BODY_LIMIT ? named : delivery.body;
    const notification = deps.desktop.create({
      title: text(truncate(delivery.title, TITLE_LIMIT)),
      ...(delivery.subtitle ? { subtitle: text(delivery.subtitle) } : {}),
      body: text(truncate(body, BODY_LIMIT)),
      silent: true,
      ...extras,
      ...(extras.replyPlaceholder ? { replyPlaceholder: text(extras.replyPlaceholder) } : {}),
    });
    let confirmed = false;
    // Keep a reference so the click handler survives garbage collection. Ones left in the notification centre
    // never close, so only the newest are kept.
    live.set(prKey, notification);
    if (live.size > LIVE_LIMIT) live.delete(live.keys().next().value as string);
    const forget = () => {
      if (live.get(prKey) === notification) live.delete(prKey);
    };
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
    notification.on('reply', (typed) => {
      forget();
      void sendReply(delivery, typed);
    });
    notification.on('action', (index) => {
      const action = actions[index];
      if (!action) return;
      forget();
      count(delivery.kind, action === 'snooze' ? 'snoozed' : 'markedRead');
      deps.act?.(action, delivery);
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
  /**
   * One notification per PR. A PR without a recent banner, or a more urgent event, banners and replaces the PR's
   * notification. Anything else waits out the 15-minute quiet period and then becomes one summary.
   */
  function admit(delivery: NotificationDelivery): boolean {
    const url = delivery.url;
    if (!url || delivery.kind === 'test') return true;
    const pr = prs.get(url);
    const at = now();
    if (!pr || at - pr.bannerAt >= QUIET_MS || urgencyOf(delivery) < pr.urgency) {
      if (pr?.timer) clearTimer(pr.timer);
      // Events that waited before a more urgent banner are still news: they wait for this banner's quiet period.
      const waiting = pr && at - pr.bannerAt < QUIET_MS ? pr.waiting : [];
      const next = { urgency: urgencyOf(delivery), bannerAt: at, kind: delivery.kind, waiting, timer: undefined as Timer | undefined };
      if (waiting.length) next.timer = setTimer(() => endQuiet(url), QUIET_MS);
      prs.set(url, next);
      return true;
    }
    pr.waiting.push(delivery);
    count(delivery.kind, 'suppressed:quiet');
    pr.timer ??= setTimer(() => endQuiet(url), Math.max(0, pr.bannerAt + QUIET_MS - at));
    return false;
  }
  function endQuiet(url: string) {
    const pr = prs.get(url);
    if (!pr) return;
    pr.timer = undefined;
    const waiting = pr.waiting;
    pr.waiting = [];
    if (!waiting.length) return;
    route(quietSummary(waiting, nextId(), formatTime(pr.bannerAt)));
  }
  /** The PR's notification is handled: close it on both surfaces and forget what waits for it. */
  function close(urls: readonly string[], types?: ResolvedTypes) {
    const closed: string[] = [];
    for (const url of urls) {
      const pr = prs.get(url);
      if (types && (!pr || !types.includes(pr.kind as NotificationEventType))) continue;
      if (pr?.timer) clearTimer(pr.timer);
      prs.delete(url);
      if (live.has(url) || pr) closed.push(url);
      replaceFor(url);
    }
    const set = new Set(closed);
    waitingToasts = waitingToasts.filter((delivery) => !delivery.url || !set.has(delivery.url));
    if (closed.length) deps.closeToasts?.(closed);
  }
  function route(delivery: NotificationDelivery, fromOverflow = false) {
    const type: NotificationEventType = delivery.types[0] ?? 'review-requested';
    const result = routeEvent({ type, url: delivery.url }, { ...deps.focus(), desktop: desktopState(), settings: deps.settings(), now: now() });
    if (result.surface === 'none') {
      count(delivery.kind, `suppressed:${result.reason}`);
      return;
    }
    if (result.surface === 'hold') return;
    if (!fromOverflow && !admit(delivery)) return;
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
        const reason = eventGate(event, settings);
        if (!reason) return true;
        count(event.type, `suppressed:${reason}`);
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
      const reason = eventGate(event, settings);
      if (reason) {
        count(event.type, `suppressed:${reason}`);
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
      // One catch-up summary when a pause ends; a single event is shown as itself.
      for (const delivery of batch(events, nextId, `${events.length} updates while notifications were paused`, 2)) route(delivery);
    },
    /**
     * The PRs were handled: opened in Gnosis, read on any device, merged or closed. Their notifications close and
     * their waiting events are no longer news.
     */
    read(urls: readonly string[]) {
      for (const url of urls) {
        const pending = settling.get(url);
        if (pending) clearTimer(pending.timer);
        settling.delete(url);
      }
      const set = new Set(urls);
      held = held.filter((event) => !event.url || !set.has(event.url));
      waitingToasts = waitingToasts.filter((delivery) => !delivery.url || !set.has(delivery.url));
      close(urls);
    },
    /** What a PR's notification asked for is done, such as a submitted review or green checks: close it. */
    resolved(url: string, types: ResolvedTypes) {
      if (prs.has(url)) close([url], types);
    },
    /** PRs with a notification shown or waiting, for checking whether they became read elsewhere. */
    notifiedUrls: () => [...prs.keys()],
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
    /** "Snooze 1 h" or "Mark read" on a toast: the same local handlers as the desktop buttons. */
    quickAction(action: QuickAction, delivery: NotificationDelivery) {
      count(delivery.kind, action === 'snooze' ? 'snoozed' : 'markedRead');
      deps.act?.(action, delivery);
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
      for (const pr of prs.values()) if (pr.timer) clearTimer(pr.timer);
      prs.clear();
      if (overflowTimer) clearTimer(overflowTimer);
      if (heldTimer) clearTimer(heldTimer);
      live.clear();
    },
  };
  return service;
}
export type NotificationService = ReturnType<typeof createNotificationService>;
