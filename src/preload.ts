import { contextBridge, ipcRenderer } from 'electron';
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

contextBridge.exposeInMainWorld('electronAPI', {
  generateReview: (req: GenerateReviewRequest): Promise<ReviewGuide> => ipcRenderer.invoke('generate-review', req),
  getConfig: (): Promise<{ githubToken: string | null }> => ipcRenderer.invoke('get-config'),
  startOAuth: (): Promise<void> => ipcRenderer.invoke('start-oauth'),
  getAuthState: (): Promise<{ authenticated: boolean; login: string | null }> => ipcRenderer.invoke('get-auth-state'),
  signOut: (): Promise<void> => ipcRenderer.invoke('sign-out'),
  listReviews: (): Promise<ReviewHistoryEntry[]> => ipcRenderer.invoke('list-reviews'),
  loadReview: (id: string): Promise<ReviewGuide> => ipcRenderer.invoke('load-review', id),
  deleteReview: (id: string): Promise<void> => ipcRenderer.invoke('delete-review', id),
  deleteAllReviews: (): Promise<void> => ipcRenderer.invoke('delete-all-reviews'),
  onReviewProgress: (callback: (chunk: string, isThinking: boolean) => void): void => {
    ipcRenderer.on('review-progress', (_event, { chunk, isThinking }: { chunk: string; isThinking: boolean }) =>
      callback(chunk, isThinking)
    );
  },
  offReviewProgress: (): void => {
    ipcRenderer.removeAllListeners('review-progress');
  },
  onReviewToolUse: (callback: (toolName: string) => void): void => {
    ipcRenderer.on('review-tool-use', (_event, { toolName }: { toolName: string }) => callback(toolName));
  },
  offReviewToolUse: (): void => {
    ipcRenderer.removeAllListeners('review-tool-use');
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
  dismissUpdate: (version: string): Promise<void> => ipcRenderer.invoke('dismiss-update', version),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('open-external', url),
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
  platform: process.platform,
});
