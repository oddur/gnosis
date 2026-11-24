import { createContext, useCallback, useMemo, useRef, useState } from 'react';

/** The PR header's Drafts and Review PR act on the drafts of the view that shows them (#542). */
export interface HeaderReview {
  draftCount: number;
  draftsDisabled: boolean;
  /** Why Review PR cannot open, if it cannot. */
  reviewBlocked?: string;
  toggleDrafts: () => void;
  openReview: () => void;
}
/**
 * Changes keeps its own drafts for its loaded diff. While it is shown, it hands them to the header through this, so
 * Drafts and Review PR stay in the header's place on every tab.
 */
export const PrHeaderReviewContext = createContext<((review: HeaderReview | undefined) => void) | undefined>(undefined);

type HeaderReviewState = Pick<HeaderReview, 'draftCount' | 'draftsDisabled' | 'reviewBlocked'>;
const sameHeaderReview = (a?: HeaderReviewState, b?: HeaderReviewState) =>
  a === b || (!!a && !!b && a.draftCount === b.draftCount && a.draftsDisabled === b.draftsDisabled && a.reviewBlocked === b.reviewBlocked);

/**
 * The PR page's end of PrHeaderReviewContext: Changes' drafts for the header while `shown`. Changes hands them over
 * from an effect, which Activity disconnects when another tab shows and connects again when Changes shows. Taking
 * them back while another tab shows renders nothing, since only Changes' header reads them: before, each switch away
 * from Changes rendered the whole PR page once more (#352). The view may change, or be dropped, while hidden, so a
 * visit never shows the last visit's drafts: until Changes hands them over again, the header falls back. A hand-off
 * that shows the same state as the header renders nothing. The header's buttons call the latest hand-off.
 */
export function useChangesHeaderReview(shown: boolean) {
  const showing = useRef(shown);
  // Each time Changes shows is a new visit. Drafts handed over on an earlier visit are not shown on this one.
  const visit = useRef(0);
  if (shown && !showing.current) visit.current++;
  showing.current = shown;
  const latest = useRef<HeaderReview | undefined>(undefined);
  const rendered = useRef<{ visit: number; review?: HeaderReviewState }>({ visit: 0 });
  const [state, setState] = useState<{ visit: number; review?: HeaderReviewState }>({ visit: 0 });
  const receive = useCallback((review: HeaderReview | undefined) => {
    // Hidden: drop the hand-off, so a view that is gone is not kept alive. Changes hands over again when it shows.
    latest.current = review;
    if (!review && !showing.current) return;
    const next = {
      visit: visit.current,
      review: review && { draftCount: review.draftCount, draftsDisabled: review.draftsDisabled, reviewBlocked: review.reviewBlocked },
    };
    if (rendered.current.visit === next.visit && sameHeaderReview(rendered.current.review, next.review)) return;
    rendered.current = next;
    setState(next);
  }, []);
  const current = shown && state.visit === visit.current ? state.review : undefined;
  const review = useMemo<HeaderReview | undefined>(
    () => current && { ...current, toggleDrafts: () => latest.current?.toggleDrafts(), openReview: () => latest.current?.openReview() },
    [current]
  );
  return [review, receive] as const;
}
