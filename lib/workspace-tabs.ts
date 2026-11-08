import type { AppLocation, HomeLocation } from './navigation-history';
import type { SearchDestination } from './command-search';
import { normalizeQueueFilters } from './queue-filters';
import { homeVisit } from './recently-viewed';

export type WorkspaceTarget =
  | SearchDestination
  | { kind: 'location'; location: AppLocation }
  | { kind: 'restore'; saved: SavedWorkspaceTab; account: string };
export interface WorkspaceTabEntry {
  id: string;
  title: string;
  label: string;
  detail: string;
  section: string;
  status?: 'opening' | 'error';
  initial?: WorkspaceTarget;
  location?: AppLocation;
}
export interface WorkspaceTabsState {
  tabs: WorkspaceTabEntry[];
  active: string;
  recent: string[];
  closed: WorkspaceTabEntry[];
}
export function newWorkspaceTab(id: string, initial?: WorkspaceTarget): WorkspaceTabEntry {
  const subject = initial?.kind === 'home' ? initial.subject?.subject : undefined;
  const url =
    initial?.kind === 'home' && initial.url ? /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(initial.url) : null;
  return {
    id,
    initial,
    title:
      subject?.title ??
      (initial?.kind === 'review'
        ? 'Explanation'
        : initial?.kind === 'home' && initial.url
          ? `PR #${url?.[2] ?? ''}`
          : 'Review queue'),
    label:
      subject?.kind === 'stack' ? 'Stack' : subject ? `#${subject.members[0].number}` : url ? `#${url[2]}` : 'Queue',
    detail: subject?.members[0].repo ?? url?.[1] ?? '',
    section: subject || url ? 'summary' : 'queue',
  };
}
export function initialWorkspaceTabs(tab: WorkspaceTabEntry): WorkspaceTabsState {
  return { tabs: [tab], active: tab.id, recent: [tab.id], closed: [] };
}
export type WorkspaceTabsAction =
  | { type: 'status'; id: string; status?: 'opening' | 'error' }
  | { type: 'close-others'; id: string }
  | { type: 'replace'; id: string; tab: WorkspaceTabEntry }
  | { type: 'open'; tab: WorkspaceTabEntry; background?: boolean }
  | { type: 'activate'; id: string }
  | { type: 'record'; id: string; location: AppLocation; title?: string }
  | { type: 'close'; id: string; replacement: WorkspaceTabEntry }
  | { type: 'reopen' }
  | { type: 'move'; id: string; offset: number };
