import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { DropdownMenu } from 'radix-ui';
import { ChevronLeft, ChevronRight, CircleHelp, Inbox, Search, Settings, UserRound } from 'lucide-react';
import { RecentlyViewed } from './RecentlyViewed';
import { WorkbenchHelp } from './WorkbenchHelp';
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar';
import { GitHubIcon } from '../lib/constants';
import { effortLabels, effortLevels, normalizeEffort, type Effort } from '../lib/effort';
import { githubAvatarUrl, isGitHubLogin } from '../lib/github-profile';
import { PROVIDERS, type ModelId, type Provider } from '../lib/models';
import type { HistoryDirection } from '../lib/navigation-history';

/*
 * The window has one quiet title bar row: window controls, the active workspace's sidebar
 * toggle, history and Back/Forward, then the workspace tabs. Its empty space moves the window.
 * Each workspace keeps its own state and renders its controls through a portal into the row.
 *
 * Workspaces stay mounted inside React <Activity>, which does not hide portals. Every scope
 * (a workspace tab, the home or review page inside it, the queue behind an open PR) owns a slot
 * element whose `hidden` attribute its parent sets in the same commit as the switch. Only the
 * active scope's slot is visible, so exactly one set of controls is present, and it belongs to
 * the active workspace.
 */

interface TitlebarSlots {
  leading: HTMLElement | null;
  trailing: HTMLElement | null;
  active: boolean;
}
const TitlebarContext = createContext<TitlebarSlots>({ leading: null, trailing: null, active: false });

/** Provides the row's leading and trailing containers to the scopes below. */
export function TitlebarRoot({
  leading,
  trailing,
  children,
}: {
  leading: HTMLElement | null;
  trailing: HTMLElement | null;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ leading, trailing, active: true }), [leading, trailing]);
  return <TitlebarContext.Provider value={value}>{children}</TitlebarContext.Provider>;
}

/** Slots inside the parent's slots; hidden unless this scope and every scope above it is active. */
export function TitlebarScope({ active, children }: { active: boolean; children: ReactNode }) {
  const parent = useContext(TitlebarContext);
  const [leading, setLeading] = useState<HTMLElement | null>(null);
  const [trailing, setTrailing] = useState<HTMLElement | null>(null);
  const visible = parent.active && active;
  const value = useMemo(() => ({ leading, trailing, active: visible }), [leading, trailing, visible]);
  return (
    <>
      {parent.leading &&
        createPortal(<div ref={setLeading} className="app-titlebar-slot" hidden={!active} />, parent.leading)}
      {parent.trailing &&
        createPortal(<div ref={setTrailing} className="app-titlebar-slot" hidden={!active} />, parent.trailing)}
      <TitlebarContext.Provider value={value}>{children}</TitlebarContext.Provider>
    </>
  );
}

/** Renders into the row only while its scope is the visible one. */
export function TitlebarPortal({ side = 'leading', children }: { side?: 'leading' | 'trailing'; children: ReactNode }) {
  const slots = useContext(TitlebarContext);
  const target = slots[side];
  return slots.active && target ? createPortal(children, target) : null;
}

interface ObservableHistory {
  subscribe: (listener: () => void) => () => void;
  version: () => number;
  canMove: (direction: HistoryDirection) => boolean;
}

/** Recently viewed, then Back and Forward through this workspace's history. */
export function TitlebarHistory({
  history,
  move,
}: {
  history: ObservableHistory;
  move: (direction: HistoryDirection) => void;
}) {
  useSyncExternalStore(history.subscribe, history.version);
  const mac = window.electronAPI.platform === 'darwin';
  const back = mac ? '⌘[' : 'Alt+←';
  const forward = mac ? '⌘]' : 'Alt+→';
  return (
    <TitlebarPortal>
      <div className="app-titlebar-history">
        <RecentlyViewed />
        <button
          className="app-titlebar-button"
          aria-label="Back"
          title={`Back (${back})`}
          aria-keyshortcuts={mac ? 'Meta+[' : 'Alt+ArrowLeft'}
          disabled={!history.canMove(-1)}
          onClick={() => move(-1)}
        >
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <button
          className="app-titlebar-button"
          aria-label="Forward"
          title={`Forward (${forward})`}
          aria-keyshortcuts={mac ? 'Meta+]' : 'Alt+ArrowRight'}
          disabled={!history.canMove(1)}
          onClick={() => move(1)}
        >
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
    </TitlebarPortal>
  );
}

