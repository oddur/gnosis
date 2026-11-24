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
 * from an effect, which Activity disconnects when another tab shows and connects again when Changes shows. Only
 * Changes' header reads them, so taking them back while another tab shows keeps the last ones for the next visit, and
 * a hand-off that shows the same state as the header renders nothing. Before, each switch away from Changes and back
 * rendered the whole PR page once more (#352). The header's buttons call the latest hand-off.
 */
export function useChangesHeaderReview(shown: boolean) {
  const showing = useRef(shown);
  showing.current = shown;
  const latest = useRef<HeaderReview | undefined>(undefined);
  const rendered = useRef<HeaderReviewState | undefined>(undefined);
  const [state, setState] = useState<HeaderReviewState>();
  const receive = useCallback((review: HeaderReview | undefined) => {
    if (review) latest.current = review;
    // Hidden, not gone: Changes hands its drafts over again when it shows. If it unmounts while hidden, its next
    // mount hands over its own.
    else if (!showing.current) return;
    const next = review && { draftCount: review.draftCount, draftsDisabled: review.draftsDisabled, reviewBlocked: review.reviewBlocked };
    if (sameHeaderReview(rendered.current, next)) return;
    rendered.current = next;
    setState(next);
  }, []);
  const review = useMemo<HeaderReview | undefined>(
    () => state && { ...state, toggleDrafts: () => latest.current?.toggleDrafts(), openReview: () => latest.current?.openReview() },
    [state]
  );
  return [review, receive] as const;
}
