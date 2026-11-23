'use client';

import * as React from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';

import { focusFromKeyboard } from './keyboard-focus';

import { cn } from '@/lib/utils';

function TooltipProvider({ delayDuration = 0, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />;
}

interface TooltipScope {
  open: boolean;
  hidden: boolean;
  /** The content's text, when it is plain text: a closed tooltip keeps it for screen readers. */
  description: string | undefined;
  /** The rendered trigger and content, kept when Activity detaches refs from a hidden scope. */
  nodes: { trigger?: HTMLElement; content?: HTMLElement };
}
const TooltipScope = React.createContext<TooltipScope | null>(null);

/**
 * Focus the app moves opens no tooltip, and a screen reader moves focus without keys, so a closed tooltip whose content
 * is plain text keeps it on the trigger as `aria-description`. That costs no DOM node; an `aria-describedby` the
 * trigger has still wins. Content that is not plain text has no closed description.
 */
function contentText(children: React.ReactNode): string | undefined {
  let text: string | undefined;
  React.Children.forEach(children, (child) => {
    if (React.isValidElement<{ children?: React.ReactNode }>(child) && child.type === TooltipContent)
      text = plainText(child.props.children) ?? undefined;
  });
  return text?.replace(/\s+/g, ' ').trim() || undefined;
}

/** The text of strings and of plain elements around them; null when a component could render anything. */
function plainText(node: React.ReactNode): string | null {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) {
    const parts = node.map(plainText);
    return parts.some((part) => part === null) ? null : parts.join(' ');
  }
  if (React.isValidElement<{ children?: React.ReactNode }>(node) && typeof node.type === 'string')
    return plainText(node.props.children);
  return null;
}

/**
 * A tooltip closes when the window loses focus and when its trigger is hidden. Workspaces and the queue behind an
 * open PR stay mounted inside React <Activity>, which hides the trigger but not the portaled tooltip: an open tooltip
 * stayed painted after its control was gone, and with no trigger box to follow it sat in the window's top-left corner
 * over the macOS window buttons. Hiding an Activity destroys its layout effects, which is the signal used here. Rows
 * carry many tooltips, so a closed one adds no effects or listeners: `WhileOpen` watches only while it is open.
 */
function Tooltip({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultOpen);
  const open = openProp ?? uncontrolled;
  // Radix waits for an exit animation before removing the content, and that wait is an effect Activity has destroyed,
  // so a hidden scope renders no content at all.
  const [hidden, setHidden] = React.useState(false);
  // The open state this render asks for. A watcher removed while it is still true was not closed: its scope was
  // hidden, or the tooltip unmounted.
  const wanted = React.useRef(open);
  wanted.current = open;
  const description = React.useMemo(() => contentText(children), [children]);
  const [nodes] = React.useState<TooltipScope['nodes']>(() => ({}));
  const scope = React.useMemo(() => ({ open, hidden, description, nodes }), [open, hidden, description, nodes]);
  const change = React.useCallback(
    (next: boolean) => {
      if (openProp === undefined) setUncontrolled(next);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange]
  );
  return (
    <TooltipScope.Provider value={scope}>
      <TooltipPrimitive.Root data-slot="tooltip" open={open} onOpenChange={change} {...props}>
        {children}
      </TooltipPrimitive.Root>
      {open && <WhileOpen change={change} wanted={wanted} nodes={nodes} setHidden={setHidden} />}
    </TooltipScope.Provider>
  );
}

function WhileOpen({
  change,
  wanted,
  nodes,
  setHidden,
}: {
  change: (open: boolean) => void;
  wanted: React.RefObject<boolean>;
  nodes: TooltipScope['nodes'];
  setHidden: (hidden: boolean) => void;
}) {
  const latest = React.useRef(change);
  const watching = React.useRef(false);
  React.useLayoutEffect(() => {
    latest.current = change;
  });
  React.useLayoutEffect(() => {
    watching.current = true;
    // Shown again with the tooltip still open, as a controlled one can be.
    if (nodes.content) nodes.content.style.display = '';
    setHidden(false);
    return () => {
      watching.current = false;
      // The tooltip was closed: let it animate out.
      if (!wanted.current) return;
      // Hidden or unmounted while open. Hide the content in this commit, so it never paints without its trigger.
      if (nodes.content) nodes.content.style.display = 'none';
      queueMicrotask(() => {
        // StrictMode runs the effect again at once; an unmounted trigger has left the document.
        if (watching.current || !nodes.trigger?.isConnected) return;
        setHidden(true);
        latest.current(false);
      });
    };
  }, [wanted, nodes, setHidden]);
  React.useEffect(() => {
    const close = () => latest.current(false);
    window.addEventListener('blur', close);
    return () => window.removeEventListener('blur', close);
  }, []);
  return null;
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

function TooltipTrigger({
  onPointerMove,
  onFocus,
  ref,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  const scope = React.useContext(TooltipScope);
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      {...(scope && !scope.open && scope.description ? { 'aria-description': scope.description } : {})}
      ref={(node: HTMLButtonElement | null) => {
        if (node && scope) scope.nodes.trigger = node;
        if (typeof ref === 'function') return ref(node);
        if (ref) ref.current = node;
      }}
      onFocus={(event) => {
        // Radix skips its own handler when the event is default-prevented.
        if (!focusFromKeyboard()) event.preventDefault();
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
  ref,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  const scope = React.useContext(TooltipScope);
  if (scope?.hidden) return null;
  if (scope && !scope.open) return null;
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        ref={(node: HTMLDivElement | null) => {
          if (node && scope) scope.nodes.content = node;
          if (typeof ref === 'function') return ref(node);
          if (ref) ref.current = node;
        }}
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
