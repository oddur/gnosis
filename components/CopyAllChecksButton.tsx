import { useMemo, useState } from 'react';
import { Check, ClipboardList } from 'lucide-react';
import { buildAllChecksPrompt } from '@/lib/all-checks-prompt';
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
  const [copied, setCopied] = useState(false);

  // No checks anywhere → hide the affordance entirely. A grey-disabled
  // button just adds noise.
  if (count === 0) return null;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(prompt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  if (variant === 'compact') {
    return (
      <button
        type="button"
        onClick={handleClick}
        title={copied ? 'Copied' : `Copy all ${count} check${count === 1 ? '' : 's'} as an agent prompt`}
        aria-label={copied ? 'Copied' : `Copy all ${count} checks as an agent prompt`}
        className={`hover:text-foreground transition-colors ${className}`}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <ClipboardList className="h-3.5 w-3.5" />}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`group flex items-baseline gap-3 text-left ${className}`}
    >
      <span className="slide-meta flex items-center gap-1.5">
        {copied ? <Check className="h-3 w-3" /> : <ClipboardList className="h-3 w-3" />}
        {copied ? 'Copied' : 'Pass to an agent'}
      </span>
      <span className="font-serif text-lg text-foreground group-hover:opacity-80 transition-opacity">
        Copy all {count} check{count === 1 ? '' : 's'} as one prompt →
      </span>
    </button>
  );
}
