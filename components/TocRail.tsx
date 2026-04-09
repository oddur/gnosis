import { useEffect, useRef } from 'react';
import type { Slide } from '@/lib/types';

interface Props {
  slides: Slide[];
  currentSlide: number; // 0 = overview, 1..N = slides[N-1]
  onNavigate: (n: number) => void;
}

// Persistent left-rail table of contents. Visible on the overview AND
// every slide so the reader always knows where they are in the book
// and what's coming. Numbered entries, no boxes, no chrome — just
// type on the page in the editorial register. The current entry is
// rendered in foreground with a claret number; everything else fades
// to ~55% to keep the rail quiet.
//
// The rail auto-scrolls the current entry into view as the user
// advances, honoring prefers-reduced-motion.
export function TocRail({ slides, currentSlide, onNavigate }: Props) {
  const railRef = useRef<HTMLElement>(null);
  const currentRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (!currentRef.current) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    currentRef.current.scrollIntoView({
      behavior: reduceMotion ? 'auto' : 'smooth',
      block: 'nearest',
    });
  }, [currentSlide]);

  return (
    <nav
      ref={railRef}
      aria-label="Table of contents"
      className="w-[260px] shrink-0 border-r border-border overflow-y-auto py-8 px-6 hidden lg:block"
    >
      <p className="slide-meta uppercase tracking-wider mb-5">Contents</p>

      <ol className="flex flex-col">
        {/* Overview row — always at the top of the rail. */}
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
          const num = slide.slideNumber.toString().padStart(2, '0');
          return (
            <li key={slide.id} ref={isCurrent ? currentRef : null}>
              <button
                onClick={() => onNavigate(slide.slideNumber)}
                className={`group w-full text-left py-2 flex gap-3 transition-colors ${
                  isCurrent ? 'text-foreground' : 'text-foreground/55 hover:text-foreground'
                }`}
              >
                <span
                  className={`slide-meta shrink-0 tabular-nums w-6 ${
                    isCurrent ? 'text-[var(--ring)]' : ''
                  }`}
                >
                  {num}
                </span>
                <span className="font-serif text-base leading-snug text-balance">
                  {slide.title}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
