import { useMemo } from 'react';
import { Check, ClipboardList, ClipboardX } from 'lucide-react';
import { buildAllChecksPrompt } from '@/lib/all-checks-prompt';
import { useCopyToClipboard } from '@/lib/use-copy';
import type { ReviewGuide } from '@/lib/types';

interface Props {
  review: ReviewGuide;
  /** "compact" = icon-only with a tooltip (top bar). "full" = icon + label
   *  (overview page). The two surfaces have different density budgets so
   *  one component covers both with a presentation flag. */
  variant?: 'compact' | 'full';
  className?: string;
}

export function CopyAllChecksButton({ review, variant = 'compact', className = '' }: Props) {
  // Recompute when slides change (e.g. after re-render with new review).
  const { prompt, count } = useMemo(() => buildAllChecksPrompt(review), [review]);
  const { state, copy } = useCopyToClipboard();

  // No checks anywhere → hide the affordance entirely. A grey-disabled
  // button just adds noise.
  if (count === 0) return null;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    copy(prompt);
  };

  // One label string reused for title + aria-label so the tooltip and
  // the screen-reader announcement can't disagree.
  const label =
    state === 'copied'
      ? 'Copied'
      : state === 'failed'
        ? 'Copy failed — click to retry'
        : `Copy all ${count} check${count === 1 ? '' : 's'} as an agent prompt`;
  const icon =
    state === 'copied' ? (
      <Check className="h-3.5 w-3.5" />
    ) : state === 'failed' ? (
      <ClipboardX className="h-3.5 w-3.5 text-destructive" />
    ) : (
      <ClipboardList className="h-3.5 w-3.5" />
    );

  if (variant === 'compact') {
    return (
      <button
        type="button"
        onClick={handleClick}
        title={label}
        aria-label={label}
        className={`hover:text-foreground transition-colors ${className}`}
      >
        {icon}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={label}
      className={`group flex items-baseline gap-3 text-left ${className}`}
    >
      <span className="slide-meta flex items-center gap-1.5">
        {state === 'copied' ? (
          <Check className="h-3 w-3" />
        ) : state === 'failed' ? (
          <ClipboardX className="h-3 w-3 text-destructive" />
        ) : (
          <ClipboardList className="h-3 w-3" />
        )}
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Pass to an agent'}
      </span>
      <span className="font-serif text-lg text-foreground group-hover:opacity-80 transition-opacity">
        Copy all {count} check{count === 1 ? '' : 's'} as one prompt →
      </span>
    </button>
  );
}
