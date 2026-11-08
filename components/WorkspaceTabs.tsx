import { useEffect, useRef } from 'react';
import { Plus, X, Check, Inbox, RotateCcw, ArrowLeft, ArrowRight } from 'lucide-react';
import { SubjectIcon } from './SubjectIcon';
import { EntryActions } from './EntryActions';
import type { WorkspaceTabsState } from '../lib/workspace-tabs';

export function WorkspaceTabs({
  state,
  activate,
  close,
  open,
  reopen,
  move,
}: {
  state: WorkspaceTabsState;
  activate: (id: string) => void;
  close: (id: string) => void;
  open: () => void;
  reopen: () => void;
  move: (id: string, offset: number) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [state.active, state.tabs.length]);
  return (
    <nav className="workspace-tabs" aria-label="Open reviews">
      <div
        ref={list}
        className="workspace-tabs-list"
        role="tablist"
        aria-label="Open reviews"
        onWheel={(event) => {
          if (list.current && Math.abs(event.deltaY) > Math.abs(event.deltaX)) list.current.scrollLeft += event.deltaY;
        }}
      >
        {state.tabs.map((tab, index) => (
          <EntryActions
            key={tab.id}
            label={`Tab actions for ${tab.title}`}
            restoreFocus={false}
            groups={[
              [
                { label: 'Close tab', icon: <X size={15} />, run: () => close(tab.id) },
                {
                  label: 'Close other tabs',
                  disabled: state.tabs.length < 2,
                  run: () => state.tabs.filter((t) => t.id !== tab.id).forEach((t) => close(t.id)),
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
                  id={`workspace-tab-${tab.id}`}
                  aria-controls={`workspace-panel-${tab.id}`}
                  aria-selected={state.active === tab.id}
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
                            : (index + (event.key === 'ArrowRight' ? 1 : state.tabs.length - 1)) % state.tabs.length;
                      activate(state.tabs[next].id);
                      requestAnimationFrame(() =>
                        document.getElementById(`workspace-tab-${state.tabs[next].id}`)?.focus()
                      );
                    }
                  }}
                  title={`${tab.title}\n${[tab.label, tab.detail, tab.section].filter(Boolean).join(' · ')}`}
                >
                  {tab.label === 'Queue' || tab.label === 'View' ? (
                    <Inbox size={15} />
                  ) : (
                    <SubjectIcon kind={tab.label === 'Stack' ? 'stack' : 'pr'} />
                  )}
                  {tab.label.startsWith('#') && <span className="workspace-tab-number">{tab.label}</span>}
                  <span className="workspace-tab-title">{tab.title}</span>
                </button>
                <button
                  className="workspace-tab-close"
                  tabIndex={state.active === tab.id ? 0 : -1}
                  aria-label={`Close ${tab.title}`}
                  onClick={() => close(tab.id)}
                >
                  <X size={13} />
                </button>
              </div>
            )}
          </EntryActions>
        ))}
      </div>
      <button className="workspace-new-tab" aria-label="New tab" title="New tab (⌘T / Ctrl+T)" onClick={open}>
        <Plus size={16} />
      </button>
      <EntryActions
        label="Open tabs"
        buttonClassName="workspace-tab-menu"
        groups={[
          state.tabs.map((tab) => ({
            label: tab.title,
            detail: tab.label,
            icon: state.active === tab.id ? <Check size={15} /> : <span className="size-4" />,
            run: () => activate(tab.id),
          })),
          [{ label: 'Reopen closed tab', icon: <RotateCcw size={15} />, disabled: !state.closed.length, run: reopen }],
        ]}
      />
    </nav>
  );
}
