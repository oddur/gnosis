'use client';

// Shadcn Base UI combobox parts, styled with the workbench's existing tokens.
// https://ui.shadcn.com/docs/components/base/combobox
import { Combobox as ComboboxPrimitive } from '@base-ui/react/combobox';
import { Check, ChevronDown, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Keep popups within modal focus boundaries. Overlays can opt in or pass through explicitly. */
export function findComboboxContainer(trigger: HTMLElement | null): HTMLElement | null {
  for (let element = trigger?.parentElement; element; element = element.parentElement) {
    const boundary = element.getAttribute('data-combobox-container');
    if (boundary === 'inside' || (element.getAttribute('role') === 'dialog' && boundary !== 'outside')) return element;
  }
  return null;
}

const Combobox = ComboboxPrimitive.Root;
const ComboboxValue = ComboboxPrimitive.Value;

function ComboboxTrigger({ className, children, ...props }: ComboboxPrimitive.Trigger.Props) {
  return (
    <ComboboxPrimitive.Trigger data-slot="combobox-trigger" className={cn('selection-trigger', className)} {...props}>
      <span className="selection-value">{children}</span>
      <ChevronDown size={14} aria-hidden="true" />
    </ComboboxPrimitive.Trigger>
  );
}

function ComboboxInput({ className, ...props }: ComboboxPrimitive.Input.Props) {
  return (
    <div className="selection-search">
      <Search size={15} aria-hidden="true" />
      <ComboboxPrimitive.Input data-slot="combobox-input" className={cn('selection-input', className)} {...props} />
    </div>
  );
}

function ComboboxContent({
  className,
  container,
  collisionBoundary,
  ...props
}: ComboboxPrimitive.Popup.Props & { container?: HTMLElement | null; collisionBoundary?: ComboboxPrimitive.Positioner.Props['collisionBoundary'] }) {
  return (
    <ComboboxPrimitive.Portal container={container ?? undefined}>
      <ComboboxPrimitive.Positioner
        sideOffset={4}
        align="start"
        positionMethod="fixed"
        collisionBoundary={collisionBoundary ?? container ?? undefined}
        collisionPadding={8}
        className="selection-positioner"
      >
        <ComboboxPrimitive.Popup data-slot="combobox-content" className={cn('selection-popup', className)} {...props} />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return <ComboboxPrimitive.List data-slot="combobox-list" className={cn('selection-list', className)} {...props} />;
}

function ComboboxItem({ className, children, ...props }: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item data-slot="combobox-item" className={cn('selection-option', className)} {...props}>
      <span className="selection-option-label">{children}</span>
      <ComboboxPrimitive.ItemIndicator className="selection-check">
        <Check size={14} aria-hidden="true" />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  );
}

function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
  return <ComboboxPrimitive.Empty data-slot="combobox-empty" className={cn('selection-empty', className)} {...props} />;
}

export {
  Combobox,
  ComboboxValue,
  ComboboxTrigger,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
};
