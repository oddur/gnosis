/**
 * What a notification lets you do besides open it (#385 part 2). Pure, so main, the renderer and tests agree.
 *
 * - **Inline reply** on macOS: mentions, replies and change requests that have a thread to answer, while
 *   "Allow replies from notifications" is on. Electron raises reply events on macOS only, so Windows and Linux
 *   offer **Open thread** instead: the notification itself opens the thread.
 * - **Snooze 1 h** and **Mark read**, on PR notifications. Both are local and never write to GitHub.
 *   Electron shows action buttons on macOS only; in-app toasts show them everywhere.
 */
import type { NotificationDelivery, NotificationKind } from './notification-routing';
import type { NotificationEventType } from './notification-settings';

export type QuickAction = 'snooze' | 'read';
export const QUICK_ACTIONS: readonly QuickAction[] = ['snooze', 'read'];
export const QUICK_ACTION_LABELS: Record<QuickAction, string> = { snooze: 'Snooze 1 h', read: 'Mark read' };
export const QUICK_SNOOZE_MS = 60 * 60_000;
/** Events with a thread to answer. Not checks, approvals, merge-ready, snooze or update notifications. */
export const REPLY_TYPES: readonly NotificationEventType[] = ['mention', 'reply', 'changes-requested'];
export const replyPlaceholder = (to: string) => `Reply to ${to}…`;
/** Platforms where Electron raises the notification `reply` event. */
const REPLY_PLATFORMS = ['darwin'];
const ACTION_PLATFORMS = ['darwin'];

/** Whether a notification can be answered from where it is shown, given the setting. */
export function offersReply(delivery: Pick<NotificationDelivery, 'kind' | 'reply'>, allowReplies: boolean): boolean {
  return allowReplies && !!delivery.reply?.to && REPLY_TYPES.includes(delivery.kind as NotificationEventType);
}
/** The local actions a PR notification offers. Summaries, tests and local results offer none. */
export function quickActions(delivery: Pick<NotificationDelivery, 'kind' | 'url'>): QuickAction[] {
  const kind: NotificationKind = delivery.kind;
  if (!delivery.url || kind === 'summary' || kind === 'test' || kind === 'update-ready' || kind === 'explanation-ready') return [];
  return [...QUICK_ACTIONS];
}

/** The Electron options a desktop notification adds to title, subtitle and body. Additive: nothing here replaces them. */
export interface DesktopExtras {
  icon?: string;
  hasReply?: boolean;
  replyPlaceholder?: string;
  actions?: { type: 'button'; text: string }[];
}
export function desktopExtras(
  delivery: Pick<NotificationDelivery, 'kind' | 'url' | 'reply'>,
  options: { platform?: string; allowReplies: boolean; icon?: string }
): { extras: DesktopExtras; actions: QuickAction[] } {
  const platform = options.platform ?? '';
  const extras: DesktopExtras = {};
  // macOS always shows the app icon; elsewhere the event icon tells notifications apart.
  if (options.icon && platform !== 'darwin') extras.icon = options.icon;
  if (REPLY_PLATFORMS.includes(platform) && offersReply(delivery, options.allowReplies) && delivery.reply) {
    extras.hasReply = true;
    extras.replyPlaceholder = replyPlaceholder(delivery.reply.to);
  }
  const actions = ACTION_PLATFORMS.includes(platform) ? quickActions(delivery) : [];
  if (actions.length) extras.actions = actions.map((action) => ({ type: 'button', text: QUICK_ACTION_LABELS[action] }));
  return { extras, actions };
}

/** The main action of a toast. A notification with a thread says "Open thread". It never writes to GitHub. */
export function notificationActionLabel(delivery: Pick<NotificationDelivery, 'kind' | 'target'>): string {
  if (delivery.kind === 'summary') return delivery.target?.kind === 'queue' && delivery.target.filters?.prs ? 'Show these PRs' : 'Show unread PRs';
  if (delivery.target?.kind === 'review') return 'Open explanation';
  if (delivery.target?.kind === 'pr' && delivery.target.tab === 'checks') return 'Open checks';
  if (delivery.target?.kind === 'pr' && delivery.target.threadId) return 'Open thread';
  if (delivery.target?.kind === 'pr' && delivery.target.tab === 'feedback') return 'Open feedback';
  if (delivery.target?.kind === 'pr' && delivery.target.focus === 'unviewed-file') return 'Start review';
  if (delivery.target?.kind === 'pr' && delivery.target.focus === 'merge') return 'Open merge';
  return 'Open PR';
}
