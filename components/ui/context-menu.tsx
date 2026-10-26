import { ContextMenu as Primitive } from '@base-ui/react/context-menu';
import type { ComponentProps } from 'react';

// Shadcn Base UI composition, using Gnosis menu tokens.
export const ContextMenu = Primitive.Root;
export const ContextMenuTrigger = Primitive.Trigger;
export const ContextMenuItem = Primitive.Item;
export const ContextMenuSeparator = Primitive.Separator;
export function ContextMenuContent({ children, ...props }: ComponentProps<typeof Primitive.Popup>) {
  return (
    <Primitive.Portal>
      <Primitive.Positioner className="entry-menu-positioner" sideOffset={4} collisionPadding={12}>
        <Primitive.Popup className="entry-menu" {...props}>
          {children}
        </Primitive.Popup>
      </Primitive.Positioner>
    </Primitive.Portal>
  );
}
