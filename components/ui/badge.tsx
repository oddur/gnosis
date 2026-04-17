import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 text-[0.625rem] font-semibold uppercase tracking-widest whitespace-nowrap shrink-0 transition-colors [&>svg]:size-3 [&>svg]:pointer-events-none focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
  {
    variants: {
      variant: {
        default: 'text-foreground [a&]:hover:text-foreground/70',
        secondary: 'text-muted-foreground [a&]:hover:text-foreground',
        destructive:
          'text-destructive [a&]:hover:text-destructive/70 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40',
        outline: 'border border-border px-1.5 py-0.5 text-foreground [a&]:hover:text-foreground/70',
        ghost: 'text-muted-foreground hover:text-foreground',
        link: 'text-foreground underline-offset-4 [a&]:hover:underline',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

function Badge({
  className,
  variant = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'span';

  return (
    <Comp data-slot="badge" data-variant={variant} className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
