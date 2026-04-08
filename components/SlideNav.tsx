import { MessageSquarePlus } from 'lucide-react';

interface Props {
  current: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  commentCount?: number;
  onSubmitReview?: () => void;
}

// Bottom nav for the slide deck. The reference screenshot's bar is a
// thin row of low-contrast text controls — no fills, no shadcn Button
// chrome, no Progress component, no rounded pills. The hairline above
// the bar IS the progress bar: it fills from left to right in the
// brand amber as the reader advances.
export function SlideNav({ current, total, onPrev, onNext, commentCount = 0, onSubmitReview }: Props) {
  const isOverview = current === 0;
  const progress = isOverview ? 0 : total > 1 ? ((current - 1) / (total - 1)) * 100 : 100;
  const atEnd = current >= total;

  return (
    <div className="border-t border-border">
      {/* Hairline progress fill — replaces the shadcn Progress
          component. 1px tall, fills in the brand amber, transitions
          smoothly between slides (gated by prefers-reduced-motion). */}
      <div className="relative h-px w-full bg-transparent" role="progressbar" aria-valuenow={progress}>
        <div
          className="absolute left-0 top-0 h-px bg-[var(--ring)] loading-progress-fill"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="flex items-center justify-between px-8 py-4 slide-meta">
        {/* Prev — arrow + word, no fill, no border, just type.
            Disappears when there's nowhere to go back. */}
        <button
          onClick={onPrev}
          disabled={isOverview}
          className="hover:text-foreground transition-colors disabled:opacity-30 disabled:cursor-default"
          title="Previous slide (←)"
        >
          ← Previous
        </button>

        {/* Center — chapter counter in mono. "Overview" before the
            deck starts, then "01 / 12" — same vocabulary as the
            slide chapter chip. */}
        <span className="tabular-nums">{isOverview ? 'Overview' : `${current.toString().padStart(2, '0')} / ${total.toString().padStart(2, '0')}`}</span>

        {/* Right — submit review (when relevant) and next.
            Submit gets a tiny inline mono comment count, no badge. */}
        <div className="flex items-center gap-6">
          {onSubmitReview && (
            <button
              onClick={onSubmitReview}
              className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors"
            >
              <MessageSquarePlus className="h-3 w-3" />
              Submit review
              {commentCount > 0 && (
                <span className="text-[var(--ring)] tabular-nums">({commentCount})</span>
              )}
            </button>
          )}
          <button
            onClick={onNext}
            disabled={atEnd}
            className="hover:text-foreground transition-colors disabled:opacity-30 disabled:cursor-default"
            title="Next slide (→)"
          >
            Next →
          </button>
        </div>
      </div>
    </div>
  );
}
