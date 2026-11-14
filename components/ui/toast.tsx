import { useSyncExternalStore } from 'react';
import { Toast } from '@base-ui/react/toast';
import { CheckCircle2, Info, AlertCircle, X, GitPullRequest, MessageSquareWarning, CircleX, GitMerge, Sparkles, Inbox, BellRing, type LucideIcon } from 'lucide-react';
import type { NotificationKind } from '../../lib/notification-routing';

/** Notification toasts carry their kind, so status has an icon as well as a title. Colour stays secondary. */
export interface ToastData {
  kind?: NotificationKind;
  /** `owner/repo #123`. */
  subtitle?: string;
  /** The first PR-event toast offers desktop delivery. */
  introduce?: (accept: boolean) => void;
  onDismiss?: () => void;
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

const KIND_ICONS: Partial<Record<NotificationKind, LucideIcon>> = {
  'review-requested': GitPullRequest,
  'team-review-requested': GitPullRequest,
  'changes-requested': MessageSquareWarning,
  'checks-failed': CircleX,
  'ready-to-merge': GitMerge,
  approved: CheckCircle2,
  'explanation-ready': Sparkles,
  'update-ready': Info,
  summary: Inbox,
  test: BellRing,
};
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
        role="group"
        aria-roledescription="notification"
        aria-modal={undefined}
      >
        <Toast.Content className="app-toast-content">
          <Icon className="app-toast-icon" size={17} aria-hidden="true" />
          <div className="app-toast-copy">
            <Toast.Title className="app-toast-title" />
            {item.data?.subtitle && <p className="app-toast-subtitle">{item.data.subtitle}</p>}
            <Toast.Description className="app-toast-description" />
            <Toast.Action className="app-toast-action" />
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
