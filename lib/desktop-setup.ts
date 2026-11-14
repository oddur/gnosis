/**
 * Notifications and the menu bar in setup. Pure, so main, the renderer and unit tests share one reading of the
 * step outcomes, the platform branching and the System Settings links.
 */

/** The setup steps after GitHub and repositories. The menu bar step is macOS only. */
export type DesktopStep = 'notifications' | 'menubar';
export const DESKTOP_STEPS = ['notifications', 'menubar'] as const satisfies readonly DesktopStep[];
/** `completed`: the user saw the test notification or the icon. `not-seen`: they answered No. */
export type DesktopOutcome = 'completed' | 'not-seen' | 'skipped';
const OUTCOMES = ['completed', 'not-seen', 'skipped'] as const satisfies readonly DesktopOutcome[];
export interface DesktopSetupState {
  notifications?: DesktopOutcome;
  menubar?: DesktopOutcome;
  /** The one-time prompt for people who finished setup before these steps existed. */
  prompt?: 'dismissed' | 'started';
}

export function desktopSteps(platform: string): DesktopStep[] {
  return platform === 'darwin' ? ['notifications', 'menubar'] : ['notifications'];
}

export function normalizeDesktopSetup(input: unknown): DesktopSetupState | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  const value: DesktopSetupState = {};
  for (const step of DESKTOP_STEPS) {
    const outcome = OUTCOMES.find((candidate) => candidate === raw[step]);
    if (outcome) value[step] = outcome;
  }
  if (raw.prompt === 'dismissed' || raw.prompt === 'started') value.prompt = raw.prompt;
  return Object.keys(value).length ? value : undefined;
}

/** A skip never replaces an answer the user already gave. */
export function recordDesktopOutcome(
  state: DesktopSetupState | undefined,
  step: DesktopStep,
  outcome: DesktopOutcome
): DesktopSetupState {
  const current = state ?? {};
  if (outcome === 'skipped' && current[step]) return current;
  return { ...current, [step]: outcome };
}

/**
 * The one-time prompt: people who finished setup before these steps existed, signed in to GitHub, with no answer
 * for either step and the prompt never dismissed or started.
 */
export function offerDesktopSetup(input: {
  state: { desktop?: DesktopSetupState } | undefined;
  firstRunSeen: boolean;
  guestMode: boolean;
  signedIn: boolean;
}): boolean {
  const desktop = input.state?.desktop;
  return (
    input.firstRunSeen &&
    !input.guestMode &&
    input.signedIn &&
    !desktop?.notifications &&
    !desktop?.menubar &&
    !desktop?.prompt
  );
}

// ── System Settings links ──────────────────────────────────────────
// Only these exact URLs reach shell.openExternal, through their own IPC. `safeExternalUrl` stays web and mail only.
// Verified on macOS 26.5 from /System/Library/ExtensionKit/Extensions: NotificationsSettings.appex has the
// identifier com.apple.Notifications-Settings.extension (legacy com.apple.preference.notifications), and
// ControlCenterSettings.appex has com.apple.ControlCenter-Settings.extension, shown as "Menu Bar" on macOS 26, with
// the "Allow in the Menu Bar" list. Both declare allowsXAppleSystemPreferencesURLScheme.
export const SYSTEM_SETTINGS_URLS = {
  /** macOS 13 and later. */
  macNotifications: 'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
  /** macOS 12, System Preferences. */
  macNotificationsLegacy: 'x-apple.systempreferences:com.apple.preference.notifications',
  /** macOS 26 and later: System Settings › Menu Bar. */
  macMenuBar: 'x-apple.systempreferences:com.apple.ControlCenter-Settings.extension',
  /** Windows 10 and 11: Settings › System › Notifications. */
  windowsNotifications: 'ms-settings:notifications',
} as const;
const ALLOWED_SETTINGS_URLS: ReadonlySet<string> = new Set(Object.values(SYSTEM_SETTINGS_URLS));
export type SystemSettingsPane = 'notifications' | 'menubar';
export const isSystemSettingsPane = (value: unknown): value is SystemSettingsPane =>
  value === 'notifications' || value === 'menubar';

