import { memo, useEffect, useRef } from 'react';
import {
  Plus,
  X,
  Check,
  Inbox,
  RotateCcw,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  LoaderCircle,
  TriangleAlert,
} from 'lucide-react';
import { SubjectIcon } from './SubjectIcon';
import { EntryActions } from './EntryActions';
import { sameTabChrome, workspaceTabDescription, type WorkspaceTabsState } from '../lib/workspace-tabs';

import { workspaceTabTitle, type WorkspaceListingCount } from '../lib/workspace-listings';
import { useWorkspaceTabDrag } from '../lib/use-workspace-tab-drag';

/** The PR number shown before a tab's title; narrow tabs hide it, so names and tooltips repeat it. */
const tabNumber = (tab: WorkspaceTabsState['tabs'][number]) =>
  tab.label.startsWith('#') && tab.title !== `PR ${tab.label}` ? `${tab.label} ` : '';

export const WorkspaceTabs = memo(
  function WorkspaceTabs({
    state,
    listings,
    activate,
    close,
    open,
    reopen,
    move,
    closeOthers,
    leadingRef,
    trailingRef,
  }: {
    state: WorkspaceTabsState;
    listings: Record<string, WorkspaceListingCount | undefined>;
    activate: (id: string) => void;
    close: (id: string) => void;
    open: () => void;
    reopen: () => void;
    move: (id: string, offset: number) => void;
    closeOthers: (id: string) => void;
    /** Container for the active workspace's sidebar toggle, history and Back/Forward. */
    leadingRef: (node: HTMLDivElement | null) => void;
    /** Container for the active workspace's Search and account menu. */
    trailingRef: (node: HTMLDivElement | null) => void;
  }) {
    const list = useRef<HTMLDivElement>(null);
    const drag = useWorkspaceTabDrag(list, state.tabs, move);
    const modifier = window.electronAPI.platform === 'darwin' ? '⌘' : 'Ctrl+';
    useEffect(() => {
      list.current
        ?.querySelector('[aria-selected=true]')
        ?.closest('.workspace-tab')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [state.active, state.tabs.length]);
    // Fades a clipped edge when tabs scroll, so the last visible title does not run into New tab.
    useEffect(() => {
      const node = list.current;
      if (!node) return;
      const update = () => {
        const start = node.scrollLeft > 4;
        const end = node.scrollLeft + node.clientWidth < node.scrollWidth - 4;
        const overflow = start && end ? 'both' : start ? 'start' : end ? 'end' : '';
        if (overflow) node.dataset.overflow = overflow;
        else delete node.dataset.overflow;
      };
      update();
      // A narrower strip keeps the active tab in view.
      const observer = new ResizeObserver(() => {
        node
          .querySelector('[aria-selected=true]')
          ?.closest('.workspace-tab')
          ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        update();
      });
      observer.observe(node);
      node.addEventListener('scroll', update, { passive: true });
      return () => {
        observer.disconnect();
        node.removeEventListener('scroll', update);
      };
    }, [state.tabs.length]);
    return (
      // One row holds the window controls, tabs and header controls; its empty space moves the window.
      <header className="app-titlebar">
        <div ref={leadingRef} className="app-titlebar-leading" />
        <nav className="workspace-tabs" aria-label="Open reviews">
          <div
            ref={list}
            className="workspace-tabs-list"
            role="tablist"
            aria-label="Open reviews"
            onDragOver={drag.over}
            onDragLeave={drag.leave}
            onDrop={drag.drop}
            onWheel={(event) => {
              if (list.current && Math.abs(event.deltaY) > Math.abs(event.deltaX))
                list.current.scrollLeft += event.deltaY;
            }}
          >
            {state.tabs.map((tab, index) => (
              <EntryActions
                key={tab.id}
                label={`Tab actions for ${tab.title}`}
                contextOnly
                groups={[
                  [
                    { label: 'Close tab', icon: <X size={15} />, run: () => close(tab.id) },
                    {
                      label: 'Close other tabs',
                      disabled: state.tabs.length < 2,
                      run: () => closeOthers(tab.id),
                    },
                  ],
                  [
                    {
                      label: 'Move tab left',
                      icon: <ArrowLeft size={15} />,
                      disabled: index === 0,
                      run: () => move(tab.id, -1),
                    },
                    {
                      label: 'Move tab right',
                      icon: <ArrowRight size={15} />,
                      disabled: index === state.tabs.length - 1,
                      run: () => move(tab.id, 1),
                    },
                  ],
                  [
                    {
                      label: 'Reopen closed tab',
                      icon: <RotateCcw size={15} />,
                      disabled: !state.closed.length,
                      run: reopen,
                    },
                  ],
                ]}
              >
                {() => (
                  <div
                    className="workspace-tab"
                    data-active={state.active === tab.id}
                    data-tab-id={tab.id}
                    data-unread={listings[tab.id]?.unread || undefined}
                    data-dragging={drag.dragging === tab.id || undefined}
                    data-drop-before={drag.before === tab.id || undefined}
                    data-drop-after={(drag.before === null && index === state.tabs.length - 1) || undefined}
                    onAuxClick={(event) => {
                      if (event.button === 1) {
                        event.preventDefault();
                        close(tab.id);
                      }
                    }}
                  >
                    <button
                      className="workspace-tab-select"
                      role="tab"
                      draggable
                      onDragStart={(event) => drag.start(event, tab.id)}
                      onDragEnd={drag.end}
                      id={`workspace-tab-${tab.id}`}
                      aria-controls={`workspace-panel-${tab.id}`}
                      aria-selected={state.active === tab.id}
                      aria-busy={tab.status === 'opening' || undefined}
                      aria-label={`${tabNumber(tab)}${workspaceTabTitle(tab, listings[tab.id])}${listings[tab.id]?.unread ? ' · Unread PRs' : ''} · ${workspaceTabDescription(tab)}${tab.status === 'error' ? ' · Could not open' : ''}`}
                      aria-keyshortcuts={
                        index < 8
                          ? `${window.electronAPI.platform === 'darwin' ? 'Meta' : 'Control'}+${index + 1}`
                          : undefined
                      }
                      tabIndex={state.active === tab.id ? 0 : -1}
                      onClick={() => activate(tab.id)}
                      onKeyDown={(event) => {
                        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                          event.preventDefault();
                          const next =
                            event.key === 'Home'
                              ? 0
                              : event.key === 'End'
                                ? state.tabs.length - 1
                                : (index + (event.key === 'ArrowRight' ? 1 : state.tabs.length - 1)) %
                                  state.tabs.length;
                          activate(state.tabs[next].id);
                          requestAnimationFrame(() =>
                            document.getElementById(`workspace-tab-${state.tabs[next].id}`)?.focus()
                          );
                        }
                      }}
                      title={`${tabNumber(tab)}${workspaceTabTitle(tab, listings[tab.id])}\n${workspaceTabDescription(tab)}${tab.status === 'error' ? '\nCould not open. Select this tab to retry.' : ''}`}
                    >
                      {tab.status === 'opening' ? (
                        <LoaderCircle className="workspace-tab-spinner" aria-hidden="true" />
                      ) : tab.status === 'error' ? (
                        <TriangleAlert className="workspace-tab-error" aria-hidden="true" />
                      ) : tab.label === 'Queue' || tab.label === 'View' ? (
                        <Inbox size={15} />
                      ) : (
                        <SubjectIcon kind={tab.label === 'Stack' ? 'stack' : 'pr'} />
                      )}
                      {tabNumber(tab) && <span className="workspace-tab-number">{tab.label}</span>}
                      <span className="workspace-tab-title" dir="auto">
                        {tab.title}
                      </span>
                      {listings[tab.id] && <span className="workspace-tab-count">({listings[tab.id]?.count})</span>}
                    </button>
                    <button
                      className="workspace-tab-close"
                      tabIndex={state.active === tab.id ? 0 : -1}
                      aria-label={`Close ${tab.title}`}
                      title={`Close tab (${modifier}W)`}
                      onClick={() => close(tab.id)}
                    >
                      <X size={13} />
                    </button>
                  </div>
                )}
              </EntryActions>
            ))}
          </div>
          <span className="sr-only" role="status">
            {drag.announcement}
          </span>
          <button
            className="workspace-new-tab"
            aria-label="New tab"
            title={`New tab (${modifier}T)\n${modifier === '⌘' ? '⌘' : 'Ctrl+'}click a PR to keep it open`}
            onClick={open}
          >
            <Plus size={16} />
          </button>
          <EntryActions
            label="Open tabs"
            triggerIcon={<ChevronDown size={16} aria-hidden="true" />}
            triggerTitle={`Open tabs (${state.tabs.length})`}
            popupClassName="workspace-open-tabs-menu"
            description={
              <span>
                Switch tabs with <kbd>Ctrl+Tab</kbd>. Drag tabs to reorder. Right-click for more actions.
              </span>
            }
            buttonClassName="workspace-tab-menu"
            groups={[
              state.tabs.map((tab, index) => ({
                label: `Tab ${index + 1}: ${workspaceTabTitle(tab, listings[tab.id])}`,
                displayLabel: workspaceTabTitle(tab, listings[tab.id]),
                detail: workspaceTabDescription(tab),
                icon: state.active === tab.id ? <Check size={15} /> : <span className="size-4" />,
                run: () => activate(tab.id),
              })),
              [
                {
                  label: 'Reopen closed tab',
                  icon: <RotateCcw size={15} />,
                  disabled: !state.closed.length,
                  run: reopen,
                },
              ],
            ]}
          />
        </nav>
        {/* Electron applies drag regions in document order. Tabs scrolled out of view still report
            their boxes, so the drag areas after them restore the window-control padding and the
            reserved zone after New tab. */}
        <div className="app-titlebar-window-controls" aria-hidden="true" />
        <div className="app-titlebar-drag" aria-hidden="true" />
        <div ref={trailingRef} className="app-titlebar-trailing" />
      </header>
    );
  },
  (previous, next) =>
    sameTabChrome(previous.state, next.state) &&
    previous.listings === next.listings &&
    previous.activate === next.activate &&
    previous.close === next.close &&
    previous.open === next.open &&
    previous.reopen === next.reopen &&
    previous.move === next.move &&
    previous.closeOthers === next.closeOthers &&
    previous.leadingRef === next.leadingRef &&
    previous.trailingRef === next.trailingRef
);
