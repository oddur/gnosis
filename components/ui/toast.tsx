import { useSyncExternalStore } from 'react';
import { Toast } from '@base-ui/react/toast';
import { CheckCircle2, Info, AlertCircle, X } from 'lucide-react';

// Shadcn's Base UI toast pattern, styled with the workbench's existing tokens.
export const toast = Toast.createToastManager();

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

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((item) => {
    const Icon = item.type === 'success' ? CheckCircle2 : item.type === 'error' ? AlertCircle : Info;
    return (
      <Toast.Root key={item.id} toast={item} className="app-toast" data-slot="toast">
        <Toast.Content className="app-toast-content">
          <Icon className="app-toast-icon" size={17} aria-hidden="true" />
          <div className="app-toast-copy">
            <Toast.Title className="app-toast-title" />
            <Toast.Description className="app-toast-description" />
            <Toast.Action className="app-toast-action" />
          </div>
          <Toast.Close className="workbench-icon" aria-label="Dismiss notification">
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
