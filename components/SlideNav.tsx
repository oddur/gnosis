import { MessageSquarePlus } from 'lucide-react';

interface Props {
  current: number;
  total: number;
  prevTitle: string | null;
  nextTitle: string | null;
  onPrev: () => void;
  onNext: () => void;
  commentCount?: number;
  onSubmitReview?: () => void;
}

// Bottom navigation bar. The previous version was a thin row of muted
// text controls — so quiet that users overlooked it and missed how to
// advance through the deck. This rebuild keeps the editorial register
// (no shadcn Button chrome, no rounded pills) but gives the bar real
// presence: a subtle paper-tinted background, a solid border-top, more
// vertical padding, and the actual section titles on the prev/next
// buttons so the user can see what's coming next at a glance. The
// reading-progress hairline has moved to the very top of the page in
// ReviewPage; this bar no longer carries it.
export function SlideNav({
  current,
  total,
  prevTitle,
  nextTitle,
  onPrev,
  onNext,
  commentCount = 0,
  onSubmitReview,
}: Props) {
  const isOverview = current === 0;
  const atEnd = current >= total;

  // On the very last slide, the right-hand button transforms from
  // "Next" into the submit-review CTA. The user has just finished
  // reading; the most prominent affordance on the page should now
  // be the conclusion of the flow, not a dead disabled button. When
  // this transformation happens, the center submit-review link
  // hides so the right button is the unique submit affordance.
  const showSubmitAsRight = atEnd && !!onSubmitReview;
  const showSubmitInCenter = !showSubmitAsRight && !!onSubmitReview;

  const nextLeadIn = isOverview ? 'Begin reading' : 'Next';

  return (
    <div className="border-t border-border bg-muted/30 shrink-0">
      <div className="flex items-stretch justify-between gap-6 px-10 py-5">
        {/* ── Previous ── Quieter weight than Next so the eye is
            pulled forward. Disabled (faded) when on the overview. */}
        <button
          onClick={onPrev}
          disabled={isOverview}
          className="group flex items-baseline gap-3 text-left max-w-[36%] min-w-0 disabled:opacity-30 disabled:cursor-default"
          title="Previous (←)"
        >
          <span className="slide-meta shrink-0 group-hover:text-foreground transition-colors">
            ←
          </span>
          <span className="flex flex-col gap-0.5 min-w-0">
            <span className="slide-meta">Previous</span>
            <span className="font-serif text-base text-foreground/60 group-hover:text-foreground transition-colors truncate">
              {prevTitle ?? 'Start of review'}
            </span>
          </span>
        </button>

        {/* ── Center ── Counter + (when not at the end) the submit
            review affordance. On the last slide the submit moves
            to the right column, so this column shrinks back to
            just the counter. */}
        <div className="flex flex-col items-center justify-center gap-1 shrink-0">
          <span className="slide-meta tabular-nums">
            {isOverview
              ? 'Overview'
              : `Section ${current.toString().padStart(2, '0')} of ${total
                  .toString()
                  .padStart(2, '0')}`}
          </span>
          {showSubmitInCenter && (
            <button
              onClick={onSubmitReview}
              className="inline-flex items-center gap-1.5 slide-meta hover:text-foreground transition-colors"
            >
              <MessageSquarePlus className="h-3 w-3" />
              Submit review
              {commentCount > 0 && (
                <span className="text-[var(--ring)] tabular-nums">({commentCount})</span>
              )}
            </button>
          )}
        </div>

        {/* ── Right ── On the last slide, this becomes the
            submit-review CTA — closing the reading loop with a
            clear "you're done, click here" guide. Otherwise it's
            the standard Next button with the upcoming section
            title in heavy foreground type. */}
        {showSubmitAsRight ? (
          <button
            onClick={onSubmitReview}
            className="group flex items-baseline gap-3 text-right max-w-[36%] min-w-0 justify-end"
            title="Submit review"
          >
            <span className="flex flex-col gap-0.5 min-w-0 items-end">
              <span className="slide-meta">You've reached the end</span>
              <span className="font-serif text-base text-foreground group-hover:opacity-80 transition-opacity truncate">
                Submit review
                {commentCount > 0 && (
                  <span className="text-[var(--ring)] tabular-nums"> ({commentCount})</span>
                )}
              </span>
            </span>
            <span className="slide-meta shrink-0 text-foreground group-hover:opacity-80 transition-opacity">
              →
            </span>
          </button>
        ) : (
          <button
            onClick={onNext}
            disabled={atEnd}
            className="group flex items-baseline gap-3 text-right max-w-[36%] min-w-0 disabled:opacity-30 disabled:cursor-default justify-end"
            title="Next (→)"
          >
            <span className="flex flex-col gap-0.5 min-w-0 items-end">
              <span className="slide-meta">{nextLeadIn}</span>
              <span className="font-serif text-base text-foreground group-hover:opacity-80 transition-opacity truncate">
                {nextTitle ?? 'End of review'}
              </span>
            </span>
            <span className="slide-meta shrink-0 text-foreground group-hover:opacity-80 transition-opacity">
              →
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
