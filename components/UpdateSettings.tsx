import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import type { UpdateChannelInfo } from '../lib/types';
import { isPrereleaseVersion } from '../lib/version';
import {
  UPDATE_CHANNEL_DESCRIPTION,
  UPDATE_CHANNEL_LABEL,
  stableChannelNote,
  type UpdateChannel,
} from '../lib/update-channel';

const CHANNELS: UpdateChannel[] = ['stable', 'prerelease'];

function checkedAt(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Settings › Updates (#404): the running build, the update channel and Check now. */
export function UpdateSettings() {
  const api = window.electronAPI;
  const [info, setInfo] = useState<UpdateChannelInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // A downloaded update installs when Gnosis quits, whatever the channel says now.
  const [downloaded, setDownloaded] = useState<string | null>(null);
  const readDownloaded = () =>
    void api
      .getUpdateStatus()
      .then((status) => setDownloaded(status.state === 'ready' ? status.version : null))
      .catch(() => {});

  useEffect(() => {
    let active = true;
    void api
      .getUpdateChannel()
      .then((next) => {
        if (active) setInfo(next);
      })
      .catch(() => {
        if (active) setError('Could not read the update settings. Close Settings and try again.');
      });
    readDownloaded();
    const off = api.onUpdateChannelChanged((next) => {
      setInfo(next);
      readDownloaded();
    });
    return () => {
      active = false;
      off();
    };
  }, [api]);

  async function act(run: () => Promise<UpdateChannelInfo>, failure: string) {
    setBusy(true);
    setError('');
    try {
      setInfo(await run());
      readDownloaded();
    } catch {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  if (!info) {
    return error ? (
      <p role="alert" className="text-sm text-[var(--color-danger)]">
        {error}
      </p>
    ) : null;
  }

  const note = info.channel === 'stable' ? stableChannelNote(info.version) : null;
  const last = info.lastCheck;
  const checking = busy || last?.outcome === 'checking';
  return (
    <div className="update-settings">
      <section className="diagnostics-section" aria-labelledby="update-version-title">
        <h3 id="update-version-title" className="text-sm font-medium">
          This version
        </h3>
        <p className="update-version" data-testid="update-version">
          <span className="numeric">Gnosis v{info.version}</span>
          {info.prerelease && <span className="update-version-tag">Pre-release</span>}
        </p>
      </section>

      <section className="diagnostics-section" aria-labelledby="update-channel-title">
        <h3 id="update-channel-title" className="text-sm font-medium">
          Update channel
        </h3>
        <fieldset className="update-channel-options" aria-labelledby="update-channel-title" disabled={busy}>
          {CHANNELS.map((channel) => (
            <label key={channel}>
              <input
                type="radio"
                name="update-channel"
                value={channel}
                checked={info.channel === channel}
                onChange={() =>
                  void act(() => api.setUpdateChannel(channel), 'Could not change the update channel. Try again.')
                }
              />
              <span>
                <strong>{UPDATE_CHANNEL_LABEL[channel]}</strong>
                <small>{UPDATE_CHANNEL_DESCRIPTION[channel]}</small>
              </span>
            </label>
          ))}
        </fieldset>
        {note && (
          <p className="settings-description update-channel-note" data-testid="update-channel-note">
            {note}
          </p>
        )}
        {info.channel === 'stable' && downloaded && isPrereleaseVersion(downloaded) && (
          <p className="settings-description update-channel-note" data-testid="update-downloaded-note">
            Pre-release v{downloaded} has already downloaded. It installs when Gnosis restarts or quits.
          </p>
        )}
        {!info.autoUpdate && (
          <p className="settings-description">
            This copy of Gnosis does not install updates itself. Gnosis shows a download link when a newer build is out.
          </p>
        )}
      </section>

      <section className="diagnostics-section" aria-labelledby="update-check-title">
        <h3 id="update-check-title" className="text-sm font-medium">
          Updates
        </h3>
        {last && (
          <p className="settings-description" role="status" data-testid="update-check-result" data-outcome={last.outcome}>
            {last.message} <span className="update-check-time">Checked {checkedAt(last.at)}.</span>
          </p>
        )}
        <div className="update-check-actions">
          <Button
            size="sm"
            variant="outline"
            disabled={checking}
            onClick={() => void act(() => api.checkForUpdateNow(), 'Could not check for updates. Check your connection and try again.')}
          >
            {checking ? 'Checking…' : 'Check now'}
          </Button>
          {last?.outcome === 'available' && last.releaseUrl && (
            <Button size="sm" variant="ghost" onClick={() => last.releaseUrl && void api.openExternal(last.releaseUrl)}>
              Download from GitHub
            </Button>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-[var(--color-danger)]">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
