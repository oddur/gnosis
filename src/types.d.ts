import type {
  GenerateReviewRequest,
  Preferences,
  PrSearchResult,
  PrStatus,
  ReviewGuide,
  ReviewHistoryEntry,
  SendSlideChatRequest,
  SubmitReviewRequest,
  FreshnessResult,
  UpdateInfo,
} from '../lib/types';

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
      deleteAllReviews: () => Promise<void>;
      onReviewProgress: (callback: (chunk: string, isThinking: boolean) => void) => void;
      offReviewProgress: () => void;
      sendSlideChat: (req: SendSlideChatRequest) => Promise<string>;
      onChatProgress: (callback: (chunk: string) => void) => void;
      offChatProgress: () => void;
      submitReview: (req: SubmitReviewRequest) => Promise<{ reviewUrl: string; droppedCommentCount: number }>;
      checkPrFreshness: (prUrl: string, headSha: string | undefined) => Promise<FreshnessResult>;
      loadPreferences: () => Promise<Preferences>;
      savePreferences: (prefs: Preferences) => Promise<void>;
      searchPullRequests: () => Promise<PrSearchResult[]>;
      reRenderHunks: (review: ReviewGuide) => Promise<ReviewGuide>;
      getPrStatus: (prUrl: string) => Promise<PrStatus>;
      onUpdateAvailable: (callback: (info: UpdateInfo) => void) => void;
      offUpdateAvailable: () => void;
      dismissUpdate: (version: string) => Promise<void>;
      openExternal: (url: string) => Promise<void>;
      detectBinaryPath: (name: string) => Promise<string>;
      checkCliInstalled: (provider: string) => Promise<{ installed: boolean; resolvedPath: string }>;
      platform: NodeJS.Platform;
    };
  }
}

export {};
