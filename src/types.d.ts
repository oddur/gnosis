import type {
  ChangedFile,
  GenerateReviewRequest,
  Preferences,
  PrSearchResult,
  PrStatus,
  ReviewGuide,
  ReviewHistoryEntry,
  SendSlideChatRequest,
  StartReviewResult,
  SubmitReviewRequest,
  FreshnessResult,
  RepoSearchResult,
  UpdateInfo,
} from '../lib/types';

declare global {
  interface Window {
    electronAPI: {
      startReview: (req: GenerateReviewRequest) => Promise<StartReviewResult>;
      cancelReview: (reviewId: string) => Promise<void>;
      getConfig: () => Promise<{ githubToken: string | null }>;
      startOAuth: () => Promise<void>;
      getAuthState: () => Promise<{ authenticated: boolean; login: string | null }>;
      signOut: () => Promise<void>;
      savePat: (token: string) => Promise<string>;
      listReviews: () => Promise<ReviewHistoryEntry[]>;
      loadReview: (id: string) => Promise<ReviewGuide>;
      deleteReview: (id: string) => Promise<void>;
      deleteAllReviews: () => Promise<void>;
      exportReview: (id: string) => Promise<string | null>;
      importReview: () => Promise<ReviewHistoryEntry | null>;
      onReviewProgress: (callback: (reviewId: string, chunk: string, isThinking: boolean) => void) => void;
      offReviewProgress: () => void;
      onReviewToolUse: (callback: (reviewId: string, toolName: string) => void) => void;
      offReviewToolUse: () => void;
      onReviewPhase: (callback: (reviewId: string, phase: string) => void) => void;
      offReviewPhase: () => void;
      onReviewCompleted: (callback: (reviewId: string) => void) => void;
      offReviewCompleted: () => void;
      onReviewFailed: (callback: (reviewId: string, error: string) => void) => void;
      offReviewFailed: () => void;
      onReviewStats: (callback: (reviewId: string, inputBytes: number) => void) => void;
      offReviewStats: () => void;
      onReviewNavigate: (callback: (reviewId: string) => void) => void;
      offReviewNavigate: () => void;
      sendSlideChat: (req: SendSlideChatRequest) => Promise<string>;
      onChatProgress: (callback: (chunk: string) => void) => void;
      offChatProgress: () => void;
      onChatToolUse: (callback: (toolName: string) => void) => void;
      offChatToolUse: () => void;
      submitReview: (req: SubmitReviewRequest) => Promise<{ reviewUrl: string; droppedCommentCount: number }>;
      checkPrFreshness: (prUrl: string, headSha: string | undefined) => Promise<FreshnessResult>;
      loadPreferences: () => Promise<Preferences>;
      savePreferences: (prefs: Preferences) => Promise<void>;
      searchPullRequests: () => Promise<PrSearchResult[]>;
      searchRepos: (query: string) => Promise<RepoSearchResult[]>;
      reRenderHunks: (review: ReviewGuide) => Promise<ReviewGuide>;
      getPrStatus: (prUrl: string) => Promise<PrStatus>;
      onUpdateAvailable: (callback: (info: UpdateInfo) => void) => void;
      offUpdateAvailable: () => void;
      onUpdateReady: (callback: (version: string) => void) => void;
      offUpdateReady: () => void;
      dismissUpdate: (version: string) => Promise<void>;
      getPendingUpdateReady: () => Promise<string | null>;
      openExternal: (url: string) => Promise<void>;
      openLogsDirectory: () => Promise<void>;
      openReviewPrompt: (id: string) => Promise<void>;
      detectBinaryPath: (name: string) => Promise<string>;
      checkCliInstalled: (provider: string) => Promise<{ installed: boolean; resolvedPath: string }>;
      onShowTrayPrompt: (callback: () => void) => void;
      offShowTrayPrompt: () => void;
      onNewReviewInHistory: (callback: () => void) => void;
      offNewReviewInHistory: () => void;
      markReviewRead: (id: string) => Promise<void>;
      getPrState: (prUrl: string) => Promise<{ prState: 'open' | 'merged' | 'closed'; headSha: string }>;
      getPrFiles: (prUrl: string) => Promise<ChangedFile[]>;
      platform: NodeJS.Platform;
      isPackaged: boolean;
    };
  }
}

export {};
