import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import type { NotificationEventType, RepositoryNotificationLevel, SavedNotificationPreferences } from '../lib/notification-settings';
import {
  normalizeBotLogins,
  normalizeNotificationPreferences,
  isPaused,
  PAUSE_CHOICES,
  PAUSE_LABELS,
  REPOSITORY_NOTIFICATION_LABEL,
  REPOSITORY_NOTIFICATION_LEVELS,
  type PauseChoice,
} from '../lib/notification-settings';
import { normalizeRepositorySettings, repositoryKey, type RepositorySettingsMap } from '../lib/repository-settings';
import { SearchableSelect } from './SearchableSelect';
import { RepositoryMark } from './RepositoryAppearance';
import { notificationMissedHint, notificationSettingsLabel } from '../lib/desktop-setup';
import { useSystemSettingsPanes } from './DesktopSetup';

/** "09:00", or "Mon 08:00" when the pause ends on another day. */
function pausedUntilText(until: number, now: number): string {
  const end = new Date(until);
  const time = end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return end.toDateString() === new Date(now).toDateString() ? time : `${end.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/** Settings › Notifications. Every switch has a visible label; state is never shown by colour alone. */
export function NotificationSettings({
  desktop,
  value,
  onDesktopChange,
  onChange,
  Row,
  Toggle,
  onDesktopSetup,
  repositorySettings = {},
  watchedRepos = [],
  onRepositorySettingsChange,
}: {
  desktop: boolean;
  value: SavedNotificationPreferences;
  /** Per-repository levels live in the repository settings. */
  repositorySettings?: RepositorySettingsMap;
  watchedRepos?: string[];
  onRepositorySettingsChange?: (next: RepositorySettingsMap) => void;
  onDesktopChange: (next: boolean) => void;
  onChange: (next: SavedNotificationPreferences) => void;
  Row: (props: { label: string; description?: string; children: React.ReactNode }) => React.ReactNode;
  Toggle: (props: { checked: boolean; onChange: () => void; ariaLabel?: string }) => React.ReactNode;
  /** Opens the notifications and menu bar setup steps on their own. */
  onDesktopSetup?: () => void;
}) {
  const platform = window.electronAPI.platform;
  const panes = useSystemSettingsPanes();
  const [sentToDesktop, setSentToDesktop] = useState(false);
  const [openError, setOpenError] = useState('');
  const openSettings = () => {
    setOpenError('');
    void window.electronAPI
      .openSystemSettings('notifications')
      .then((opened) => {
        if (!opened) setOpenError('Could not open notification settings. Open them from your system settings.');
      })
      .catch(() => setOpenError('Could not open notification settings. Open them from your system settings.'));
  };
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
  const [botDraft, setBotDraft] = useState('');
  const [botError, setBotError] = useState('');
  const levelOptions = REPOSITORY_NOTIFICATION_LEVELS.map((level) => ({ value: level, label: REPOSITORY_NOTIFICATION_LABEL[level] }));
  const exceptions = Object.entries(repositorySettings)
    .flatMap(([repo, settings]) => (settings.notifications ? [[repo, settings.notifications] as const] : []))
    .sort(([a], [b]) => a.localeCompare(b));
  const setLevel = (repo: string, level: RepositoryNotificationLevel | undefined) => {
    const key = repositoryKey(repo);
    onRepositorySettingsChange?.(normalizeRepositorySettings({ ...repositorySettings, [key]: { ...repositorySettings[key], notifications: level } }));
  };
  const addBot = () => {
    const [login] = normalizeBotLogins([botDraft]);
    if (!login) {
      setBotError('Enter a GitHub login, such as coderabbitai[bot].');
      return;
    }
    setBotError('');
    setBotDraft('');
    onChange({ ...value, allowedBots: normalizeBotLogins([...value.allowedBots, login]) });
  };
  const pause = async (next: PauseChoice | false) => {
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
        {panes.notifications && (
          <Button type="button" variant="outline" size="sm" className="self-start" onClick={openSettings}>
            {notificationSettingsLabel(platform)}
          </Button>
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
              setSentToDesktop(false);
              void window.electronAPI.sendTestNotification().then(
                (result) => {
                  setSentToDesktop(result === 'desktop');
                  setTestResult(result === 'desktop' ? 'Sent a test notification to your desktop.' : result === 'toast' ? 'Desktop notifications are off, so the test appears in Gnosis.' : 'No notification could be shown.');
                },
                () => setTestResult('Could not send a test notification.')
              );
            }}
          >
            Send test notification
          </Button>
          {testResult && <span className="settings-description" role="status">{testResult}</span>}
        </div>
        {sentToDesktop && (
          <p className="settings-description notification-settings-missed">
            {notificationMissedHint(platform)}{' '}
            {panes.notifications && (
              <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={openSettings}>
                Open notification settings
              </Button>
            )}
          </p>
        )}
        {openError && <p className="settings-description" role="alert">{openError}</p>}
        {onDesktopSetup && (
          <Button type="button" variant="link" size="sm" className="self-start h-auto p-0" onClick={onDesktopSetup}>
            {platform === 'darwin' ? 'Set up notifications and menu bar…' : 'Set up notifications…'}
          </Button>
        )}
      </section>
      <section className="settings-group" aria-labelledby="notifications-reviews-title">
        <h2 id="notifications-reviews-title">Reviews you owe</h2>
        {event('review-requested', 'Review requested from you')}
        {event('team-review-requested', 'Requested from your team', 'Teams such as CODEOWNERS can request you often.')}
        {event('mention', 'Mentions', 'Someone @mentioned you in a comment or review.')}
        {event('reply', 'Replies to you', 'A new comment in a thread you are in, or on your PR.')}
      </section>
      <section className="settings-group" aria-labelledby="notifications-own-title">
        <h2 id="notifications-own-title">Your PRs</h2>
        {event('changes-requested', 'Changes requested')}
        {event('approved', 'Approved')}
        {event('checks-failed', 'Checks failed')}
        {event('ready-to-merge', 'Ready to merge')}
      </section>
      <section className="settings-group" aria-labelledby="notifications-conversation-title">
        <h2 id="notifications-conversation-title">Replies</h2>
        <Row
          label="Allow replies from notifications"
          description={platform === 'darwin'
            ? 'Answer mentions, replies and change requests from the notification. The reply posts to that thread on GitHub.'
            : 'On this system, the notification opens the thread so you can reply there.'}
        >
          <Toggle checked={value.allowReplies} ariaLabel="Allow replies from notifications" onChange={() => onChange({ ...value, allowReplies: !value.allowReplies })} />
        </Row>
      </section>
      <section className="settings-group" aria-labelledby="notifications-snooze-title">
        <h2 id="notifications-snooze-title">Snoozed PRs</h2>
        {event('snooze-ended', 'A snoozed PR is back', 'Only when no other notification says why.')}
      </section>
      <section className="settings-group" aria-labelledby="notifications-gnosis-title">
        <h2 id="notifications-gnosis-title">Gnosis</h2>
        {event('explanation-ready', 'Explanation ready')}
        {event('update-ready', 'Update ready')}
      </section>
      <section className="settings-group" aria-labelledby="notifications-repositories-title">
        <div>
          <h2 id="notifications-repositories-title">Repositories</h2>
          <p className="settings-description">
            A repository can get all notifications, only those where the next move is yours, or none. The switches above still apply everywhere.
          </p>
        </div>
        <Row label="Other repositories" description="Repositories you don’t watch and haven’t given a level. Watched repositories get All.">
          <SearchableSelect
            label="Other repositories"
            value={value.otherRepositories}
            options={levelOptions}
            onValueChange={(next) => onChange({ ...value, otherRepositories: next as RepositoryNotificationLevel })}
          />
        </Row>
        <div className="notification-exceptions" role="group" aria-labelledby="notifications-exceptions-title">
          <h3 id="notifications-exceptions-title" className="text-sm font-medium">Repository exceptions</h3>
          {exceptions.length ? (
            <ul className="notification-exception-list">
              {exceptions.map(([repo, level]) => (
                <li key={repo} className="notification-exception">
                  <span className="font-mono text-xs"><RepositoryMark repo={repo} settings={repositorySettings[repo]} /></span>
                  <SearchableSelect
                    label={`Notifications from ${repo}`}
                    value={level}
                    options={levelOptions}
                    onValueChange={(next) => setLevel(repo, next as RepositoryNotificationLevel)}
                  />
                  <Button type="button" variant="ghost" size="sm" aria-label={`Remove the exception for ${repo}`} onClick={() => setLevel(repo, undefined)}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="settings-description">
              No exceptions. Set one from a PR’s menu or in Settings › Repositories.
              {watchedRepos.length ? '' : ' You don’t watch any repositories yet.'}
            </p>
          )}
        </div>
      </section>
      <section className="settings-group" aria-labelledby="notifications-bots-title">
        <div>
          <h2 id="notifications-bots-title">Bots</h2>
          <p className="settings-description">Bots never notify, as they never mark PRs unread. Add the ones you want to hear from.</p>
        </div>
        <div className="notification-bots" role="group" aria-labelledby="notifications-bots-list-title">
          <h3 id="notifications-bots-list-title" className="text-sm font-medium">Also notify for these bots</h3>
          {value.allowedBots.length > 0 && (
            <ul className="notification-exception-list">
              {value.allowedBots.map((login) => (
                <li key={login} className="notification-exception">
                  <span className="font-mono text-xs">{login}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Stop notifications from ${login}`}
                    onClick={() => onChange({ ...value, allowedBots: value.allowedBots.filter((bot) => bot !== login) })}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="notification-bot-add"
            onSubmit={(e) => {
              e.preventDefault();
              addBot();
            }}
          >
            <input
              aria-label="Bot login"
              placeholder="coderabbitai[bot]"
              value={botDraft}
              aria-invalid={!!botError}
              onChange={(e) => setBotDraft(e.target.value)}
            />
            <Button type="submit" variant="outline" size="sm" disabled={!botDraft.trim()}>
              Add bot
            </Button>
          </form>
          {botError && <p className="settings-description" role="alert">{botError}</p>}
        </div>
      </section>
      <section className="settings-group" aria-labelledby="notifications-quiet-title">
        <h2 id="notifications-quiet-title">Quiet</h2>
        <Row
          label={paused ? `Paused until ${pausedUntilText(value.pausedUntil, now)}` : 'Pause notifications'}
          description="Gnosis also follows your system Focus and Do Not Disturb. Paused updates still mark PRs unread, and one summary follows the pause."
        >
          {paused ? (
            <Button type="button" variant="outline" size="sm" onClick={() => void pause(false)}>
              Resume
            </Button>
          ) : (
            <div className="notification-pause-choices">
              {PAUSE_CHOICES.map((choice) => (
                <Button key={choice} type="button" variant="outline" size="sm" onClick={() => void pause(choice)}>
                  {PAUSE_LABELS[choice]}
                </Button>
              ))}
            </div>
          )}
        </Row>
      </section>
    </>
  );
}