export interface WorkspaceMenuModel {
  provider: Provider;
  model: ModelId;
  effort: Effort;
  onChange: (selection: { provider: Provider; model: ModelId; effort: Effort }) => void;
}

/**
 * Search and the account menu, at the end of the title bar row on every screen. Each workspace
 * page renders its own, with its own actions; only the visible page's pair is shown.
 */
export function WorkspaceMenu({
  onHome,
  model,
  onSearch,
  onGettingStarted,
  onWalkthrough,
  onSettings,
  account,
}: {
  onHome: () => void;
  model?: WorkspaceMenuModel;
  onSearch: () => void;
  onGettingStarted?: () => void;
  onWalkthrough?: () => void;
  onSettings: () => void;
  account: { login?: string | null; onClick: () => void };
}) {
  const mac = window.electronAPI.platform === 'darwin';
  const [helpOpen, setHelpOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // Help opens once the menu has returned focus, so that focus change does not dismiss it.
  const helpPending = useRef(false);
  const login = account.login && isGitHubLogin(account.login) ? account.login : null;
  const modelLabel = model && PROVIDERS[model.provider].models.find((m) => m.id === model.model)?.label;
  const effort = model && normalizeEffort(model.provider, model.model, model.effort);
  const avatar = login ? (
    <Avatar size="sm" className="workspace-menu-avatar">
      <AvatarImage src={githubAvatarUrl(login)} alt="" referrerPolicy="no-referrer" />
      <AvatarFallback>{login.slice(0, 2).toUpperCase()}</AvatarFallback>
    </Avatar>
  ) : (
    <span className="workspace-menu-avatar workspace-menu-avatar-empty" aria-hidden="true">
      <UserRound size={14} />
    </span>
  );
  return (
    <TitlebarPortal side="trailing">
      <div className="workspace-menu">
        <button
          className="workspace-menu-search app-titlebar-button"
          onClick={onSearch}
          aria-label="Search"
          aria-keyshortcuts={mac ? 'Meta+K' : 'Control+K'}
          title={`Search and navigate (${mac ? '⌘K' : 'Ctrl K'})`}
        >
          <Search size={15} aria-hidden="true" />
        </button>
        <DropdownMenu.Root>
          <WorkbenchHelp
            open={helpOpen}
            onOpenChange={(open) => {
              setHelpOpen(open);
              if (!open) requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
            }}
            onGettingStarted={onGettingStarted}
            onWalkthrough={onWalkthrough}
            anchor={
              <DropdownMenu.Trigger asChild>
                <button
                  ref={trigger}
                  className="workspace-menu-trigger"
                  aria-label={login ? `Gnosis menu · GitHub account: ${login}` : 'Gnosis menu · GitHub not connected'}
                  title={login ? `Gnosis · ${login}` : 'Gnosis'}
                >
                  {avatar}
                </button>
              </DropdownMenu.Trigger>
            }
          />
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="workspace-menu-popup"
              align="end"
              sideOffset={6}
              collisionPadding={12}
              loop
              onCloseAutoFocus={(event) => {
                if (!helpPending.current) return;
                helpPending.current = false;
                event.preventDefault();
                setHelpOpen(true);
              }}
            >
              <DropdownMenu.Item className="workspace-menu-item" onSelect={onHome}>
                <Inbox size={15} aria-hidden="true" />
                <span>Review queue</span>
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="workspace-menu-separator" />
              <DropdownMenu.Item className="workspace-menu-item" data-github-account onSelect={account.onClick}>
                <GitHubIcon width={15} height={15} />
                <span>{login ? 'GitHub account' : 'Connect GitHub'}</span>
                {login && <span className="workspace-menu-detail">{login}</span>}
              </DropdownMenu.Item>
              {model && modelLabel && effort && (
                <DropdownMenu.Sub>
                  <DropdownMenu.SubTrigger className="workspace-menu-item" aria-label="Review model">
                    <span className="workspace-menu-icon" aria-hidden="true" />
                    <span>Model</span>
                    <span className="workspace-menu-detail">
                      {modelLabel} · {effortLabels[effort]}
                    </span>
                    <ChevronRight size={14} aria-hidden="true" />
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.SubContent className="workspace-menu-popup" sideOffset={4} collisionPadding={12}>
                      {Object.entries(PROVIDERS).map(([provider, group]) => (
                        <DropdownMenu.Group key={provider}>
                          <DropdownMenu.Label className="workspace-menu-label">{group.label}</DropdownMenu.Label>
                          <DropdownMenu.RadioGroup
                            value={model.provider === provider ? model.model : ''}
                            onValueChange={(value) => {
                              const next = value as ModelId;
                              model.onChange({
                                provider: provider as Provider,
                                model: next,
                                effort: normalizeEffort(provider as Provider, next, effort),
                              });
                            }}
                          >
                            {group.models.map((m) => (
                              <DropdownMenu.RadioItem
                                key={m.id}
                                value={m.id}
                                data-model={m.id}
                                className="workspace-menu-item"
                                onSelect={(event) => event.preventDefault()}
                              >
                                <DropdownMenu.ItemIndicator className="workspace-menu-check">
                                  ✓
                                </DropdownMenu.ItemIndicator>
                                <span>{m.label}</span>
                              </DropdownMenu.RadioItem>
                            ))}
                          </DropdownMenu.RadioGroup>
                        </DropdownMenu.Group>
                      ))}
                      <DropdownMenu.Separator className="workspace-menu-separator" />
                      <DropdownMenu.Label className="workspace-menu-label">Reasoning effort</DropdownMenu.Label>
                      <DropdownMenu.RadioGroup
                        value={effort}
                        onValueChange={(value) =>
                          model.onChange({ provider: model.provider, model: model.model, effort: value as Effort })
                        }
                      >
                        {effortLevels(model.provider, model.model).map((level) => (
                          <DropdownMenu.RadioItem
                            key={level}
                            value={level}
                            data-effort={level}
                            className="workspace-menu-item"
                            onSelect={(event) => event.preventDefault()}
                          >
                            <DropdownMenu.ItemIndicator className="workspace-menu-check">✓</DropdownMenu.ItemIndicator>
                            <span>{effortLabels[level]}</span>
                          </DropdownMenu.RadioItem>
                        ))}
                      </DropdownMenu.RadioGroup>
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Portal>
                </DropdownMenu.Sub>
              )}
              <DropdownMenu.Item className="workspace-menu-item" aria-label="Settings" onSelect={onSettings}>
                <Settings size={15} aria-hidden="true" />
                <span>Settings</span>
                <kbd className="workspace-menu-shortcut">{mac ? '⌘,' : 'Ctrl+,'}</kbd>
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="workspace-menu-separator" />
              <DropdownMenu.Item
                className="workspace-menu-item"
                aria-label="Help and terminology"
                onSelect={() => {
                  helpPending.current = true;
                }}
              >
                <CircleHelp size={15} aria-hidden="true" />
                <span>Help and terminology</span>
              </DropdownMenu.Item>
              {onGettingStarted && (
                <DropdownMenu.Item className="workspace-menu-item" onSelect={onGettingStarted}>
                  <span className="workspace-menu-icon" aria-hidden="true" />
                  <span>Run setup again</span>
                </DropdownMenu.Item>
              )}
              {onWalkthrough && (
                <DropdownMenu.Item className="workspace-menu-item" onSelect={onWalkthrough}>
                  <span className="workspace-menu-icon" aria-hidden="true" />
                  <span>Show walkthrough</span>
                </DropdownMenu.Item>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </TitlebarPortal>
  );
}

/** Marks the document with the platform and full-screen state the row's CSS reserves space for. */
export function useWindowChrome() {
  const [fullScreen, setFullScreen] = useState(false);
  const update = useCallback((value: boolean) => setFullScreen(value), []);
  useEffect(() => {
    document.documentElement.dataset.platform = window.electronAPI.platform;
    let live = true;
    void window.electronAPI
      .isFullScreen?.()
      .then((value) => {
        if (live) update(value);
      })
      .catch(() => {});
    const stop = window.electronAPI.onFullScreenChange?.(update);
    return () => {
      live = false;
      stop?.();
    };
  }, [update]);
  useEffect(() => {
    document.documentElement.toggleAttribute('data-full-screen', fullScreen);
  }, [fullScreen]);
}
