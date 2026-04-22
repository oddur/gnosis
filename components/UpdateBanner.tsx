import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import type { UpdateInfo } from '../lib/types';

const supportsAutoUpdate = window.electronAPI.platform !== 'linux' && window.electronAPI.isPackaged;

export function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [readyVersion, setReadyVersion] = useState<string | null>(null);

  useEffect(() => {
    window.electronAPI.onUpdateAvailable((info) => setUpdate(info));
    window.electronAPI.onUpdateReady((version) => setReadyVersion(version));
    // Squirrel often completes download before this effect mounts — replay.
    void window.electronAPI.getPendingUpdateReady().then((v) => {
      if (v) setReadyVersion((prev) => prev ?? v);
    });
    return () => {
      window.electronAPI.offUpdateAvailable();
      window.electronAPI.offUpdateReady();
    };
  }, []);

  // Show "ready to install" on macOS/Windows. In dev, GNOSIS_FAKE_UPDATE_READY
  // forces readyVersion so the banner can be tested without a packaged build.
  if (window.electronAPI.platform !== 'linux' && readyVersion !== null) {
    return (
      <div className="updateBanner flex items-center justify-between gap-3 px-6 py-1.5 text-xs">
        <span>
          Gnosis <strong className="font-semibold">v{readyVersion}</strong> will install on next restart
        </span>
        <button onClick={() => setReadyVersion(null)} className="shrink-0 transition-opacity hover:opacity-80" aria-label="Dismiss">
          <X className="h-3 w-3" />
        </button>
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
