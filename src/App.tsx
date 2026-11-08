import { applyCodeFont } from '../components/SettingsDialog';
import { applyTheme } from '../lib/theme';
import { Activity, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { RepositorySettingsProvider } from '../components/RepositorySettingsProvider';
import { RecentlyViewedContext } from '../components/RecentlyViewed';
import { ConflictWorkspaceHost } from '../components/ConflictWorkspaceHost';
import { ActivityDrawer } from '../components/ActivityDrawer';
import type { GitHubSyncStatusProps } from '../components/GitHubSyncStatus';
import { WorkspaceTabs } from '../components/WorkspaceTabs';
import { LoadingState } from '../components/LoadingState';
import { toast, Toaster } from '../components/ui/toast';
import { createRecentlyViewed, type RecentVisit } from '../lib/recently-viewed';
import { readReviewState, writeReviewState } from '../lib/renderer-review-state';
import { useFileFilterSync } from '../lib/use-raw-file-filters';
import { WorkspaceDraftBoundary } from '../lib/session-drafts';
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
import { ReviewWorkspace, type WorkspaceController } from './ReviewWorkspace';
import './workspace-tabs.css';

const newTab = (target?: WorkspaceTarget) => newWorkspaceTab(crypto.randomUUID(), target);
const storageKey = (account: string) => `gnosis-workspace-tabs:v1:${account}`;
export function App() {
  useFileFilterSync();
  useEffect(() => {
    let live = true;
    void window.electronAPI
      .loadPreferences()
      .then((p) => {
        if (live) {
          if (p.codeFont) applyCodeFont(p.codeFont);
          applyTheme(p.theme);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const [recentlyViewed] = useState(() => createRecentlyViewed(readReviewState, writeReviewState));
  const [state, setState] = useState<WorkspaceTabsState>(() => initialWorkspaceTabs(newTab()));
  const [account, setAccount] = useState<string>();
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  const [activityOpen, setActivityOpen] = useState(false);
  const [syncStatus, setSyncStatus] = useState<GitHubSyncStatusProps>();
  const controllers = useRef(new Map<string, WorkspaceController>());
  const latest = useRef(state);
  latest.current = state;
  const currentAccount = useRef(account);
  currentAccount.current = account;
  const writes = useRef(Promise.resolve());
  const persist = useCallback((key: string, value: WorkspaceTabsState) => {
    const saved = saveWorkspaceTabs(value);
    writes.current = writes.current
      .then(() => writeReviewState(storageKey(key), saved))
      .catch(() => {
        toast.add({
          type: 'error',
          title: 'Could not save open tabs',
          description: 'Your current tabs remain open. They may not restore after a restart.',
        });
      });
  }, []);
  const scopeAccount = useCallback(
    (key: string) => {
      if (currentAccount.current === key) return;
      if (currentAccount.current) persist(currentAccount.current, latest.current);
      currentAccount.current = key;
      recentlyViewed.scope(key);
      let next: WorkspaceTabsState;
      try {
        next = restoreWorkspaceTabs(readReviewState(storageKey(key)), key) ?? initialWorkspaceTabs(newTab());
      } catch {
        next = initialWorkspaceTabs(newTab());
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
      setVisited((old) => new Set([...old, id]));
      change({ type: 'activate', id });
    },
    [change]
  );
  const open = useCallback(
    (target?: WorkspaceTarget, background = false, title?: string) => {
      const tab = newTab(target);
      if (title) tab.title = title;
      if (!background) setVisited((old) => new Set([...old, tab.id]));
      change({ type: 'open', tab, background });
    },
    [change]
  );
  const close = useCallback(
    (id: string) => {
      change({ type: 'close', id, replacement: newTab() });
    },
    [change]
  );
  const reopen = useCallback(() => {
    change({ type: 'reopen' });
  }, [change]);
  useLayoutEffect(() => {
    setVisited((old) => (old.has(state.active) ? old : new Set([...old, state.active])));
  }, [state.active]);
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
                label: `Switch to ${tab.title}`,
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
                activate={activate}
                close={close}
                open={() => open()}
                reopen={reopen}
                move={(id, offset) => change({ type: 'move', id, offset })}
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
                            <ReviewWorkspace
                              id={tab.id}
                              initial={tab.initial}
                              recentlyViewed={recentlyViewed}
                              register={register}
                              onLocation={record}
                              onAccount={scopeAccount}
                              setActivityOpen={setActivityOpen}
                              onSyncStatus={setSyncStatus}
                            />
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
              onOpen={async (task) => {
                await controller()?.openActivity(task);
              }}
            />
            <ConflictWorkspaceHost />
            <Toaster />
          </CommandCenter>
        </WorkspaceNavigation.Provider>
      </RecentlyViewedContext.Provider>
    </RepositorySettingsProvider>
  );
}
