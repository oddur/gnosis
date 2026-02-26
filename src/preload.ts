import { contextBridge, ipcRenderer } from 'electron';
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
  UpdateInfo,
} from '../lib/types';

contextBridge.exposeInMainWorld('electronAPI', {
  startReview: (req: GenerateReviewRequest): Promise<StartReviewResult> => ipcRenderer.invoke('start-review', req),
  cancelReview: (reviewId: string): Promise<void> => ipcRenderer.invoke('cancel-review', reviewId),
  getConfig: (): Promise<{ githubToken: string | null }> => ipcRenderer.invoke('get-config'),
  startOAuth: (): Promise<void> => ipcRenderer.invoke('start-oauth'),
  getAuthState: (): Promise<{ authenticated: boolean; login: string | null }> => ipcRenderer.invoke('get-auth-state'),
  signOut: (): Promise<void> => ipcRenderer.invoke('sign-out'),
  savePat: (token: string): Promise<string> => ipcRenderer.invoke('save-pat', token),
  listReviews: (): Promise<ReviewHistoryEntry[]> => ipcRenderer.invoke('list-reviews'),
  loadReview: (id: string): Promise<ReviewGuide> => ipcRenderer.invoke('load-review', id),
  deleteReview: (id: string): Promise<void> => ipcRenderer.invoke('delete-review', id),
  deleteAllReviews: (): Promise<void> => ipcRenderer.invoke('delete-all-reviews'),
  onReviewProgress: (callback: (reviewId: string, chunk: string, isThinking: boolean) => void): void => {
    ipcRenderer.on(
      'review-progress',
      (_event, { reviewId, chunk, isThinking }: { reviewId: string; chunk: string; isThinking: boolean }) =>
        callback(reviewId, chunk, isThinking)
    );
  },
  offReviewProgress: (): void => {
    ipcRenderer.removeAllListeners('review-progress');
  },
  onReviewToolUse: (callback: (reviewId: string, toolName: string) => void): void => {
    ipcRenderer.on('review-tool-use', (_event, { reviewId, toolName }: { reviewId: string; toolName: string }) =>
      callback(reviewId, toolName)
    );
  },
  offReviewToolUse: (): void => {
    ipcRenderer.removeAllListeners('review-tool-use');
  },
  onReviewPhase: (callback: (reviewId: string, phase: string) => void): void => {
    ipcRenderer.on('review-phase', (_event, { reviewId, phase }: { reviewId: string; phase: string }) =>
      callback(reviewId, phase)
    );
  },
  offReviewPhase: (): void => {
    ipcRenderer.removeAllListeners('review-phase');
  },
  onReviewCompleted: (callback: (reviewId: string) => void): void => {
    ipcRenderer.on('review-completed', (_event, { reviewId }: { reviewId: string }) => callback(reviewId));
  },
  offReviewCompleted: (): void => {
    ipcRenderer.removeAllListeners('review-completed');
  },
  onReviewFailed: (callback: (reviewId: string, error: string) => void): void => {
    ipcRenderer.on('review-failed', (_event, { reviewId, error }: { reviewId: string; error: string }) =>
      callback(reviewId, error)
    );
  },
  offReviewFailed: (): void => {
    ipcRenderer.removeAllListeners('review-failed');
  },
  onReviewStats: (callback: (reviewId: string, inputBytes: number) => void): void => {
    ipcRenderer.on('review-stats', (_event, { reviewId, inputBytes }: { reviewId: string; inputBytes: number }) =>
      callback(reviewId, inputBytes)
    );
  },
  offReviewStats: (): void => {
    ipcRenderer.removeAllListeners('review-stats');
  },
  onReviewNavigate: (callback: (reviewId: string) => void): void => {
    ipcRenderer.on('review-navigate', (_event, { reviewId }: { reviewId: string }) => callback(reviewId));
  },
  offReviewNavigate: (): void => {
    ipcRenderer.removeAllListeners('review-navigate');
  },
  sendSlideChat: (req: SendSlideChatRequest): Promise<string> => ipcRenderer.invoke('send-slide-chat', req),
  onChatProgress: (callback: (chunk: string) => void): void => {
    ipcRenderer.on('chat-progress', (_event, { chunk }: { chunk: string }) => callback(chunk));
  },
  offChatProgress: (): void => {
    ipcRenderer.removeAllListeners('chat-progress');
  },
  onChatToolUse: (callback: (toolName: string) => void): void => {
    ipcRenderer.on('chat-tool-use', (_event, { toolName }: { toolName: string }) => callback(toolName));
  },
  offChatToolUse: (): void => {
    ipcRenderer.removeAllListeners('chat-tool-use');
  },
  submitReview: (req: SubmitReviewRequest): Promise<{ reviewUrl: string; droppedCommentCount: number }> =>
    ipcRenderer.invoke('submit-review', req),
  checkPrFreshness: (prUrl: string, headSha: string | undefined): Promise<FreshnessResult> =>
    ipcRenderer.invoke('check-pr-freshness', prUrl, headSha),
  loadPreferences: (): Promise<Preferences> => ipcRenderer.invoke('load-preferences'),
  savePreferences: (prefs: Preferences): Promise<void> => ipcRenderer.invoke('save-preferences', prefs),
  searchPullRequests: (): Promise<PrSearchResult[]> => ipcRenderer.invoke('search-pull-requests'),
  reRenderHunks: (review: ReviewGuide): Promise<ReviewGuide> => ipcRenderer.invoke('re-render-hunks', review),
  getPrStatus: (prUrl: string): Promise<PrStatus> => ipcRenderer.invoke('get-pr-status', prUrl),
  onUpdateAvailable: (callback: (info: UpdateInfo) => void): void => {
    ipcRenderer.on('update-available', (_event, info: UpdateInfo) => callback(info));
  },
  offUpdateAvailable: (): void => {
    ipcRenderer.removeAllListeners('update-available');
  },
  onUpdateReady: (callback: (version: string) => void): void => {
    ipcRenderer.on('update-ready', (_event, version: string) => callback(version));
  },
  offUpdateReady: (): void => {
    ipcRenderer.removeAllListeners('update-ready');
  },
  dismissUpdate: (version: string): Promise<void> => ipcRenderer.invoke('dismiss-update', version),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('open-external', url),
  openLogsDirectory: (): Promise<void> => ipcRenderer.invoke('open-logs-directory'),
  openReviewPrompt: (id: string): Promise<void> => ipcRenderer.invoke('open-review-prompt', id),
  detectBinaryPath: (name: string): Promise<string> => ipcRenderer.invoke('detect-binary-path', name),
  checkCliInstalled: (provider: string): Promise<{ installed: boolean; resolvedPath: string }> =>
    ipcRenderer.invoke('check-cli-installed', provider),
  onNewReviewInHistory: (callback: () => void): void => {
    ipcRenderer.on('new-review-in-history', () => callback());
  },
  offNewReviewInHistory: (): void => {
    ipcRenderer.removeAllListeners('new-review-in-history');
  },
  markReviewRead: (id: string): Promise<void> => ipcRenderer.invoke('mark-review-read', id),
  getPrState: (prUrl: string): Promise<{ prState: 'open' | 'merged' | 'closed'; headSha: string }> =>
    ipcRenderer.invoke('get-pr-state', prUrl),
  getPrFiles: (prUrl: string): Promise<ChangedFile[]> => ipcRenderer.invoke('get-pr-files', prUrl),
  platform: process.platform,
  isPackaged: process.env.APP_IS_PACKAGED === '1',
});
