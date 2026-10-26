import { createContext, useContext, useEffect, useRef } from 'react';
import type { PrReadState } from './pr-read-state';

export interface ViewedPr {
  url: string;
  headSha: string;
}
export const PrReadContext = createContext<{
  states: Partial<Record<string, PrReadState>>;
  busy: boolean;
  change: (urls: string[], read: boolean) => Promise<void>;
  viewed: (revisions: ViewedPr[]) => void;
} | null>(null);
/** An explicit content transition acknowledges its displayed revision once.
 * Status refreshes never retrigger this effect; a hidden window is not a visit. */
export function usePrReadVisit(revisions: ViewedPr[], active = true, contentKey?: string) {
  const context = useContext(PrReadContext);
  const latest = useRef({ context, revisions });
  latest.current = { context, revisions };
  const key = contentKey ?? JSON.stringify(revisions);
  const ready = !!context && revisions.length > 0 && revisions.every((pr) => !!context.states[pr.url]);
  useEffect(() => {
    if (!active || !ready) return;
    let handled = false;
    const visit = () => {
      if (handled || document.visibilityState === 'hidden' || !document.hasFocus()) return;
      handled = true;
      latest.current.context?.viewed(latest.current.revisions);
    };
    visit();
    window.addEventListener('focus', visit);
    document.addEventListener('visibilitychange', visit);
    return () => {
      window.removeEventListener('focus', visit);
      document.removeEventListener('visibilitychange', visit);
    };
  }, [key, active, ready]);
}
