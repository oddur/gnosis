import { useEffect } from 'react';
import { toast } from '../components/ui/toast';
import type { DeepLinkTarget } from './deep-link';
import { UNREAD_TARGET, type NotificationDelivery, type NotificationKind } from './notification-routing';

/** The one action a notification toast offers. It never writes to GitHub. */
export function notificationActionLabel(delivery: Pick<NotificationDelivery, 'kind' | 'target'>): string {
  if (delivery.kind === 'summary') return 'Show unread PRs';
  if (delivery.target?.kind === 'review') return 'Open explanation';
  if (delivery.target?.kind === 'pr' && delivery.target.tab === 'checks') return 'Open checks';
  if (delivery.target?.kind === 'pr' && delivery.target.tab === 'feedback') return 'Open feedback';
  return 'Open PR';
}
const NORMAL_TIMEOUT = 10_000;
/** More than this many notification toasts at once become one digest. */
const VISIBLE_LIMIT = 3;

/**
 * Shows the notifications main routes to this window as toasts. A toast raised while the window is unfocused
 * waits (no timeout) and gets the normal 10 seconds once the user returns. Marking a PR read closes its toasts.
 */
export function useNotificationToasts(open: (target: DeepLinkTarget) => Promise<void>) {
  useEffect(() => {
    const api = window.electronAPI;
    if (!api.onNotification) return;
    const byUrl = new Map<string, Set<string>>();
    const waiting = new Set<string>();
    const visible = new Set<string>();
    let overflow: { id: string; count: number } | undefined;
    const report = (kind: NotificationKind, action: 'clicked' | 'dismissed' | 'timedOut') => api.notificationAction?.(kind, action);
    const run = (target: DeepLinkTarget, id: string) => {
      toast.close(id);
      void open(target).catch((error: unknown) =>
        toast.add({ type: 'error', title: 'Could not open this notification', description: error instanceof Error ? error.message : String(error) })
      );
    };
    function show(delivery: NotificationDelivery) {
      const focused = document.hasFocus();
      if (visible.size >= VISIBLE_LIMIT && delivery.kind !== 'test') {
        // The same digest rule as desktop: one toast for the rest.
        if (overflow && visible.has(overflow.id)) {
          overflow.count++;
          toast.update(overflow.id, { title: `${overflow.count} more updates` });
          return;
        }
      }
      const kind: NotificationKind = visible.size >= VISIBLE_LIMIT && delivery.kind !== 'test' ? 'summary' : delivery.kind;
      const target = kind === 'summary' && delivery.kind !== 'summary' ? UNREAD_TARGET : delivery.target;
      let handled = false;
      const id: string = toast.add({
        title: kind === 'summary' && delivery.kind !== 'summary' ? '1 more update' : delivery.title,
        description: kind === 'summary' && delivery.kind !== 'summary' ? undefined : delivery.body,
        timeout: focused ? NORMAL_TIMEOUT : 0,
        data: {
          kind,
          subtitle: kind === delivery.kind ? delivery.subtitle : undefined,
          introduce: delivery.introduce
            ? (accept) => {
                void api.notificationIntroduce(accept).catch(() => {});
                toast.update(id, { data: { kind, subtitle: delivery.subtitle, onDismiss } });
              }
            : undefined,
          onDismiss,
        },
        actionProps: target
          ? { children: notificationActionLabel({ kind, target }), onClick: () => { handled = true; report(kind, 'clicked'); run(target, id); } }
          : undefined,
        onRemove: () => {
          if (!handled) report(kind, 'timedOut');
          visible.delete(id);
          waiting.delete(id);
          if (overflow?.id === id) overflow = undefined;
          for (const ids of byUrl.values()) ids.delete(id);
        },
      });
      function onDismiss() {
        handled = true;
        report(kind, 'dismissed');
      }
      if (kind === 'summary' && delivery.kind !== 'summary') overflow = { id, count: 1 };
      visible.add(id);
      if (!focused) waiting.add(id);
      if (delivery.url) byUrl.set(delivery.url, new Set([...(byUrl.get(delivery.url) ?? []), id]));
    }
    const stop = api.onNotification((message) => {
      if (message.type === 'show') show(message.delivery);
      else for (const url of message.urls) for (const id of byUrl.get(url) ?? []) toast.close(id);
    });
    const focus = () => {
      for (const id of waiting) toast.update(id, { timeout: NORMAL_TIMEOUT });
      waiting.clear();
    };
    window.addEventListener('focus', focus);
    return () => {
      if (typeof stop === 'function') stop();
      window.removeEventListener('focus', focus);
    };
  }, [open]);
}
