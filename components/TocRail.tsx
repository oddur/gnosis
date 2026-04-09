import { useEffect, useRef } from 'react';
import { Check } from 'lucide-react';
import type { Slide, SlideImportance } from '@/lib/types';

const importanceDot: Record<SlideImportance, string> = {
  critical: 'bg-[var(--color-danger)]',
  important: '',
  minor: '',
};

interface Props {
  slides: Slide[];
  currentSlide: number; // 0 = overview, 1..N = slides[N-1]
  reviewed: Set<number>;
  hideReviewed: boolean;
  onToggleHideReviewed: () => void;
  onNavigate: (n: number) => void;
}

// Persistent left-rail table of contents. Visible on the overview AND
// every slide so the reader always knows where they are in the book
// and what's coming. Numbered entries, no boxes, no chrome — just
// type on the page in the editorial register.
//
// Reviewed sections show a quiet ✓ replacing the number. When "hide
// reviewed" is active, reviewed entries collapse into a single
// "{N} reviewed" summary line so the user sees only what's left.
export function TocRail({
  slides,
  currentSlide,
  reviewed,
  hideReviewed,
  onToggleHideReviewed,
  onNavigate,
}: Props) {
  const currentRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (!currentRef.current) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    currentRef.current.scrollIntoView({
      behavior: reduceMotion ? 'auto' : 'smooth',
      block: 'nearest',
    });
  }, [currentSlide]);

  const reviewedCount = reviewed.size;
  const hasAnyReviewed = reviewedCount > 0;

  return (
    <nav
      aria-label="Table of contents"
      className="w-[260px] shrink-0 border-r border-border overflow-y-auto py-8 px-6 hidden lg:block"
    >
      <div className="flex items-baseline justify-between mb-5">
        <p className="slide-meta uppercase tracking-wider">Contents</p>
        {hasAnyReviewed && (
          <button
            onClick={onToggleHideReviewed}
            className="slide-meta hover:text-foreground transition-colors"
          >
            {hideReviewed ? 'Show all' : 'Hide reviewed'}
          </button>
        )}
      </div>

      {hasAnyReviewed && (
        <p className="slide-meta mb-3 tabular-nums">
          {reviewedCount} of {slides.length} reviewed
        </p>
      )}

      <ol className="flex flex-col">
        {/* Overview row — always visible. */}
        <li ref={currentSlide === 0 ? currentRef : null}>
          <button
            onClick={() => onNavigate(0)}
            className={`group w-full text-left py-2 flex gap-3 transition-colors ${
              currentSlide === 0
                ? 'text-foreground'
                : 'text-foreground/55 hover:text-foreground'
            }`}
          >
            <span
              className={`slide-meta shrink-0 tabular-nums w-6 ${
                currentSlide === 0 ? 'text-[var(--ring)]' : ''
              }`}
            >
              00
            </span>
            <span className="font-serif text-base leading-snug">Overview</span>
          </button>
        </li>

        {slides.map((slide) => {
          const isCurrent = slide.slideNumber === currentSlide;
          const isReviewed = reviewed.has(slide.slideNumber);
          const num = slide.slideNumber.toString().padStart(2, '0');
          const importance = slide.importance ?? 'important';
          const dotClass = importanceDot[importance];

          // When hide-reviewed is active, collapse reviewed entries
          // (but always show the current slide even if reviewed).
          if (hideReviewed && isReviewed && !isCurrent) return null;

          return (
            <li key={slide.id} ref={isCurrent ? currentRef : null}>
              <button
                onClick={() => onNavigate(slide.slideNumber)}
                className={`group w-full text-left py-2 flex gap-3 transition-[color,opacity] duration-200 ${
                  isCurrent
                    ? 'text-foreground'
                    : isReviewed
                      ? 'text-foreground/35 hover:text-foreground/55'
                      : 'text-foreground/55 hover:text-foreground'
                }`}
              >
                <span
                  className={`shrink-0 w-6 flex items-center justify-center ${
                    isCurrent ? 'text-[var(--ring)]' : ''
                  }`}
                >
                  {isReviewed && !isCurrent ? (
                    <Check className="h-3 w-3 text-[var(--ring)]/60 animate-fade-in" />
                  ) : (
                    <span className="slide-meta tabular-nums">{num}</span>
                  )}
                </span>
                <span className="font-serif text-base leading-snug flex items-center gap-1.5 min-w-0">
                  <span className="line-clamp-2">{slide.title}</span>
                  {dotClass && <span className={`shrink-0 h-1.5 w-1.5 rounded-full ${dotClass}`} title="Critical" />}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
