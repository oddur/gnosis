import { useWorkspaceNavigation } from '../lib/workspace-navigation';
import type { WorkspaceTarget } from '../lib/workspace-tabs';
import {
  cloneElement,
  type ReactElement,
  type ComponentProps,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type MouseEvent,
} from 'react';
import { useKeyboardShortcuts } from '../lib/use-keyboard-shortcuts';
import { Popover } from 'radix-ui';
import { Bookmark, ChevronRight, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from './ui/tooltip';

const storageKey = 'gnosis-sidebar-layout:v1';
type Section = 'reviews' | 'views' | 'tools';
interface Layout {
  collapsed: boolean;
  closed: Section[];
}
function restore(): Layout {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Partial<Layout> | null;
    return {
      collapsed: value?.collapsed === true,
      closed: Array.isArray(value?.closed)
        ? value.closed.filter((key) => ['reviews', 'views', 'tools'].includes(key))
        : [],
    };
  } catch {
    return { collapsed: false, closed: [] };
  }
}
function Group({
  name,
  label,
  open,
  current,
  toggle,
  children,
}: {
  name: Section;
  label: string;
  open: boolean;
  current?: string;
  toggle: () => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={`sidebar-group sidebar-group-${name}`}>
      <button className="sidebar-group-toggle" aria-expanded={open} aria-controls={id} onClick={toggle}>
        <span>{label}</span>
        <ChevronRight size={12} aria-hidden="true" />
        {!open && current && (
          <span className="sidebar-current" title={current}>
            {current}
          </span>
        )}
      </button>
      <div id={id} className="sidebar-group-items" hidden={!open}>
        {children}
      </div>
    </section>
  );
}

