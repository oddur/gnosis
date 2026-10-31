import { lazy, Suspense, useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
const Workspace = lazy(() => import('./ConflictWorkspace').then((module) => ({ default: module.ConflictWorkspace })));
export function ConflictWorkspaceHost() {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const open = (event: Event) => {
      const value = (event as CustomEvent<unknown>).detail;
      if (typeof value === 'string' && /^https:\/\/github\.com\//.test(value)) setUrl(value);
    };
    window.addEventListener('gnosis-resolve-conflicts', open);
    return () => window.removeEventListener('gnosis-resolve-conflicts', open);
  }, []);
  if (!url) return null;
  return (
    <Suspense
      fallback={
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setUrl(undefined);
          }}
        >
          <DialogContent>
            <DialogTitle>Resolve conflicts</DialogTitle>
            <DialogDescription>Opening the conflict editor…</DialogDescription>
          </DialogContent>
        </Dialog>
      }
    >
      <Workspace key={url} url={url} onClose={() => setUrl(undefined)} />
    </Suspense>
  );
}
