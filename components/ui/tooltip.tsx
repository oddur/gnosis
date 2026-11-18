'use client';

import * as React from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

function TooltipProvider({ delayDuration = 0, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />;
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
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
if (typeof window !== 'undefined') {
  const record = (event: PointerEvent) => {
    if (event.type === 'pointermove' && lastPointer && lastPointer.x === event.clientX && lastPointer.y === event.clientY)
      stationaryMoves.add(event);
    lastPointer = { x: event.clientX, y: event.clientY };
  };
  // Capture on the window runs before React's root listener, so the trigger below sees this event's verdict.
  window.addEventListener('pointermove', record, { capture: true, passive: true });
  window.addEventListener('pointerdown', record, { capture: true, passive: true });
}

function TooltipTrigger({ onPointerMove, ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
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

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
