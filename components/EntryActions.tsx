import { setEntryMenuOpen } from '../lib/entry-menu-state';
import { useId, useRef, useState, useLayoutEffect, type ReactElement, type ReactNode } from 'react';
import { Menu } from '@base-ui/react/menu';
import { flushSync } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from './ui/context-menu';
import { toast } from './ui/toast';

export interface EntryAction {
  label: string;
  displayLabel?: string;
  detail?: string;
  icon?: ReactNode;
  disabled?: boolean;
  destructive?: boolean;
  /** Remove the popup before an action hides its workspace. */
  dismissBeforeRun?: boolean;
  run: () => unknown;
}
export type EntryActionGroups = EntryAction[][];

/** A single action catalog for right-click, keyboard, and the visible overflow button. */
export function EntryActions({
  label,
  groups,
  children,
  restoreFocus = true,
  buttonClassName = '',
  description,
  onBeforeOpen,
  contextOnly = false,
  triggerIcon,
  triggerTitle,
  popupClassName = '',
}: {
  label: string;
  groups: EntryActionGroups;
  children?: (button: ReactNode) => ReactElement;
  restoreFocus?: boolean;
  buttonClassName?: string;
  description?: ReactNode;
  onBeforeOpen?: () => void;
  contextOnly?: boolean;
  triggerIcon?: ReactNode;
  triggerTitle?: string;
  popupClassName?: string;
}) {
  const descriptionId = useId();
  const explanation = description ? (
    <div id={descriptionId} className="entry-menu-description">
      {description}
    </div>
  ) : null;
  const trigger = useRef<HTMLButtonElement>(null);
  const contextOrigin = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef(restoreFocus);
  restoreFocusRef.current = restoreFocus;
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const contextActions = useRef<Menu.Root.Actions | null>(null);
  const menuActions = useRef<Menu.Root.Actions | null>(null);
  // A menu revealed by Activity can keep stale internal state and stop opening from the keyboard.
  // Layout effects run again when content is shown, so give the menu a fresh root each time.
  const [shownCount, setShownCount] = useState(0);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    if (mounted.current) setShownCount((count) => count + 1);
    mounted.current = true;
  }, []);
  const menuId = useRef(Symbol('entry-menu'));
  useLayoutEffect(() => {
    const id = menuId.current;
    setEntryMenuOpen(id, menuOpen || contextOpen);
    return () => setEntryMenuOpen(id, false);
  }, [menuOpen, contextOpen]);
  const items = groups
    .filter((group) => group.length)
    .map((group, index) => (
      <Menu.Group key={index}>
        {index > 0 && <Menu.Separator className="entry-menu-separator" />}
        {group.map((action) => (
          <Menu.Item
            key={action.label}
            className="entry-menu-item"
            aria-label={action.label}
            disabled={pending || action.disabled}
            data-destructive={action.destructive || undefined}
            onClick={() => {
              if (busy.current) return;
              busy.current = true;
              // Navigation can hide this workspace and pause menu cleanup effects.
              // Commit dismissal while the source workspace is still active.
              if (action.dismissBeforeRun) {
                flushSync(() => {
                  setContextOpen(false);
                  setMenuOpen(false);
                });
                // Base UI must observe closed state before completing the closing phase.
                flushSync(() => {
                  contextActions.current?.unmount();
                  menuActions.current?.unmount();
                });
              }
              setPending(true);
              void (async () => {
                try {
                  await action.run();
                } catch (error: unknown) {
                  toast.add({
                    type: 'error',
                    title: `Could not ${action.label.toLowerCase()}`,
                    description: error instanceof Error ? error.message : String(error),
                  });
                } finally {
                  busy.current = false;
                  setPending(false);
                }
              })();
            }}
          >
            {action.icon && (
              <span className="entry-menu-icon" aria-hidden="true">
                {action.icon}
              </span>
            )}
            <span className="entry-menu-label">{action.displayLabel ?? action.label}</span>
            {action.detail && (
              <span className="entry-menu-detail" aria-hidden="true">
                {action.detail}
              </span>
            )}
          </Menu.Item>
        ))}
      </Menu.Group>
    ));
  const popupProps = {
    className: `entry-menu ${popupClassName}`,
    'aria-label': label,
    'aria-describedby': description ? descriptionId : undefined,
    'data-queue-id': trigger.current?.closest<HTMLElement>('[data-queue-id]')?.dataset.queueId,
    finalFocus: () => {
      const origin = trigger.current ?? contextOrigin.current;
      return restoreFocusRef.current && origin?.isConnected ? origin : false;
    },
    onClick: (event: React.MouseEvent) => event.stopPropagation(),
    onDoubleClick: (event: React.MouseEvent) => event.stopPropagation(),
    onContextMenu: (event: React.MouseEvent) => event.stopPropagation(),
    onKeyDown: (event: React.KeyboardEvent) => event.stopPropagation(),
  };
  const button = (
    <Menu.Root
      key={shownCount}
      actionsRef={menuActions}
      open={menuOpen}
      onOpenChange={(open) => {
        if (open) onBeforeOpen?.();
        setMenuOpen(open);
      }}
    >
      <Menu.Trigger
        ref={trigger}
        className={`pr-star-button entry-menu-trigger ${buttonClassName}`}
        aria-label={label}
        title={triggerTitle ?? 'More actions · right-click an entry'}
        onClick={(event) => event.stopPropagation()}
      >
        {triggerIcon ?? <MoreHorizontal size={16} aria-hidden="true" />}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="entry-menu-positioner" sideOffset={4} align="end" collisionPadding={12}>
          <Menu.Popup {...popupProps}>
            {explanation}
            {items}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
  if (!children) return button;
  return (
    <ContextMenu
      actionsRef={contextActions}
      open={contextOpen}
      onOpenChange={(open) => {
        if (open) onBeforeOpen?.();
        setContextOpen(open);
      }}
    >
      <ContextMenuTrigger
        render={children(button)}
        onContextMenu={(event) => {
          contextOrigin.current = event.currentTarget.querySelector<HTMLElement>('[role="tab"]') ?? event.currentTarget;
          event.stopPropagation();
        }}
        onKeyDown={(event) => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            event.stopPropagation();
            if (contextOnly) {
              const origin = event.target as HTMLElement;
              const rect = origin.getBoundingClientRect();
              origin.dispatchEvent(
                new MouseEvent('contextmenu', {
                  bubbles: true,
                  cancelable: true,
                  button: 2,
                  clientX: rect.left + 12,
                  clientY: rect.bottom,
                })
              );
              return;
            }
            onBeforeOpen?.();
            setContextOpen(false);
            setMenuOpen(true);
          }
        }}
      />
      <ContextMenuContent {...popupProps}>
        {explanation}
        {items}
      </ContextMenuContent>
    </ContextMenu>
  );
}
