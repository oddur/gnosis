import { useSyncExternalStore } from 'react';
import { Toast } from '@base-ui/react/toast';
import { CheckCircle2, Info, AlertCircle, X, GitPullRequest, MessageSquareWarning, CircleX, GitMerge, Sparkles, Inbox, BellRing, AlarmClock, AtSign, MessageSquareReply, GitCompareArrows, type LucideIcon } from 'lucide-react';
import type { NotificationKind } from '../../lib/notification-routing';
import { NOTIFICATION_ICONS, type NotificationIconName } from '../../lib/notification-icons';
import { PrStateIcon } from '../PrStateIcon';

/** Notification toasts carry their kind, so status has an icon as well as a title. Colour stays secondary. */
export interface ToastData {
  kind?: NotificationKind;
  /** `owner/repo #123`. */
  subtitle?: string;
  /** The PR the subtitle names, so it shows that PR's state icon. */
  prUrl?: string;
  /** The first PR-event toast offers desktop delivery. */
  introduce?: (accept: boolean) => void;
  onDismiss?: () => void;
  /** Secondary actions, such as "Snooze 1 h" and "Mark read". */
  actions?: { label: string; onClick: () => void }[];
}
// Shadcn's Base UI toast pattern, styled with the workbench's existing tokens.
export const toast = Toast.createToastManager<ToastData>();

// A focused workspace can reserve space for notifications inside its modal boundary.
// Keep the manager global so pending notifications survive mounting/unmounting a host.
const hosts: HTMLElement[] = [];
const hostListeners = new Set<() => void>();
const subscribeHost = (listener: () => void) => {
  hostListeners.add(listener);
  return () => {
    hostListeners.delete(listener);
  };
};
const currentHost = () => hosts.at(-1);
function registerHost(element: HTMLDivElement | null) {
  if (!element) return;
  hosts.push(element);
  hostListeners.forEach((listener) => listener());
  return () => {
    const index = hosts.indexOf(element);
    if (index >= 0) hosts.splice(index, 1);
    hostListeners.forEach((listener) => listener());
  };
}
export function ToastHost() {
  return <div ref={registerHost} className="app-toast-host" />;
}

/** The same glyphs as the desktop icons on Windows and Linux (lib/notification-icons.ts). */
const GLYPHS: Record<NotificationIconName, LucideIcon> = {
  'git-pull-request': GitPullRequest,
  'git-compare-arrows': GitCompareArrows,
  'message-square-warning': MessageSquareWarning,
  'circle-check': CheckCircle2,
  'circle-x': CircleX,
  'git-merge': GitMerge,
  'at-sign': AtSign,
  'message-square-reply': MessageSquareReply,
  'alarm-clock': AlarmClock,
  sparkles: Sparkles,
  info: Info,
  inbox: Inbox,
  'bell-ring': BellRing,
};
const KIND_ICONS = Object.fromEntries(Object.entries(NOTIFICATION_ICONS).map(([kind, { icon }]) => [kind, GLYPHS[icon]])) as Record<NotificationKind, LucideIcon>;
function ToastList() {
  const { toasts } = Toast.useToastManager<ToastData>();
  return toasts.map((item) => {
    const kind = item.data?.kind;
    const Icon = (kind && KIND_ICONS[kind]) ?? (item.type === 'success' ? CheckCircle2 : item.type === 'error' ? AlertCircle : Info);
    const introduce = item.data?.introduce;
    return (
      // Not a dialog: a toast is a grouped, non-modal notification. The viewport's live region announces it.
      <Toast.Root
        key={item.id}
        toast={item}
        className="app-toast"
        data-slot="toast"
        data-kind={kind}
        data-tone={kind ? NOTIFICATION_ICONS[kind].tone : undefined}
        role="group"
        aria-roledescription="notification"
        aria-modal={undefined}
      >
        <Toast.Content className="app-toast-content">
          <Icon className="app-toast-icon" size={17} aria-hidden="true" />
          <div className="app-toast-copy">
            <Toast.Title className="app-toast-title" />
            {item.data?.subtitle && (
              <p className="app-toast-subtitle">
                {item.data.prUrl && <PrStateIcon pr={{ url: item.data.prUrl }} size={12} />}
                {item.data.subtitle}
              </p>
            )}
            <Toast.Description className="app-toast-description" />
            {item.data?.actions?.length ? (
              <div className="app-toast-actions">
                <Toast.Action className="app-toast-action" />
                {item.data.actions.map((action) => (
                  <button key={action.label} type="button" className="app-toast-secondary" onClick={action.onClick}>
                    {action.label}
                  </button>
                ))}
              </div>
            ) : (
              <Toast.Action className="app-toast-action" />
            )}
            {introduce && (
              <div className="app-toast-introduce">
                <p>Get these on your desktop when Gnosis is in the background?</p>
                <div className="app-toast-introduce-actions">
                  <button type="button" className="app-toast-action" onClick={() => introduce(true)}>
                    Turn on
                  </button>
                  <button type="button" className="app-toast-secondary" onClick={() => introduce(false)}>
                    Not now
                  </button>
                </div>
              </div>
            )}
          </div>
          <Toast.Close className="workbench-icon" aria-label="Dismiss notification" onClick={() => item.data?.onDismiss?.()}>
            <X size={15} aria-hidden="true" />
          </Toast.Close>
        </Toast.Content>
      </Toast.Root>
    );
  });
}

export function Toaster() {
  const host = useSyncExternalStore(subscribeHost, currentHost, () => undefined);
  return (
    <Toast.Provider toastManager={toast} timeout={10000} limit={3}>
      <Toast.Portal container={host}>
        <Toast.Viewport className="app-toasts" data-inline={host ? true : undefined} aria-label="Notifications">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