/** Darwin 22 is macOS 13, Darwin 25 is macOS 26. */
export function darwinMajor(release: string): number {
  const major = Number.parseInt(release, 10);
  return Number.isFinite(major) ? major : 0;
}

/** The System Settings URL for a pane on this system, or null when there is none to open. */
export function systemSettingsUrl(pane: SystemSettingsPane, platform: string, release: string): string | null {
  if (platform === 'darwin') {
    const major = darwinMajor(release);
    if (pane === 'notifications')
      return major >= 22 ? SYSTEM_SETTINGS_URLS.macNotifications : SYSTEM_SETTINGS_URLS.macNotificationsLegacy;
    // Before macOS 26 there is no per-app "Allow in the Menu Bar" setting to open.
    return major >= 25 ? SYSTEM_SETTINGS_URLS.macMenuBar : null;
  }
  if (platform === 'win32' && pane === 'notifications') return SYSTEM_SETTINGS_URLS.windowsNotifications;
  return null;
}

/** Exact matches only: no prefixes, query strings, other panes or other schemes. */
export function isSystemSettingsUrl(url: unknown): url is string {
  return typeof url === 'string' && ALLOWED_SETTINGS_URLS.has(url);
}

export interface SystemSettingsPanes {
  notifications: boolean;
  menubar: boolean;
}
export function systemSettingsPanes(platform: string, release: string): SystemSettingsPanes {
  return {
    notifications: !!systemSettingsUrl('notifications', platform, release),
    menubar: !!systemSettingsUrl('menubar', platform, release),
  };
}

/** The result of "Show me": main opens the panel under the icon when it can. */
export type MenubarShowResult = 'shown' | 'off' | 'menu' | 'hidden' | 'unsupported';

// ── Copy shared by setup and Settings ──────────────────────────────
const systemName = (platform: string) =>
  platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Your system';

/** After "No" or "Didn't see it?": what may be blocking the notification and how to allow it. */
export function notificationHelp(platform: string): string {
  if (platform === 'darwin')
    return 'macOS may be blocking Gnosis. In Notifications settings, select Gnosis and turn on Allow notifications. Also check that Focus or Do Not Disturb is off.';
  if (platform === 'win32')
    return 'Windows may be blocking Gnosis. In Notifications settings, turn on notifications for Gnosis. Also check that Do not disturb is off.';
  return 'Your desktop may be blocking Gnosis. Check its notification settings for Gnosis, and check that Do Not Disturb is off.';
}

/** The quiet line in Settings after a test notification. */
export function notificationMissedHint(platform: string): string {
  if (platform === 'darwin') return 'Didn’t see it? macOS may be blocking Gnosis, or Focus may be on.';
  if (platform === 'win32') return 'Didn’t see it? Windows may be blocking Gnosis, or Do not disturb may be on.';
  return 'Didn’t see it? Your desktop may be blocking Gnosis, or Do Not Disturb may be on.';
}

export function notificationSettingsLabel(platform: string): string {
  return platform === 'darwin' || platform === 'win32'
    ? `Open ${systemName(platform)} notification settings`
    : 'Open notification settings';
}

/** After "No" on the menu bar step or "Can't see the icon?" in Settings. */
export function menubarHelp(canOpenSettings: boolean): string {
  return canOpenSettings
    ? 'macOS can hide menu bar icons. In Menu Bar settings, find Gnosis under Allow in the Menu Bar and turn it on. On a full menu bar, the icon can also sit behind the camera.'
    : 'On a full menu bar, macOS hides icons that do not fit, including behind the camera. Quit a few menu bar apps, or check your menu bar manager, then look again.';
}
