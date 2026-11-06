import { useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

// One observer for all visible loading states, including a long file stream.
let observer: IntersectionObserver | undefined;
const observed = new Set<HTMLElement>();
const updateVisibility = () => {
  for (const element of observed) element.dataset.loadingHidden = String(document.hidden);
};
function useLoadingMotion<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (!observed.size) document.addEventListener('visibilitychange', updateVisibility);
    observed.add(element);
    element.dataset.loadingHidden = String(document.hidden);
    observer ??= new IntersectionObserver((entries) => {
      for (const entry of entries) (entry.target as HTMLElement).dataset.loadingVisible = String(entry.isIntersecting);
    });
    observer.observe(element);
    return () => {
      observer?.unobserve(element);
      observed.delete(element);
      if (!observed.size) {
        observer?.disconnect();
        observer = undefined;
        document.removeEventListener('visibilitychange', updateVisibility);
      }
    };
  }, []);
  return ref;
}

/** Small areas and refreshes keep their content; only the status moves. */
export function LoadingIndicator({
  children,
  className,
  announce = true,
}: {
  children: React.ReactNode;
  className?: string;
  announce?: boolean;
}) {
  const ref = useLoadingMotion<HTMLSpanElement>();
  return (
    <span ref={ref} className={cn('loading-indicator', className)} role={announce ? 'status' : undefined}>
      <LoaderCircle className="loading-spinner" size={14} aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}

/** The check graph's moving signal: activity, never a fabricated percentage. */
export function LoadingMotif() {
  return (
    <svg className="loading-motif" viewBox="0 0 160 64" fill="none" aria-hidden="true">
      <path className="loading-track" d="M32 32H128" />
      <path className="loading-signal" pathLength="100" d="M32 32H128" />
      {[16, 64, 112].map((x) => (
        <g key={x}>
          <rect x={x} y="16" width="32" height="32" rx="6" />
          <circle cx={x + 16} cy="32" r="3" />
        </g>
      ))}
    </svg>
  );
}

/** For genuinely empty panes. Cached content should stay mounted on refresh. */
export function LoadingState({
  title,
  description,
  hint,
  compact = false,
  className,
}: {
  title: string;
  description?: string;
  hint?: string;
  compact?: boolean;
  className?: string;
}) {
  const ref = useLoadingMotion<HTMLDivElement>();
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!hint) return;
    const start = Date.now();
    const timer = setInterval(() => {
      if (!document.hidden && ref.current?.dataset.loadingVisible !== 'false')
        setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [hint, ref]);
  return (
    <div ref={ref} className={cn('loading-state', compact && 'loading-state-compact', className)}>
      <div className="loading-state-content">
        {compact ? <LoaderCircle className="loading-spinner" size={18} aria-hidden="true" /> : <LoadingMotif />}
        <div className="loading-state-copy" role="status" aria-atomic="true">
          <p className="loading-state-title">{title}</p>
          {description && <p className="loading-state-description">{description}</p>}
        </div>
        {hint && (
          <p className="loading-state-hint">
            {elapsed >= 5 && (
              <span className="loading-elapsed" aria-hidden="true">
                {elapsed}s elapsed ·{' '}
              </span>
            )}
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}
