import type { GenerateReviewRequest, ReviewGuide, ReviewHistoryEntry } from '../lib/types';

declare global {
  interface Window {
    electronAPI: {
      generateReview: (req: GenerateReviewRequest) => Promise<ReviewGuide>;
      getConfig: () => Promise<{ githubToken: string | null }>;
      startOAuth: () => Promise<void>;
      getAuthState: () => Promise<{ authenticated: boolean; login: string | null }>;
      signOut: () => Promise<void>;
      listReviews: () => Promise<ReviewHistoryEntry[]>;
      loadReview: (id: string) => Promise<ReviewGuide>;
      deleteReview: (id: string) => Promise<void>;
      onReviewProgress: (callback: (chunk: string, isThinking: boolean) => void) => void;
      offReviewProgress: () => void;
    };
  }
}

export {};
