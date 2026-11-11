import { Activity, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { RepositorySettingsProvider } from '../components/RepositorySettingsProvider';
import { RecentlyViewedContext } from '../components/RecentlyViewed';
import { ConflictWorkspaceHost } from '../components/ConflictWorkspaceHost';
import { ActivityDrawer } from '../components/ActivityDrawer';
import type { GitHubSyncStatusProps } from '../components/GitHubSyncStatus';
import { WorkspaceErrorBoundary } from '../components/WorkspaceErrorBoundary';
import { WorkspaceTabs } from '../components/WorkspaceTabs';
import { LoadingState } from '../components/LoadingState';
import { toast, Toaster } from '../components/ui/toast';
import { createRecentlyViewed, type RecentVisit } from '../lib/recently-viewed';
import { readReviewState, writeReviewState } from '../lib/renderer-review-state';
import { useFileFilterSync } from '../lib/use-raw-file-filters';
import { WorkspaceDraftBoundary, retainWorkspaceDrafts } from '../lib/session-drafts';
import { CommandCenter } from '../lib/command-center';
import { hasVisibleModal, WorkspaceNavigation } from '../lib/workspace-navigation';
import {
  initialWorkspaceTabs,
  newWorkspaceTab,
  reduceWorkspaceTabs,
  workspaceShortcut,
  saveWorkspaceTabs,
  restoreWorkspaceTabs,
  type WorkspaceTarget,
  type WorkspaceTabsState,
} from '../lib/workspace-tabs';
import type { AppLocation } from '../lib/navigation-history';
import type { ActivityTask } from '../lib/activity';
import { ReviewWorkspace, type WorkspaceController } from './ReviewWorkspace';
import { PrSummary } from './lazy-screens';
import './workspace-tabs.css';
import { useWorkspaceListings } from '../lib/use-workspace-listings';
import { workbenchStore } from '../lib/workbench-store';
import { workspaceTabTitle } from '../lib/workspace-listings';

const newTab = (target?: WorkspaceTarget) => newWorkspaceTab(crypto.randomUUID(), target);
const storageKey = (account: string) => `gnosis-workspace-tabs:v1:${account}`;
export function App() {
  useFileFilterSync();
  useEffect(() => {
    window.electronAPI.perfMark?.('first-render');
    // A restored PR tab opens its summary first.
    void PrSummary.preload();
  }, []);
  const [recentlyViewed] = useState(() => createRecentlyViewed(readReviewState, writeReviewState));
  const [state, setState] = useState<WorkspaceTabsState>(() => initialWorkspaceTabs(newTab()));
  const [account, setAccount] = useState<string>();
  const listings = useWorkspaceListings(state.tabs, account);
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  const [activityOpen, setActivityOpen] = useState(false);
  const [syncStatus, setSyncStatus] = useState<GitHubSyncStatusProps>();
  // Queue pages publish on every change they see; only a different status re-renders the drawer.
  const publishSync = useCallback((next: GitHubSyncStatusProps | undefined) => setSyncStatus(previous =>
    previous?.onRefresh === next?.onRefresh && previous?.sync?.status === next?.sync?.status &&
    previous?.sync?.checkedAt === next?.sync?.checkedAt && previous?.sync?.retryAt === next?.sync?.retryAt ? previous : next), []);
  const controllers = useRef(new Map<string, WorkspaceController>());
  const latest = useRef(state);
  latest.current = state;
  const currentAccount = useRef(account);
  currentAccount.current = account;
  const writes = useRef(Promise.resolve());
  const storageError = useRef(false);
  const focusTab = useRef(false);
  const persist = useCallback((key: string, value: WorkspaceTabsState) => {
    const saved = saveWorkspaceTabs(value);
    writes.current = writes.current
      .then(async () => {
        await writeReviewState(storageKey(key), saved);
        storageError.current = false;
      })
      .catch(() => {
        if (storageError.current) return;
        storageError.current = true;
        toast.add({
          type: 'error',
          title: 'Could not save open tabs',
          description: 'Your current tabs remain open. They may not restore after a restart.',
          actionProps: {
            children: 'Retry',
            onClick: () => {
              storageError.current = false;
              // A toast can outlive an account switch; never retry an old snapshot over a newer save.
              if (currentAccount.current) persist(currentAccount.current, latest.current);
            },
          },
        });
      });
  }, []);
  const scopeAccount = useCallback(
    (key: string, resumeSetup = false) => {
      if (currentAccount.current === key) return;
      if (currentAccount.current) persist(currentAccount.current, latest.current);
      currentAccount.current = key;
      workbenchStore.reset(key);
      recentlyViewed.scope(key);
      let next: WorkspaceTabsState;
      try {
        next = restoreWorkspaceTabs(readReviewState(storageKey(key)), key) ?? initialWorkspaceTabs(newTab());
      } catch {
        next = initialWorkspaceTabs(newTab());
      }
      if (resumeSetup) {
        const setup = newTab({ kind: 'home', onboarding: 'setup' });
        next =
          next.tabs.length === 1 && !next.tabs[0].initial
            ? initialWorkspaceTabs(setup)
            : reduceWorkspaceTabs(next, { type: 'open', tab: setup });
      }
      latest.current = next;
      setState(next);
      setVisited(new Set([next.active]));
      setAccount(key);
      setActivityOpen(false);
    },
    [recentlyViewed, persist]
  );
  useEffect(() => {
    let live = true;
    void window.electronAPI
      .getAuthState()
      .then((auth) => {
        if (live) scopeAccount(auth.authenticated ? (auth.login ?? 'local') : 'local');
      })
      .catch(() => {
        if (live) scopeAccount('local');
      });
    return () => {
      live = false;
    };
  }, [scopeAccount]);
  useEffect(() => {
    if (!account) return;
    const timer = setTimeout(() => persist(account, latest.current), 500);
    return () => clearTimeout(timer);
  }, [state, account, persist]);
  useEffect(() => {
    const save = () => {
      if (currentAccount.current) persist(currentAccount.current, latest.current);
    };
    window.addEventListener('pagehide', save);
    return () => window.removeEventListener('pagehide', save);
  }, [persist]);
  const change = useCallback(
    (action: Parameters<typeof reduceWorkspaceTabs>[1]) => setState((old) => reduceWorkspaceTabs(old, action)),
    []
  );
  const activate = useCallback(
    (id: string) => {
      focusTab.current = true;
      setVisited((old) => new Set([...old, id]));
      change({ type: 'activate', id });
    },
    [change]
  );
  const open = useCallback(
    (target?: WorkspaceTarget, background = false, title?: string) => {
      const tab = newTab(target);
      if (title) tab.title = title;
      if (!background) focusTab.current = true;
      if (!background) setVisited((old) => new Set([...old, tab.id]));
      change({ type: 'open', tab, background });
    },
    [change]
  );
  const close = useCallback(
    (id: string) => {
      focusTab.current =
        latest.current.active === id ||
        document.activeElement?.closest('.workspace-tab')?.querySelector('[role=tab]')?.id === `workspace-tab-${id}`;
      change({ type: 'close', id, replacement: newTab() });
    },
    [change]
  );
  const reopen = useCallback(() => {
    focusTab.current = true;
    change({ type: 'reopen' });
  }, [change]);
  const tabIds = state.tabs.map((tab) => tab.id).join(',');
  const retainedIds = [...state.tabs, ...state.closed].map((tab) => tab.id).join(',');
  useEffect(() => {
    if (account) retainWorkspaceDrafts(account, retainedIds.split(','));
  }, [account, retainedIds]);
  useLayoutEffect(() => {
    setVisited((old) => new Set([...old].filter((id) => state.tabs.some((tab) => tab.id === id)).concat(state.active)));
    if (focusTab.current) {
      focusTab.current = false;
      const frame = requestAnimationFrame(() =>
        document.getElementById(`workspace-tab-${state.active}`)?.focus({ preventScroll: true })
      );
      return () => cancelAnimationFrame(frame);
    }
  }, [state.active, tabIds]);
  const openQueue = useCallback(() => open(), [open]);
  const move = useCallback((id: string, offset: number) => change({ type: 'move', id, offset }), [change]);
  const closeOthers = useCallback(
    (id: string) => {
      focusTab.current = true;
      change({ type: 'close-others', id });
    },
    [change]
  );
  const reportStatus = useCallback(
    (id: string, status?: 'opening' | 'error') => change({ type: 'status', id, status }),
    [change]
  );
  const register = useCallback((id: string, controller: WorkspaceController) => {
    controllers.current.set(id, controller);
    return () => {
      if (controllers.current.get(id) === controller) controllers.current.delete(id);
    };
  }, []);
  const record = useCallback(
    (id: string, location: AppLocation, title?: string) => change({ type: 'record', id, location, title }),
    [change]
  );
  useEffect(() => {
    const perform = (action: NonNullable<ReturnType<typeof workspaceShortcut>>) => {
      if (hasVisibleModal()) return;
      const s = latest.current;
      if (action === 'new') open();
      else if (action === 'close') close(s.active);
      else if (action === 'reopen') reopen();
      else if (typeof action === 'number')
        activate(s.tabs[action === 9 ? s.tabs.length - 1 : Math.min(action - 1, s.tabs.length - 1)].id);
      else
        activate(
          s.tabs[
            (s.tabs.findIndex((t) => t.id === s.active) + (action === 'next' ? 1 : s.tabs.length - 1)) % s.tabs.length
          ].id
        );
    };
    const key = (event: KeyboardEvent) => {
      const action = workspaceShortcut(event);
      if (action === undefined || hasVisibleModal()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      perform(action);
    };
    const stop = window.electronAPI.onWorkspaceShortcut(perform);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      if (typeof stop === 'function') stop();
    };
  }, [activate, open, close, reopen]);
  useEffect(() => {
    const failed = (event: Event) => {
      const { message, retry } = (event as CustomEvent<{ message: string; retry: () => Promise<void> }>).detail;
      toast.add({
        type: 'error',
        title: 'Could not save review progress',
        description: message,
        actionProps: { children: 'Retry', onClick: () => void retry().catch(() => {}) },
      });
    };
    window.addEventListener('gnosis-storage-error', failed);
    return () => window.removeEventListener('gnosis-storage-error', failed);
  }, []);
  const controller = () => controllers.current.get(latest.current.active);
  const refreshQueue = useCallback(() => workbenchStore.refresh().catch(() => {}), []);
  const openActivity = useCallback(async (task: ActivityTask) => {
    await controllers.current.get(latest.current.active)?.openActivity(task);
  }, []);
  const navigation = useMemo(() => ({ open }), [open]);
  const recentNavigation = useMemo(
    () => ({
      store: recentlyViewed,
      open: async (visit: RecentVisit) => {
        await controllers.current.get(latest.current.active)?.openRecent(visit);
      },
    }),
    [recentlyViewed]
  );
  return (
    <RepositorySettingsProvider>
      <RecentlyViewedContext.Provider value={recentNavigation}>
        <WorkspaceNavigation.Provider value={navigation}>
          <CommandCenter
            navigate={async (target) => {
              await controller()?.navigate(target);
            }}
            commands={[
              { id: 'tabs:new', label: 'New tab', keywords: 'open workspace review', perform: () => open() },
              { id: 'tabs:reopen', label: 'Reopen closed tab', perform: reopen },
              ...state.tabs.map((tab) => ({
                id: `tabs:${tab.id}`,
                label: `Switch to ${workspaceTabTitle(tab, listings[tab.id])}`,
                keywords: `open tab ${tab.label} ${tab.detail}`,
                perform: () => activate(tab.id),
              })),
            ]}
          >
            <a
              href="#main-content"
              className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100] focus:bg-background focus:p-3"
            >
              Skip to content
            </a>
            <div className="workspace-shell">
              <WorkspaceTabs
                state={state}
                listings={listings}
                activate={activate}
                close={close}
                open={openQueue}
                reopen={reopen}
                move={move}
                closeOthers={closeOthers}
              />
              <div id="main-content" tabIndex={-1}>
                {!account ? (
                  <LoadingState title="Opening workspace…" />
                ) : (
                  state.tabs.map((tab) => (
                    <div
                      key={tab.id}
                      data-workspace-active={state.active === tab.id}
                      className="workspace-panel"
                      id={`workspace-panel-${tab.id}`}
                      role="tabpanel"
                      aria-labelledby={`workspace-tab-${tab.id}`}
                      hidden={state.active !== tab.id}
                      inert={state.active !== tab.id}
                    >
                      {visited.has(tab.id) && (
                        <Activity mode={state.active === tab.id ? 'visible' : 'hidden'}>
                          <WorkspaceDraftBoundary value={`workspace:${account}:${tab.id}`}>
                            <WorkspaceErrorBoundary
                              onRetry={refreshQueue}
                              onQueue={() => {
                                // Tabs share one queue snapshot, so read it again before replacing the failed tab.
                                void refreshQueue().finally(() => change({ type: 'replace', id: tab.id, tab: newTab() }));
                              }}
                            >
                              <ReviewWorkspace
                                id={tab.id}
                                initial={tab.initial}
                                recentlyViewed={recentlyViewed}
                                register={register}
                                onLocation={record}
                                onStatus={reportStatus}
                                onAccount={scopeAccount}
                                setActivityOpen={setActivityOpen}
                                onSyncStatus={publishSync}
                              />
                            </WorkspaceErrorBoundary>
                          </WorkspaceDraftBoundary>
                        </Activity>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
            <ActivityDrawer
              syncStatus={syncStatus}
              open={activityOpen}
              onOpenChange={setActivityOpen}
              onOpen={openActivity}
            />
            <ConflictWorkspaceHost />
            <Toaster />
          </CommandCenter>
        </WorkspaceNavigation.Provider>
      </RecentlyViewedContext.Provider>
    </RepositorySettingsProvider>
  );
}
