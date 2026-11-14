import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import type { UpdateInfo } from '../lib/types';
import { updateBannerView, type AppUpdateStatus } from '../src/update-state';

const supportsAutoUpdate = window.electronAPI.platform !== 'linux' && window.electronAPI.isPackaged;

export function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [status, setStatus] = useState<AppUpdateStatus>({ state: 'idle' });
  const [hidden, setHidden] = useState<AppUpdateStatus | null>(null);

  useEffect(() => {
    window.electronAPI.onUpdateAvailable((info) => setUpdate(info));
    window.electronAPI.onUpdateStatus((next) => setStatus(next));
    // Squirrel often completes download before this effect mounts — replay.
    void window.electronAPI.getUpdateStatus().then((current) => {
      setStatus((prev) => (prev.state === 'idle' ? current : prev));
    });
    return () => {
      window.electronAPI.offUpdateAvailable();
      window.electronAPI.offUpdateStatus();
    };
  }, []);

  // macOS and Windows: only after the update has downloaded, or when it failed.
  const view = hidden === status ? null : updateBannerView(status, window.electronAPI.platform);
  if (view) {
    const dismiss = (
      <button onClick={() => setHidden(status)} className="shrink-0 transition-opacity hover:opacity-80" aria-label="Dismiss">
        <X className="h-3 w-3" />
      </button>
    );
    return (
      <div className="updateBanner flex items-center justify-between gap-3 px-6 py-1.5 text-xs" role="status" data-update-state={view.kind}>
        {view.kind === 'failed' ? (
          <div className="flex items-center gap-3">
            <span>{view.message}</span>
            <button
              onClick={() => void window.electronAPI.openExternal(view.releaseUrl)}
              className="updateBanner-btn shrink-0 px-2 py-0.5 rounded-sm text-xs transition-colors"
            >
              Download from GitHub
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span>
              Gnosis <strong className="font-semibold">v{view.version}</strong>{' '}
              {view.kind === 'installing' ? 'is installing. Gnosis will reopen when it is done.' : 'is ready to install.'}
            </span>
            {view.kind === 'ready' && (
              <button
                onClick={() => void window.electronAPI.installUpdate().then(setStatus)}
                className="updateBanner-btn shrink-0 px-2 py-0.5 rounded-sm text-xs transition-colors"
              >
                Restart now
              </button>
            )}
          </div>
        )}
        {view.kind !== 'installing' && dismiss}
      </div>
    );
  }

  // Linux: show banner when a new version is available for manual download
  if (!update || supportsAutoUpdate) return null;

  const { version, releaseUrl } = update;

  function handleDismiss() {
    void window.electronAPI.dismissUpdate(version);
    setUpdate(null);
  }

  return (
    <div className="updateBanner flex items-center justify-between gap-3 px-6 py-1.5 text-xs">
      <div className="flex items-center gap-3">
        <span>
          Gnosis <strong className="font-semibold">v{version}</strong> is available
        </span>
        <button
          onClick={() => void window.electronAPI.openExternal(releaseUrl)}
          className="updateBanner-btn px-2 py-0.5 rounded-sm text-xs transition-colors"
        >
          Download
        </button>
      </div>
      <button onClick={handleDismiss} className="shrink-0 transition-opacity hover:opacity-80" aria-label="Dismiss">
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