/** The same destination label is available on hover and keyboard focus. */
export function SidebarDestination({
  children,
  destination,
}: {
  children: ReactElement<ComponentProps<'button'>>;
  destination?: WorkspaceTarget;
}) {
  const tabs = useWorkspaceNavigation();
  const label = children.props['aria-label'];
  const detail = children.props.title;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {cloneElement(children, {
          title: undefined,
          onClick: (event) => {
            if (destination && tabs && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              tabs.open(destination, !event.shiftKey, typeof label === 'string' ? label : undefined);
            } else children.props.onClick?.(event);
          },
          onAuxClick: (event) => {
            if (event.button === 1 && destination && tabs) {
              event.preventDefault();
              tabs.open(destination, true, typeof label === 'string' ? label : undefined);
            } else children.props.onAuxClick?.(event);
          },
        })}
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} className="sidebar-destination-tooltip">
        <strong>{label}</strong>
        {detail && detail !== label && <span>{detail}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

/** Navigation layout is local UI state; opening or folding it never reloads the queue. */
export function QueueSidebar({
  reviews,
  views,
  tools,
  currentReview,
  currentView,
  currentTool,
}: {
  reviews: ReactNode;
  views?: ReactNode;
  tools: ReactNode;
  currentReview?: string;
  currentView?: string;
  currentTool?: string;
}) {
  const [layout, setLayout] = useState(restore);
  const latestLayout = useRef(layout);
  latestLayout.current = layout;
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 850px)').matches);
  const toggle = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const mac = window.electronAPI.platform === 'darwin';
  const shortcut = mac ? '⌘\\' : 'Ctrl+\\';
  useKeyboardShortcuts(
    {
      [mac ? 'cmd+\\' : 'ctrl+\\']: (event) => {
        if (event.repeat) return;
        if (sidebar.current?.contains(document.activeElement)) toggle.current?.focus();
        toggleSidebar();
      },
    },
    { scope: sidebar }
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  const [viewsOpen, setViewsOpen] = useState(false);
  const motion = useRef<{ animations: Animation[]; frame: number; pending: boolean | null }>({
    animations: [],
    frame: 0,
    pending: null,
  });
  function cancelMotion() {
    motion.current.animations.forEach((animation) => animation.cancel());
    cancelAnimationFrame(motion.current.frame);
    motion.current.animations = [];
    motion.current.pending = null;
  }
  useEffect(() => {
    cancelMotion();
    return cancelMotion;
  }, [narrow]);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 850px)');
    const update = () => {
      setNarrow(query.matches);
      setMobileOpen(false);
      setViewsOpen(false);
    };
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  function save(next: Layout) {
    latestLayout.current = next;
    setLayout(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* Optional layout preference. */
    }
  }
  function toggleSidebar() {
    if (narrow) {
      setMobileOpen((value) => !value);
      return;
    }
    const next = !(motion.current.pending ?? layout.collapsed);
    const nav = toggle.current?.closest('nav');
    const width = nav?.getBoundingClientRect().width ?? 232;
    cancelMotion();
    if (!nav || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      save({ ...latestLayout.current, collapsed: next });
      return;
    }
    motion.current.pending = next;
    const move = () => {
      motion.current.pending = null;
      save({ ...latestLayout.current, collapsed: next });
      motion.current.animations.push(
        nav.animate(
          [
            { width: `${width}px`, minWidth: `${width}px`, overflow: 'hidden' },
            { width: `${next ? 52 : 232}px`, minWidth: `${next ? 52 : 232}px`, overflow: 'hidden' },
          ],
          { duration: 220, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
        )
      );
      motion.current.frame = requestAnimationFrame(() => {
        const contents = nav.querySelector('.sidebar-scroll');
        if (contents)
          motion.current.animations.push(
            contents.animate(
              [
                { opacity: 0.35, transform: 'translateX(-6px)' },
                { opacity: 1, transform: 'translateX(0)' },
              ],
              { duration: 200, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
            )
          );
      });
    };
    const contents = nav.querySelector('.sidebar-scroll');
    if (!contents) {
      move();
      return;
    }
    const fade = contents.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, fill: 'forwards' });
    motion.current.animations.push(fade);
    void fade.finished
      .then(() => {
        fade.cancel();
        move();
      })
      .catch(() => {});
  }
  function toggleSection(section: Section) {
    save({
      ...layout,
      closed: layout.closed.includes(section)
        ? layout.closed.filter((key) => key !== section)
        : [...layout.closed, section],
    });
  }
  function closeAfterNavigation(event: MouseEvent) {
    if ((event.target as HTMLElement).closest('[data-sidebar-destination], .saved-view-link')) {
      setMobileOpen(false);
      setViewsOpen(false);
    }
  }
  const collapsed = narrow || layout.collapsed;
  const groups = (
    <>
      <Group
        name="reviews"
        label="Reviews"
        open={!layout.closed.includes('reviews')}
        current={currentReview}
        toggle={() => toggleSection('reviews')}
      >
        {reviews}
      </Group>
      {views && (
        <Group
          name="views"
          label="Saved views"
          open={!layout.closed.includes('views')}
          current={currentView}
          toggle={() => toggleSection('views')}
        >
          {views}
        </Group>
      )}
      <Group
        name="tools"
        label="Tools"
        open={!layout.closed.includes('tools')}
        current={currentTool}
        toggle={() => toggleSection('tools')}
      >
        {tools}
      </Group>
    </>
  );
  return (
    <TooltipProvider delayDuration={350}>
      <nav ref={sidebar} className="workbench-sidebar" aria-label="Workspace" data-collapsed={collapsed}>
        <Popover.Root open={mobileOpen} onOpenChange={setMobileOpen} modal>
          <div className="sidebar-toolbar">
            {!collapsed && <span>Workspace</span>}
            <Popover.Anchor asChild>
              <span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      ref={toggle}
                      className="sidebar-toggle"
                      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                      aria-expanded={!collapsed || mobileOpen}
                      aria-keyshortcuts={mac ? 'Meta+\\' : 'Control+\\'}
                      onClick={toggleSidebar}
                    >
                      {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {collapsed ? 'Expand sidebar' : 'Collapse sidebar'} <kbd>{shortcut}</kbd>
                  </TooltipContent>
                </Tooltip>
              </span>
            </Popover.Anchor>
          </div>
          <Popover.Portal>
            <Popover.Content
              className="sidebar-popup"
              side="right"
              align="start"
              sideOffset={12}
              collisionPadding={8}
              aria-label="Workspace navigation"
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                toggle.current?.focus();
              }}
              onClickCapture={closeAfterNavigation}
              onKeyDownCapture={(event) => {
                if (event.key === '\\' && (mac ? event.metaKey : event.ctrlKey) && !event.altKey && !event.shiftKey) {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!event.repeat) setMobileOpen(false);
                  return;
                }
                if (event.key === 'Escape' && event.currentTarget.contains(event.target as Node)) {
                  event.preventDefault();
                  event.stopPropagation();
                  setMobileOpen(false);
                }
              }}
            >
              <div className="sidebar-popup-heading">
                <strong>Workspace</strong>
                <Popover.Close aria-label="Close sidebar">
                  <PanelLeftClose size={16} />
                </Popover.Close>
              </div>
              {groups}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        <div className="sidebar-scroll">
          {collapsed ? (
            <>
              <div className="sidebar-rail-items">{reviews}</div>
              {views && (
                <Popover.Root open={viewsOpen} onOpenChange={setViewsOpen}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Popover.Trigger
                        className={`sidebar-views-trigger${currentView ? ' active' : ''}`}
                        aria-label="Saved views"
                      >
                        <Bookmark size={16} aria-hidden="true" />
                      </Popover.Trigger>
                    </TooltipTrigger>
                    <TooltipContent side="right">Saved views</TooltipContent>
                  </Tooltip>
                  <Popover.Portal>
                    <Popover.Content
                      className="sidebar-popup sidebar-views-popup"
                      side="right"
                      align="start"
                      sideOffset={12}
                      collisionPadding={8}
                      aria-label="Saved views"
                      onOpenAutoFocus={(event) => {
                        event.preventDefault();
                        requestAnimationFrame(() => {
                          const panel = document.querySelector('.sidebar-views-popup');
                          const destination =
                            panel?.querySelector<HTMLElement>('.saved-view-link[aria-current="page"]') ??
                            panel?.querySelector<HTMLElement>('.saved-view-link');
                          destination?.focus();
                        });
                      }}
                      onKeyDownCapture={(event) => {
                        if (event.key === 'Escape' && event.currentTarget.contains(event.target as Node)) {
                          event.preventDefault();
                          event.stopPropagation();
                          setViewsOpen(false);
                        }
                      }}
                      onClickCapture={closeAfterNavigation}
                    >
                      <div className="sidebar-popup-heading">
                        <strong>Saved views</strong>
                      </div>
                      {views}
                    </Popover.Content>
                  </Popover.Portal>
                </Popover.Root>
              )}
              <div className="sidebar-rail-items sidebar-rail-tools">{tools}</div>
            </>
          ) : (
            groups
          )}
        </div>
      </nav>
    </TooltipProvider>
  );
}
