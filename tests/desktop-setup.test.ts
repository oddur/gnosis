import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SYSTEM_SETTINGS_URLS,
  darwinMajor,
  desktopSteps,
  isSystemSettingsPane,
  isSystemSettingsUrl,
  menubarHelp,
  normalizeDesktopSetup,
  notificationHelp,
  notificationMissedHint,
  notificationSettingsLabel,
  offerDesktopSetup,
  recordDesktopOutcome,
  systemSettingsPanes,
  systemSettingsUrl,
} from '../lib/desktop-setup';
import { initialSetup, setupSteps } from '../lib/onboarding';
import { safeExternalUrl } from '../src/safe-input';
import type { Preferences } from '../lib/types';

void test('setup shows notifications after repositories, and the menu bar on macOS only', () => {
  assert.deepEqual(setupSteps(false, 'darwin'), ['goals', 'github', 'repositories', 'filters', 'notifications', 'menubar', 'ai', 'finish']);
  assert.deepEqual(setupSteps(false, 'win32'), ['goals', 'github', 'repositories', 'filters', 'notifications', 'ai', 'finish']);
  assert.deepEqual(setupSteps(false, 'linux'), ['goals', 'github', 'repositories', 'filters', 'notifications', 'ai', 'finish']);
  // Local reviews have no PR events to notify about or count.
  assert.deepEqual(setupSteps(true, 'darwin'), ['goals', 'ai', 'finish']);
  assert.deepEqual(desktopSteps('darwin'), ['notifications', 'menubar']);
  assert.deepEqual(desktopSteps('win32'), ['notifications']);
  assert.deepEqual(desktopSteps('linux'), ['notifications']);
});

void test('step outcomes record answers, never downgrade them with a skip, and re-run keeps them', () => {
  let state = recordDesktopOutcome(undefined, 'notifications', 'skipped');
  assert.deepEqual(state, { notifications: 'skipped' });
  state = recordDesktopOutcome(state, 'notifications', 'not-seen');
  state = recordDesktopOutcome(state, 'notifications', 'completed');
  assert.equal(state.notifications, 'completed');
  // A re-run that closes without answering skips nothing that was answered.
  assert.equal(recordDesktopOutcome(state, 'notifications', 'skipped').notifications, 'completed');
  state = recordDesktopOutcome(state, 'menubar', 'skipped');
  assert.deepEqual(state, { notifications: 'completed', menubar: 'skipped' });
  assert.deepEqual(normalizeDesktopSetup({ ...state, prompt: 'dismissed', extra: 1, menubar: 'maybe' }), {
    notifications: 'completed',
    prompt: 'dismissed',
  });
  assert.equal(normalizeDesktopSetup(null), undefined);
  assert.equal(normalizeDesktopSetup({ notifications: 'yes' }), undefined);
});

void test('existing users get the prompt once; new setups and local or signed-out users do not', () => {
  const existing = { firstRunSeen: true, guestMode: false, signedIn: true };
  assert.equal(offerDesktopSetup({ ...existing, state: { completed: true } as never }), true);
  assert.equal(offerDesktopSetup({ ...existing, state: undefined }), true, 'users from before setup existed');
  assert.equal(offerDesktopSetup({ ...existing, state: { desktop: { prompt: 'dismissed' } } }), false);
  assert.equal(offerDesktopSetup({ ...existing, state: { desktop: { prompt: 'started' } } }), false);
  assert.equal(offerDesktopSetup({ ...existing, state: { desktop: { notifications: 'skipped' } } }), false);
  assert.equal(offerDesktopSetup({ ...existing, state: { desktop: { menubar: 'completed' } } }), false);
  assert.equal(offerDesktopSetup({ ...existing, firstRunSeen: false, state: undefined }), false, 'still in first setup');
  assert.equal(offerDesktopSetup({ ...existing, guestMode: true, state: undefined }), false);
  assert.equal(offerDesktopSetup({ ...existing, signedIn: false, state: undefined }), false);
});

