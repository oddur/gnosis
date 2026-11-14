import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import type { NotificationEventType, SavedNotificationPreferences } from '../lib/notification-settings';
import { normalizeNotificationPreferences, isPaused } from '../lib/notification-settings';

/** Settings › Notifications. Every switch has a visible label; state is never shown by colour alone. */
export function NotificationSettings({
  desktop,
  value,
  onDesktopChange,
  onChange,
  Row,
  Toggle,
}: {
  desktop: boolean;
  value: SavedNotificationPreferences;
  onDesktopChange: (next: boolean) => void;
  onChange: (next: SavedNotificationPreferences) => void;
  Row: (props: { label: string; description?: string; children: React.ReactNode }) => React.ReactNode;
  Toggle: (props: { checked: boolean; onChange: () => void; ariaLabel?: string }) => React.ReactNode;
}) {
  const [status, setStatus] = useState<{ supported: boolean; blocked: boolean }>();
  const [testResult, setTestResult] = useState('');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let live = true;
    void Promise.resolve()
      .then(() => window.electronAPI.notificationStatus())
      .then((next) => { if (live) setStatus(next); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  const paused = isPaused(value, now);
  useEffect(() => {
    if (!paused) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(1000, value.pausedUntil - Date.now() + 500));
    return () => clearTimeout(timer);
  }, [paused, value.pausedUntil]);
  const event = (type: NotificationEventType, label: string, description?: string) => (
    <Row key={type} label={label} description={description}>
      <Toggle
        checked={value.events[type]}
        ariaLabel={label}
        onChange={() => onChange({ ...value, events: { ...value.events, [type]: !value.events[type] } })}
      />
    </Row>
  );
  const pause = async (next: boolean) => {
    try {
      const saved = await window.electronAPI.pauseNotifications(next);
      setNow(Date.now());
      onChange(normalizeNotificationPreferences({ notificationSettings: saved }));
    } catch {
      setTestResult('Could not change the pause. Try again.');
    }
  };
  return (
    <>
      <section className="settings-group" aria-labelledby="notifications-where-title">
        <div>
          <h2 id="notifications-where-title">Notifications</h2>
          <p className="settings-description">
            Gnosis tells you once when a PR needs you. Unread PRs keep the full record. Nothing in a notification writes to GitHub.
          </p>
        </div>
        <Row label="Desktop notifications" description="When Gnosis is in the background.">
          <Toggle checked={desktop} ariaLabel="Desktop notifications" onChange={() => onDesktopChange(!desktop)} />
        </Row>
        {status && !status.supported && (
          <p className="settings-description" role="status">This system does not support desktop notifications. Gnosis shows them in the app instead.</p>
        )}
        {status?.blocked && (
          <p className="settings-description" role="status">
            Desktop notifications may be blocked. Allow them for Gnosis in your system settings.
          </p>
        )}
        <Row label="In-app notifications" description="When Gnosis is in front.">
          <Toggle checked={value.inApp} ariaLabel="In-app notifications" onChange={() => onChange({ ...value, inApp: !value.inApp })} />
        </Row>
        <div className="notification-settings-actions">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setTestResult('');
              void window.electronAPI.sendTestNotification().then(
                (result) => setTestResult(result === 'desktop' ? 'Sent a test notification to your desktop.' : result === 'toast' ? 'Desktop notifications are off, so the test appears in Gnosis.' : 'No notification could be shown.'),
                () => setTestResult('Could not send a test notification.')
              );
            }}
          >
            Send test notification
          </Button>
          {testResult && <span className="settings-description" role="status">{testResult}</span>}
        </div>
      </section>
      <section className="settings-group" aria-labelledby="notifications-reviews-title">
        <h2 id="notifications-reviews-title">Reviews you owe</h2>
        {event('review-requested', 'Review requested from you')}
        {event('team-review-requested', 'Requested from your team', 'Teams such as CODEOWNERS can request you often.')}
      </section>
      <section className="settings-group" aria-labelledby="notifications-own-title">
        <h2 id="notifications-own-title">Your PRs</h2>
        {event('changes-requested', 'Changes requested')}
        {event('approved', 'Approved')}
        {event('checks-failed', 'Checks failed')}
        {event('ready-to-merge', 'Ready to merge')}
      </section>
      <section className="settings-group" aria-labelledby="notifications-gnosis-title">
        <h2 id="notifications-gnosis-title">Gnosis</h2>
        {event('explanation-ready', 'Explanation ready')}
        {event('update-ready', 'Update ready')}
      </section>
      <section className="settings-group" aria-labelledby="notifications-quiet-title">
        <h2 id="notifications-quiet-title">Quiet</h2>
        <Row
          label={paused ? `Paused until ${new Date(value.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Pause notifications'}
          description="Gnosis also follows your system Focus and Do Not Disturb. Paused updates still mark PRs unread."
        >
          <Button type="button" variant="outline" size="sm" onClick={() => void pause(!paused)}>
            {paused ? 'Resume' : 'Pause for 1 hour'}
          </Button>
        </Row>
      </section>
    </>
  );
}
