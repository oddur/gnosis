/**
 * Which home tab opens (#390): the Overview by default, or the review queue once the reader last chose it. The choice
 * is a local preference for this computer. Links, saved views and restored locations that name a list keep opening
 * that list.
 */
import type { HomeLocation } from './navigation-history';
import type { SavedWorkspaceTab, WorkspaceTabEntry, WorkspaceTabsState } from './workspace-tabs';
import { isOverviewTab } from './workspace-listings';

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

/**
 * One Overview at a time by default. A home tab with no explicit list (a new tab, a tab never shown, a plain queue
 * saved before the Overview existed) opens the home tab preference only while no other tab shows the Overview, and
 * the review queue otherwise. Cmd-click, middle-click, links and locations saved with `overview: true` still open a
 * second Overview on purpose.
 */
export function defaultHomeTab(others: readonly WorkspaceTabEntry[], preference: HomeTab = homeTabPreference()): HomeTab {
  return others.some(isOverviewTab) ? 'queue' : preference;
}

type OverviewClaim = 'explicit' | 'default' | undefined;
/** Why a restored tab would show the Overview: it was saved that way, only by default, or it would not. */
function overviewClaim(saved: SavedWorkspaceTab, preference: HomeTab): OverviewClaim {
  if (saved.reviewId) return;
  if (saved.home) {
    if (saved.home.subjectId || saved.home.url) return;
    if (saved.home.overview) return 'explicit';
    if (saved.home.overview === undefined && preference === 'overview' && isPlainQueue({ ...saved.home, item: null }))
      return 'default';
    return;
  }
  const d = saved.destination;
  if (d?.section === 'overview' && !d.url) return 'explicit';
  if (!d || (!d.section && !d.repo && !d.viewId && !d.url)) return preference === 'overview' ? 'default' : undefined;
}

/**
 * Restored tabs show at most one Overview. Tabs saved with `overview: true` win over tabs that would show it only by
 * default (these came from the duplicate-Overview bug); within either group the active tab wins, else the first. The
 * others restore as the review queue. Each choice is written into the tab's saved location and `homeDefault`, so the
 * tab strip counts what a tab will show before it is first shown, and the next save keeps it.
 */
export function dedupeRestoredOverviews(state: WorkspaceTabsState, preference: HomeTab = homeTabPreference()): WorkspaceTabsState {
  const claims = state.tabs.map((tab) => (tab.initial?.kind === 'restore' ? overviewClaim(tab.initial.saved, preference) : undefined));
  const pick = (claim: OverviewClaim) => {
    const ids = state.tabs.filter((_, index) => claims[index] === claim).map((tab) => tab.id);
    return ids.includes(state.active) ? state.active : ids[0];
  };
  const keep = state.tabs.some((tab) => tab.initial?.kind !== 'restore' && isOverviewTab(tab))
    ? undefined
    : (pick('explicit') ?? pick('default'));
  return {
    ...state,
    tabs: state.tabs.map((tab, index) => {
      if (tab.initial?.kind !== 'restore') return tab;
      const overview = tab.id === keep;
      const homeDefault: HomeTab = overview ? 'overview' : 'queue';
      if (!claims[index]) return { ...tab, homeDefault };
      const saved = tab.initial.saved;
      const next: SavedWorkspaceTab = saved.home
        ? { ...saved, home: { ...saved.home, overview } }
        : { ...saved, destination: { ...saved.destination, kind: 'home', section: overview ? 'overview' : undefined } };
      return { ...tab, homeDefault, initial: { ...tab.initial, saved: next } };
    }),
  };
}
