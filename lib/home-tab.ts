/**
 * Which home tab opens (#390): the Overview by default, or the review queue once the reader last chose it. The choice
 * is a local preference for this computer. Links, saved views and restored locations that name a list keep opening
 * that list.
 */
import type { HomeLocation } from './navigation-history';

export type HomeTab = 'overview' | 'queue';
export const HOME_TAB_KEY = 'gnosis-home-tab:v1';

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const local = (): Store | undefined => {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
};

export function homeTabPreference(store: Store | undefined = local()): HomeTab {
  try {
    return store?.getItem(HOME_TAB_KEY) === 'queue' ? 'queue' : 'overview';
  } catch {
    return 'overview';
  }
}
export function rememberHomeTab(tab: HomeTab, store: Store | undefined = local()) {
  try {
    store?.setItem(HOME_TAB_KEY, tab);
  } catch {
    // Storage may be unavailable; the Overview stays the default.
  }
}

/** The plain review queue: no PR, tool, saved view, list or lane. Only this can stand for "the home tab". */
export function isPlainQueue(home: HomeLocation): boolean {
  const f = home.filters;
  return (
    !home.item && !home.muted && !home.snoozed && !home.savedView && !home.viewId &&
    f.attention === 'all' && f.kind === 'all' && !f.starredOnly && f.involvement !== 'response' && !f.lane && !f.urls?.length
  );
}

/**
 * The tool a restored location shows. A location saved before the Overview existed has no `overview` field: a plain
 * queue there opens the home tab preference, and anything more specific keeps its list.
 */
export function restoredTool(home: HomeLocation, preference: HomeTab = homeTabPreference()): 'overview' | 'muted' | 'snoozed' | null {
  if (home.overview) return 'overview';
  if (home.muted) return 'muted';
  if (home.snoozed) return 'snoozed';
  if (home.overview === undefined && preference === 'overview' && isPlainQueue(home)) return 'overview';
  return null;
}