export function reduceWorkspaceTabs(state: WorkspaceTabsState, action: WorkspaceTabsAction): WorkspaceTabsState {
  if (action.type === 'replace') {
    if (!state.tabs.some((tab) => tab.id === action.id)) return state;
    return {
      ...state,
      tabs: state.tabs.map((tab) => (tab.id === action.id ? action.tab : tab)),
      active: state.active === action.id ? action.tab.id : state.active,
      recent: state.recent.map((id) => (id === action.id ? action.tab.id : id)),
    };
  }
  if (action.type === 'status') {
    if (!state.tabs.some((tab) => tab.id === action.id && tab.status !== action.status)) return state;
    return {
      ...state,
      tabs: state.tabs.map((tab) => (tab.id === action.id ? { ...tab, status: action.status } : tab)),
    };
  }
  if (action.type === 'close-others') {
    const keep = state.tabs.find((tab) => tab.id === action.id);
    if (!keep || state.tabs.length === 1) return state;
    return {
      ...state,
      tabs: [keep],
      active: keep.id,
      recent: [keep.id],
      closed: [
        ...state.closed,
        ...state.tabs
          .filter((tab) => tab !== keep)
          .map((tab) => ({
            ...tab,
            status: undefined,
            initial: tab.location ? { kind: 'location' as const, location: tab.location } : tab.initial,
          })),
      ].slice(-20),
    };
  }
  if (action.type === 'open')
    return {
      ...state,
      tabs: [...state.tabs, action.tab],
      active: action.background ? state.active : action.tab.id,
      recent: action.background ? state.recent : [action.tab.id, ...state.recent],
    };
  if (action.type === 'activate')
    return !state.tabs.some((t) => t.id === action.id) || state.active === action.id
      ? state
      : { ...state, active: action.id, recent: [action.id, ...state.recent.filter((id) => id !== action.id)] };
  if (action.type === 'record') {
    const tab = state.tabs.find((t) => t.id === action.id);
    if (!tab) return state;
    const home = action.location.page === 'home' ? action.location.home : undefined;
    const visit = home ? homeVisit(home) : undefined;
    const next = {
      ...tab,
      location: action.location,
      title: action.title ?? visit?.title ?? tab.title,
      label: visit?.label ?? 'Review',
      detail: visit?.detail ?? '',
      section: home?.item ? home.tab : home ? 'queue' : 'explanation',
    };
    const old = tab.location;
    const current = action.location;
    const sameLocation =
      old?.page === 'home' && current.page === 'home'
        ? Object.keys(current.home).every(
            (key) => old.home[key as keyof HomeLocation] === current.home[key as keyof HomeLocation]
          )
        : old?.page === 'review' && current.page === 'review' && old.reviewId === current.reviewId;
    if (
      sameLocation &&
      ['title', 'label', 'detail', 'section'].every((key) => tab[key as 'title'] === next[key as 'title'])
    )
      return state;
    return { ...state, tabs: state.tabs.map((t) => (t.id === tab.id ? next : t)) };
  }
  if (action.type === 'close') {
    const tab = state.tabs.find((t) => t.id === action.id);
    if (!tab) return state;
    const tabs = state.tabs.filter((t) => t.id !== action.id);
    const recent = state.recent.filter((id) => id !== action.id);
    const closed = [
      ...state.closed,
      {
        ...tab,
        status: undefined,
        initial: tab.location ? { kind: 'location' as const, location: tab.location } : tab.initial,
      },
    ].slice(-20);
    if (!tabs.length) return { ...initialWorkspaceTabs(action.replacement), closed };
    return {
      ...state,
      tabs,
      closed,
      recent,
      active: state.active === action.id ? (recent[0] ?? tabs[0].id) : state.active,
    };
  }
  if (action.type === 'reopen') {
    const tab = state.closed.at(-1);
    return tab
      ? {
          ...state,
          tabs: [...state.tabs, tab],
          active: tab.id,
          recent: [tab.id, ...state.recent],
          closed: state.closed.slice(0, -1),
        }
      : state;
  }
  const from = state.tabs.findIndex((t) => t.id === action.id),
    to = from + action.offset;
  if (from < 0 || to < 0 || to >= state.tabs.length) return state;
  const tabs = [...state.tabs];
  const [tab] = tabs.splice(from, 1);
  tabs.splice(to, 0, tab);
  return { ...state, tabs };
}
export function workspaceShortcut(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'repeat'>
): 'new' | 'close' | 'reopen' | 'next' | 'previous' | number | undefined {
  if (event.isComposing || event.repeat || event.altKey) return;
  if (event.ctrlKey && !event.metaKey && event.key === 'Tab') return event.shiftKey ? 'previous' : 'next';
  if (!(event.metaKey || event.ctrlKey)) return;
  const key = event.key.toLowerCase();
  if (key === 't') return event.shiftKey ? 'reopen' : 'new';
  if (!event.shiftKey && key === 'w') return 'close';
  if (!event.shiftKey && /^[1-9]$/.test(key)) return Number(key);
}
// Persist only navigation metadata, never cached code, PR descriptions, or draft text.
export interface SavedWorkspaceTab {
  id: string;
  title: string;
  label: string;
  detail: string;
  section: string;
  home?: Omit<HomeLocation, 'item'> & { subjectId?: string; url?: string };
  reviewId?: string;
  destination?: Pick<Extract<SearchDestination, { kind: 'home' }>, 'kind' | 'section' | 'repo' | 'viewId' | 'url'>;
}
export interface SavedWorkspaceTabs {
  version: 1;
  active: string;
  tabs: SavedWorkspaceTab[];
}
export function saveWorkspaceTabs(state: WorkspaceTabsState): SavedWorkspaceTabs {
  return {
    version: 1,
    active: state.active,
    tabs: state.tabs.map((t) => {
      if (!t.location && t.initial?.kind === 'restore') return t.initial.saved;
      const saved: SavedWorkspaceTab = {
        id: t.id,
        title: t.title,
        label: t.label,
        detail: t.detail,
        section: t.section,
      };
      if (t.location?.page === 'home') {
        const { item, ...home } = t.location.home;
        saved.home = { ...home, subjectId: item?.subject.id, url: item?.subject.members[0]?.url };
      } else if (t.location?.page === 'review') saved.reviewId = t.location.reviewId;
      else if (t.initial?.kind === 'review') saved.reviewId = t.initial.reviewId;
      else if (t.initial?.kind === 'home' && t.initial.subject) {
        const subject = t.initial.subject.subject;
        saved.home = {
          account: '',
          filters: normalizeQueueFilters(undefined),
          savedView: false,
          savedQuery: '',
          viewId: null,
          muted: false,
          tab: 'summary',
          selected: null,
          scroll: 0,
          subjectId: subject.id,
          url: subject.members[0].url,
        };
      } else if (t.initial?.kind === 'home') {
        const { kind, section, repo, viewId, url } = t.initial;
        saved.destination = { kind, section, repo, viewId, url };
      }
      return saved;
    }),
  };
}