void test('System Settings URLs: the right pane per system, exact allow-list only', () => {
  assert.equal(systemSettingsUrl('notifications', 'darwin', '25.5.0'), 'x-apple.systempreferences:com.apple.Notifications-Settings.extension');
  assert.equal(systemSettingsUrl('notifications', 'darwin', '22.1.0'), SYSTEM_SETTINGS_URLS.macNotifications);
  assert.equal(systemSettingsUrl('notifications', 'darwin', '21.6.0'), 'x-apple.systempreferences:com.apple.preference.notifications');
  assert.equal(systemSettingsUrl('menubar', 'darwin', '25.0.0'), 'x-apple.systempreferences:com.apple.ControlCenter-Settings.extension');
  assert.equal(systemSettingsUrl('menubar', 'darwin', '24.6.0'), null, 'no per-app menu bar setting before macOS 26');
  assert.equal(systemSettingsUrl('notifications', 'win32', '10.0.26100'), 'ms-settings:notifications');
  assert.equal(systemSettingsUrl('menubar', 'win32', '10.0.26100'), null);
  assert.equal(systemSettingsUrl('notifications', 'linux', '6.8.0'), null);
  assert.deepEqual(systemSettingsPanes('darwin', '25.5.0'), { notifications: true, menubar: true });
  assert.deepEqual(systemSettingsPanes('darwin', '23.0.0'), { notifications: true, menubar: false });
  assert.deepEqual(systemSettingsPanes('win32', '10.0'), { notifications: true, menubar: false });
  assert.deepEqual(systemSettingsPanes('linux', '6.8.0'), { notifications: false, menubar: false });
  assert.equal(darwinMajor('25.5.0'), 25);
  assert.equal(darwinMajor('garbage'), 0);

  for (const url of Object.values(SYSTEM_SETTINGS_URLS)) assert.equal(isSystemSettingsUrl(url), true, url);
  for (const bad of [
    'x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.evil',
    'x-apple.systempreferences:com.apple.Notifications-Settings.extension ',
    'X-APPLE.SYSTEMPREFERENCES:com.apple.Notifications-Settings.extension',
    'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
    'x-apple.systempreferences:com.apple.LoginItems-Settings.extension',
    'x-apple.systempreferences:',
    'ms-settings:windowsupdate',
    'ms-settings:notifications/../privacy',
    'file:///System/Applications/System%20Settings.app',
    'https://example.com',
    '',
    undefined,
    null,
    42,
  ])
    assert.equal(isSystemSettingsUrl(bad), false, String(bad));
  assert.equal(isSystemSettingsPane('notifications'), true);
  assert.equal(isSystemSettingsPane('menubar'), true);
  for (const bad of ['security', 'x-apple.systempreferences:com.apple.Notifications-Settings.extension', undefined, {}])
    assert.equal(isSystemSettingsPane(bad), false);
  // The general link check stays web and mail only.
  for (const url of Object.values(SYSTEM_SETTINGS_URLS)) assert.equal(safeExternalUrl(url), null, url);
});

void test('help copy follows the platform', () => {
  assert.match(notificationHelp('darwin'), /macOS may be blocking Gnosis.*Focus or Do Not Disturb/);
  assert.match(notificationHelp('win32'), /Windows may be blocking Gnosis.*Do not disturb/);
  assert.doesNotMatch(notificationHelp('linux'), /macOS|Windows/);
  assert.match(notificationMissedHint('darwin'), /^Didn’t see it\? macOS may be blocking Gnosis/);
  assert.equal(notificationSettingsLabel('darwin'), 'Open macOS notification settings');
  assert.equal(notificationSettingsLabel('win32'), 'Open Windows notification settings');
  assert.match(menubarHelp(true), /Allow in the Menu Bar/);
  assert.doesNotMatch(menubarHelp(false), /Allow in the Menu Bar/);
});

void test('the onboarding service keeps notification answers when saving and applying setup', async () => {
  const { createOnboardingService } = await import('../src/onboarding-service');
  const data = new Map<string, unknown>();
  let prefs = { watchedRepos: [], guestMode: false, provider: 'claude', model: 'claude-opus-5-5' } as unknown as Preferences;
  const service = createOnboardingService({
    account: () => 'alice',
    preferences: () => prefs,
    savePreferences: (value) => {
      prefs = value;
    },
    views: () => ({ views: [], activeId: null }) as never,
    replaceViews: () => {},
    storage: { read: (key) => data.get(key), write: (key, value) => void data.set(key, value), flush: () => Promise.resolve() },
  });
  const draft = initialSetup(prefs);
  await service.save({ draft, desktop: { notifications: 'completed', menubar: 'bogus' as never } }, 'alice');
  assert.deepEqual(service.load().desktop, { notifications: 'completed' });
  await service.save({ draft }, 'alice');
  assert.equal('desktop' in service.load(), false);
  await service.save({ draft, desktop: { notifications: 'skipped', menubar: 'not-seen', prompt: 'started' } }, 'alice');
  await service.apply(draft, 'alice');
  assert.equal(service.load().completed, true);
  assert.deepEqual(service.load().desktop, { notifications: 'skipped', menubar: 'not-seen', prompt: 'started' });
});
