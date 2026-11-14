/**
 * Settings for the menu bar icon (#308 section 9). Pure, so main, the renderer and unit tests share one reading of
 * `preferences.json`. Missing or invalid values fall back to the defaults.
 */
import { badgeCount, type AttentionItem } from './attention';

/** What a left click on the icon opens on macOS. `menu` is the classic menu, kept as a setting for one release. */
export type MenubarClick = 'panel' | 'menu';
export const MENUBAR_CLICKS = ['panel', 'menu'] as const satisfies readonly MenubarClick[];
/**
 * The number beside the icon. `new`: PRs that need you and that you have not opened since. `all`: every PR that
 * needs you. `dot`: a dot without a number. `none`: nothing.
 */
export type MenubarBadge = 'new' | 'all' | 'dot' | 'none';
export const MENUBAR_BADGES = ['new', 'all', 'dot', 'none'] as const satisfies readonly MenubarBadge[];

export interface MenubarPreferences {
  click?: MenubarClick;
  badge?: MenubarBadge;
}
export interface MenubarSettings {
  click: MenubarClick;
  badge: MenubarBadge;
}
export const DEFAULT_MENUBAR_SETTINGS: Readonly<MenubarSettings> = { click: 'panel', badge: 'new' };

export function menubarSettings(preferences: unknown): MenubarSettings {
  const p = (preferences && typeof preferences === 'object' ? preferences : {}) as Record<string, unknown>;
  const raw = (p.menubarSettings && typeof p.menubarSettings === 'object' ? p.menubarSettings : {}) as Record<string, unknown>;
  return {
    click: MENUBAR_CLICKS.find((value) => value === raw.click) ?? DEFAULT_MENUBAR_SETTINGS.click,
    badge: MENUBAR_BADGES.find((value) => value === raw.badge) ?? DEFAULT_MENUBAR_SETTINGS.badge,
  };
}

/**
 * What the icon shows for the current rows. The same count sets the Dock badge, so the two always agree.
 * `title` is empty for no number; above 99 it is "99+". `dot` selects the dot variant of the template image.
 */
export function menubarBadge(items: readonly AttentionItem[], mode: MenubarBadge): { title: string; dot: boolean; count: number } {
  if (mode === 'none') return { title: '', dot: false, count: 0 };
  const count = badgeCount(items, mode === 'all' ? 'all' : 'new');
  if (mode === 'dot') return { title: '', dot: count > 0, count };
  return { title: count === 0 ? '' : count > 99 ? '99+' : String(count), dot: false, count };
}
