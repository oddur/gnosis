import { Toast } from '@base-ui/react/toast';
import { CheckCircle2, Info, AlertCircle, X } from 'lucide-react';

// Shadcn's Base UI toast pattern, styled with the workbench's existing tokens.
export const toast = Toast.createToastManager();

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
  return (
    <Toast.Provider toastManager={toast} timeout={10000} limit={3}>
      <Toast.Portal>
        <Toast.Viewport className="app-toasts" aria-label="Notifications">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
