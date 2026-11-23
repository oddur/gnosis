'use client';

import * as React from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

function TooltipProvider({ delayDuration = 0, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />;
}

const TooltipHidden = React.createContext(false);

/**
 * A tooltip closes when the window loses focus and when its trigger is hidden. Workspaces and the queue behind an
 * open PR stay mounted inside React <Activity>, which hides the trigger but not the portaled tooltip: an open tooltip
 * stayed painted after its control was gone, and with no trigger box to follow it sat in the window's top-left corner
 * over the macOS window buttons. Hiding an Activity destroys its layout effects, which is the signal used here.
 */
function Tooltip({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultOpen);
  const open = openProp ?? uncontrolled;
  const change = React.useCallback(
    (next: boolean) => {
      if (openProp === undefined) setUncontrolled(next);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange]
  );
  // Radix waits for an exit animation before removing the content, and that wait is an effect Activity has destroyed,
  // so a hidden scope renders no content at all.
  const [hidden, setHidden] = React.useState(false);
  const latest = React.useRef({ open, change });
  React.useLayoutEffect(() => {
    latest.current = { open, change };
  });
  React.useLayoutEffect(() => {
    setHidden(false);
    return () => {
      if (!latest.current.open) return;
      setHidden(true);
      latest.current.change(false);
    };
  }, []);
  React.useEffect(() => {
    if (!open) return;
    const close = () => latest.current.change(false);
    window.addEventListener('blur', close);
    return () => window.removeEventListener('blur', close);
  }, [open]);
  return (
    <TooltipHidden.Provider value={hidden}>
      <TooltipPrimitive.Root data-slot="tooltip" open={open} onOpenChange={change} {...props} />
    </TooltipHidden.Provider>
  );
}

/**
 * Chromium sends a pointer move with no movement when content changes under a still cursor, such as a new tab or page
 * opening where the pointer rests. Radix opens a tooltip on any pointer move, so a preview appeared that nobody asked
 * for (opening a PR from the Overview showed the new page's PR preview in its top-left). Only a pointer that moved opens
 * one. "Moved" is judged by position as well as `movementX/Y`: synthesized input, such as Electron's `sendInputEvent`
 * and some remote-desktop pointers, reports no movement even when the pointer has gone somewhere new.
 */
const stationaryMoves = new WeakSet<Event>();
let lastPointer: { x: number; y: number } | undefined;
/**
 * Radix also opens a tooltip on any focus, including focus the app moves: a dialog or menu returning it, a closed tab
 * handing it on, or the window getting it back on activation. Only focus the keyboard moved opens one, that is focus
 * after Tab, Shift+Tab or an arrow-style key. A shortcut (Cmd+W, Cmd+1), Escape, Enter, a press or leaving the window
 * resets it.
 */
const navigationKeys = new Set([
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);
let keyboardNavigation = false;
if (typeof window !== 'undefined') {
  window.addEventListener(
    'keydown',
    (event) => {
      keyboardNavigation = navigationKeys.has(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey;
    },
    { capture: true, passive: true }
  );
  window.addEventListener('pointerdown', () => (keyboardNavigation = false), { capture: true, passive: true });
  window.addEventListener('blur', () => (keyboardNavigation = false));
}
if (typeof window !== 'undefined') {
  const record = (event: PointerEvent) => {
    if (
      event.type === 'pointermove' &&
      lastPointer &&
      lastPointer.x === event.clientX &&
      lastPointer.y === event.clientY
    )
      stationaryMoves.add(event);
    lastPointer = { x: event.clientX, y: event.clientY };
  };
  // Capture on the window runs before React's root listener, so the trigger below sees this event's verdict.
  window.addEventListener('pointermove', record, { capture: true, passive: true });
  window.addEventListener('pointerdown', record, { capture: true, passive: true });
}

function TooltipTrigger({ onPointerMove, onFocus, ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      onFocus={(event) => {
        // Radix skips its own handler when the event is default-prevented.
        if (!keyboardNavigation) event.preventDefault();
        onFocus?.(event);
      }}
      onPointerMove={(event) => {
        // Radix skips its own handler when the event is default-prevented.
        if (
          event.pointerType === 'mouse' &&
          event.movementX === 0 &&
          event.movementY === 0 &&
          stationaryMoves.has(event.nativeEvent)
        )
          event.preventDefault();
        onPointerMove?.(event);
      }}
      {...props}
    />
  );
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  if (React.useContext(TooltipHidden)) return null;
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'bg-foreground text-background animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-fit origin-(--radix-tooltip-content-transform-origin) rounded-md px-3 py-1.5 text-xs text-balance',
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="bg-foreground fill-foreground z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px]" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

/** Moves focus to a tooltip's trigger and shows the tooltip, for an action that asks to show it, such as "All keys". */
function focusWithTooltip(element: HTMLElement | null | undefined) {
  keyboardNavigation = true;
  element?.focus();
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, focusWithTooltip };