export function restoreWorkspaceTabs(value: unknown, account: string): WorkspaceTabsState | undefined {
  if (!value || typeof value !== 'object') return;
  const saved = value as Partial<SavedWorkspaceTabs>;
  if (saved.version !== 1 || !Array.isArray(saved.tabs)) return;
  const ids = new Set<string>();
  const tabs = (saved.tabs as unknown[]).flatMap((raw): WorkspaceTabEntry[] => {
    if (!raw || typeof raw !== 'object') return [];
    let tab = raw as SavedWorkspaceTab;
    if (
      typeof tab !== 'object' ||
      typeof tab.id !== 'string' ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(tab.id) ||
      ids.has(tab.id)
    )
      return [];
    if (![tab.title, tab.label, tab.detail, tab.section].every((s) => typeof s === 'string' && s.length < 10_000))
      return [];
    if (tab.reviewId !== undefined && typeof tab.reviewId !== 'string') return [];
    if (tab.home) {
      if (typeof tab.home !== 'object' || Array.isArray(tab.home)) return [];
      const h = tab.home;
      if (
        typeof h.savedQuery !== 'string' ||
        typeof h.savedView !== 'boolean' ||
        typeof h.muted !== 'boolean' ||
        !(h.viewId === null || typeof h.viewId === 'string') ||
        !(h.selected === null || typeof h.selected === 'string')
      )
        return [];
      if (
        (h.account && h.account !== account) ||
        !['summary', 'changes', 'commits', 'explanation', 'checks', 'brief', 'feedback'].includes(h.tab)
      )
        return [];
      if (
        h.url !== undefined &&
        (typeof h.url !== 'string' || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(h.url))
      )
        return [];
      if (h.subjectId !== undefined && typeof h.subjectId !== 'string') return [];
      tab = {
        ...tab,
        home: {
          ...h,
          account,
          filters: normalizeQueueFilters(h.filters),
          scroll: Number.isFinite(h.scroll) ? Math.max(0, h.scroll) : 0,
        },
      };
    }
    if (tab.destination) {
      if (typeof tab.destination !== 'object' || Array.isArray(tab.destination)) return [];
      const d = tab.destination;
      if (
        (d as { kind: unknown }).kind !== 'home' ||
        (d.url !== undefined &&
          (typeof d.url !== 'string' || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(d.url)))
      )
        return [];
      if (
        d.section !== undefined &&
        !['response', 'all', 'requested', 'updated', 'stacks', 'saved', 'starred', 'muted'].includes(d.section)
      )
        return [];
      if (
        (d.repo !== undefined && typeof d.repo !== 'string') ||
        (d.viewId !== undefined && typeof d.viewId !== 'string')
      )
        return [];
      tab = { ...tab, destination: { kind: 'home', section: d.section, repo: d.repo, viewId: d.viewId, url: d.url } };
    }
    ids.add(tab.id);
    return [
      {
        id: tab.id,
        title: tab.title,
        label: tab.label,
        detail: tab.detail,
        section: tab.section,
        initial: { kind: 'restore', saved: tab, account },
      },
    ];
  });
  if (!tabs.length) return;
  const active =
    typeof saved.active === 'string' && tabs.some((t) => t.id === saved.active) ? saved.active : tabs[0].id;
  return { tabs, active, recent: [active, ...tabs.filter((t) => t.id !== active).map((t) => t.id)], closed: [] };
}

/** Location reports can change on every scroll; the strip only needs its visible metadata. */
export function sameTabChrome(a: WorkspaceTabsState, b: WorkspaceTabsState): boolean {
  return (
    a.active === b.active &&
    a.closed.length === b.closed.length &&
    a.tabs.length === b.tabs.length &&
    a.tabs.every((tab, i) => {
      const next = b.tabs[i];
      return (
        tab.id === next.id &&
        tab.title === next.title &&
        tab.label === next.label &&
        tab.detail === next.detail &&
        tab.section === next.section &&
        tab.status === next.status
      );
    })
  );
}
export function workspaceTabDescription(tab: WorkspaceTabEntry) {
  const section =
    (
      {
        queue: 'Review queue',
        summary: 'Summary',
        changes: 'Changes',
        commits: 'Commits',
        explanation: 'Explanation',
        checks: 'Checks',
        brief: 'Local notes',
        feedback: 'Feedback',
      } as Record<string, string>
    )[tab.section] ?? tab.section;
  return [tab.label, tab.detail, section].filter(Boolean).join(' · ');
}
