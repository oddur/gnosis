/**
 * Inline Citation, after shadcn/ui AI Elements (https://ui.shadcn.com/docs/ai-elements/base/inline-citation, MIT): a
 * source that sits in the sentence it supports, a Hover Card on a Button. Gnosis cites files and lines in the PR as
 * well as pages, so the card body takes a quote (the cited lines) and an action. Styled under `.inline-citation` in
 * globals.css.
 */
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';

export function InlineCitation({ className, ...props }: ComponentProps<'span'>) {
  return <span className={cn('inline-citation', className)} {...props} />;
}

export const InlineCitationCard = HoverCard;

/** The citation in the sentence: a focusable button that opens the card on hover or focus, after a short delay. */
export function InlineCitationCardTrigger({ className, children, ...props }: ComponentProps<'button'>): ReactElement {
  return (
    <HoverCardTrigger
      delay={250}
      closeDelay={120}
      render={<button type="button" className={cn('inline-citation-trigger', className)} {...props} />}
    >
      {children}
    </HoverCardTrigger>
  );
}

export function InlineCitationCardBody({ className, ...props }: ComponentProps<typeof HoverCardContent>) {
  return <HoverCardContent side="top" align="start" className={cn('inline-citation-card', className)} {...props} />;
}

export function InlineCitationSource({
  title,
  detail,
  icon,
  className,
}: {
  title: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('inline-citation-source', className)}>
      {icon}
      <div className="inline-citation-source-text">
        <div className="inline-citation-title">{title}</div>
        {detail && <div className="inline-citation-detail">{detail}</div>}
      </div>
    </div>
  );
}

export function InlineCitationQuote({ className, ...props }: ComponentProps<'pre'>) {
  return <pre className={cn('inline-citation-quote', className)} {...props} />;
}
