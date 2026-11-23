import { createContext } from 'react';

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
