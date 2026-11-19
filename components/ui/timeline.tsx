/**
 * A vertical timeline: a rail with one node per item, the item's title beside its node and its content below.
 *
 * Adapted from ReUI's Timeline (https://reui.io/components/timeline, `@reui/timeline`, and the pipeline-steps example
 * `@reui/c-timeline-6`). Copyright (c) 2025 Keenthemes Inc, MIT License: permission is granted to use, copy, modify,
 * merge, publish, distribute, sublicense and sell copies, provided this notice is included. The software is provided
 * "as is", without warranty of any kind.
 *
 * Changes from ReUI: plain elements instead of Base UI's render props (no new dependency); vertical only; no step
 * counter, since Feedback's rail carries each item's own kind and state; and the separator spans its whole item, top to
 * bottom, so items placed back to back by a virtualizer draw one continuous line (`data-edge` trims the first and last).
 * Styles live in globals.css under `.timeline`, using the app's tokens.
 */
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Timeline({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="timeline" className={cn('timeline', className)} {...props} />;
}

/** One item: the rail column on the left, the header and content on the right. */
export function TimelineItem({
  className,
  edge,
  ...props
}: ComponentProps<'div'> & {
  /** The first item's line starts at its node, the last item's ends there. */
  edge?: 'first' | 'last' | 'only';
}) {
  return <div data-slot="timeline-item" data-edge={edge} className={cn('timeline-item', className)} {...props} />;
}

/** The rail's line through this item. `tone` names its meaning: seen history, new activity, or a jump in time. */
export function TimelineSeparator({ className, tone, ...props }: ComponentProps<'div'> & { tone?: 'seen' | 'new' | 'gap' }) {
  return <div aria-hidden="true" data-slot="timeline-separator" data-tone={tone} className={cn('timeline-separator', className)} {...props} />;
}

/**
 * The item's node. It names the item's kind in words for assistive technology (`label`); the icon and tone repeat it
 * for the eye, never colour alone.
 */
export function TimelineIndicator({
  className,
  label,
  tone,
  children,
  ...props
}: ComponentProps<'span'> & { label: string; tone?: string; children?: ReactNode }) {
  return (
    <span role="img" aria-label={label} title={label} data-slot="timeline-indicator" data-tone={tone} className={cn('timeline-indicator', className)} {...props}>
      {children}
    </span>
  );
}

export function TimelineHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="timeline-header" className={cn('timeline-header', className)} {...props} />;
}

export function TimelineTitle({ className, ...props }: ComponentProps<'h3'>) {
  return <h3 data-slot="timeline-title" className={cn('timeline-title', className)} {...props} />;
}

export function TimelineDate({ className, ...props }: ComponentProps<'time'>) {
  return <time data-slot="timeline-date" className={cn('timeline-date', className)} {...props} />;
}

export function TimelineContent({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="timeline-content" className={cn('timeline-content', className)} {...props} />;
}
