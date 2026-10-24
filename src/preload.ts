import type { StarPrRequest } from '../lib/starred-prs';
import type { PrCommits, CommitSelection } from '../lib/pr-commits';
import type { PrChanges, PrFileRequest, PrFileContents, FileChatRequest } from '../lib/pr-changes';
import type { GitHubProfile } from '../lib/github-profile';
import type { QueueSignalRequest, QueueSignals, QueueSignalOptions } from '../lib/queue-signals';
import type { LocalSearchResponse } from './command-search-service';
import type { GitHubDevicePrompt } from '../lib/github-auth';
import type { QueueViewAction } from '../lib/saved-views';
import type { QueueFilters } from '../lib/queue-filters';
import type { GitHubReviewThread, GitHubReviewThreads, ReviewThreadAction, ReviewCommentAction, CreateReviewCommentRequest } from '../lib/review-threads';
import type { ActivityTask, ActivityAction } from '../lib/activity';
import type { WorkbenchQueue, GroupingOverride, ReviewSnapshot } from '../lib/workbench';
import { contextBridge, ipcRenderer } from 'electron';
import type {
  ChangedFile,
  GenerateReviewRequest,
  Preferences,
  PrSearchResult,
  PrStatus,
  PrMetadata,
  ReviewGuide,
  ReviewHistoryEntry,
  SendSlideChatRequest,
  StartReviewResult,
  SubmitReviewRequest,
  FreshnessResult,
  RepoSearchResult,
  UpdateInfo,
  GenerateExplainerRequest,
  InteractiveExplainer,
} from '../lib/types';

contextBridge.exposeInMainWorld('electronAPI', {
  getPrCommits: (url: string, refresh = false): Promise<PrCommits> => ipcRenderer.invoke('pr-commits', url, refresh),
  getCommitComparison: (selection: CommitSelection, background?: boolean): Promise<PrChanges> => ipcRenderer.invoke('commit-comparison', selection, background),
  getPrChanges: (url: string, refresh = false): Promise<PrChanges> => ipcRenderer.invoke('pr-changes', url, refresh),
  getPrChangeFile: (request: PrFileRequest, background?: boolean): Promise<PrFileContents> => ipcRenderer.invoke('pr-change-file', request, background),
  checkPrChanges: (url: string): Promise<{ baseSha: string; headSha: string }> => ipcRenderer.invoke('pr-changes-revision', url),
  askPrFile: (request: FileChatRequest): Promise<string> => ipcRenderer.invoke('ask-pr-file', request),
  getGitHubProfile: (login:string):Promise<GitHubProfile> => ipcRenderer.invoke('get-github-profile',login),
  getQueueSignals: (requests: QueueSignalRequest[], options?: QueueSignalOptions): Promise<QueueSignals[]> => ipcRenderer.invoke('get-queue-signals', requests, options),
  commandSearch: (query: string, includeBots = false, recentIds: string[] = []): Promise<LocalSearchResponse> => ipcRenderer.invoke('command-search', query, includeBots, recentIds),
  commandGitHubSearch: (query: string): Promise<PrSearchResult[]> => ipcRenderer.invoke('command-github-search', query),
  listActivity: (): Promise<ActivityTask[]> => ipcRenderer.invoke('list-activity'),
  activityAction: (id:string, action:ActivityAction): Promise<void> => ipcRenderer.invoke('activity-action',id,action),
  workbenchStarPrs: (request: StarPrRequest): Promise<WorkbenchQueue> => ipcRenderer.invoke('workbench-star-prs', request),
  workbenchViewAction: (action: QueueViewAction): Promise<WorkbenchQueue> => ipcRenderer.invoke('workbench-view-action', action),
  workbenchSetFilters: (filters: QueueFilters): Promise<WorkbenchQueue> => ipcRenderer.invoke('workbench-set-filters', filters),
  workbenchQueue: (force = false): Promise<WorkbenchQueue> => ipcRenderer.invoke('workbench-queue', force),
  workbenchGroup: (correction: GroupingOverride): Promise<WorkbenchQueue> => ipcRenderer.invoke('workbench-group', correction),
  workbenchBriefing: (id: string): Promise<WorkbenchQueue> => ipcRenderer.invoke('workbench-briefing', id),
  workbenchFreshness: (snapshot: ReviewSnapshot): Promise<FreshnessResult> => ipcRenderer.invoke('workbench-freshness', snapshot),
  generateExplainer: (req: GenerateExplainerRequest): Promise<InteractiveExplainer> => ipcRenderer.invoke('generate-explainer', req),
  cancelExplainer: (req: GenerateExplainerRequest): Promise<void> => ipcRenderer.invoke('cancel-explainer', req),
  startReview: (req: GenerateReviewRequest): Promise<StartReviewResult> => ipcRenderer.invoke('start-review', req),
  cancelReview: (reviewId: string): Promise<void> => ipcRenderer.invoke('cancel-review', reviewId),
  getConfig: (): Promise<{ githubToken: string | null }> => ipcRenderer.invoke('get-config'),
  githubAuthOptions: (): Promise<{ web: boolean }> => ipcRenderer.invoke('github-auth-options'),
  startOAuth: (): Promise<void> => ipcRenderer.invoke('start-oauth'),
  cancelOAuth: (): Promise<void> => ipcRenderer.invoke('cancel-oauth'),
  beginGitHubSignIn: (): Promise<GitHubDevicePrompt> => ipcRenderer.invoke('begin-github-sign-in'),
  completeGitHubSignIn: (id: string): Promise<string> => ipcRenderer.invoke('complete-github-sign-in', id),
  cancelGitHubSignIn: (id: string): Promise<void> => ipcRenderer.invoke('cancel-github-sign-in', id),
  getAuthState: (): Promise<{ authenticated: boolean; login: string | null }> => ipcRenderer.invoke('get-auth-state'),
  signOut: (): Promise<void> => ipcRenderer.invoke('sign-out'),
  savePat: (token: string, prUrl?: string): Promise<string> => ipcRenderer.invoke('save-pat', token, prUrl),
  listReviews: (): Promise<ReviewHistoryEntry[]> => ipcRenderer.invoke('list-reviews'),
  loadReview: (id: string): Promise<ReviewGuide> => ipcRenderer.invoke('load-review', id),
  deleteReview: (id: string): Promise<void> => ipcRenderer.invoke('delete-review', id),
  deleteAllReviews: (): Promise<void> => ipcRenderer.invoke('delete-all-reviews'),
  exportReview: (id: string): Promise<string | null> => ipcRenderer.invoke('export-review', id),
  importReview: (): Promise<ReviewHistoryEntry | null> => ipcRenderer.invoke('import-review'),
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
  searchRepos: (query: string): Promise<RepoSearchResult[]> => ipcRenderer.invoke('search-repos', query),
  reRenderHunks: (review: ReviewGuide): Promise<ReviewGuide> => ipcRenderer.invoke('re-render-hunks', review),
  getPrStatus: (prUrl: string, force?: boolean): Promise<PrStatus> => ipcRenderer.invoke('get-pr-status', prUrl, force),
  getPrMetadata: (prUrl: string): Promise<PrMetadata> => ipcRenderer.invoke('get-pr-metadata', prUrl),
  loadReviewImages: (reviewId: string, filePath: string): Promise<import('../lib/review-images').ReviewImageComparison> => ipcRenderer.invoke('load-review-images', reviewId, filePath),
  loadPrImage: (url: string): Promise<string> => ipcRenderer.invoke('load-pr-image', url),
  getReviewThreads: (prUrl: string, refresh?: boolean): Promise<GitHubReviewThreads> => ipcRenderer.invoke('get-review-threads', prUrl, refresh),
  createReviewComment: (req: CreateReviewCommentRequest): Promise<void> => ipcRenderer.invoke('create-review-comment', req),
  reviewCommentAction: (req: ReviewCommentAction): Promise<GitHubReviewThread> => ipcRenderer.invoke('review-comment-action', req),
  reviewThreadAction: (req: ReviewThreadAction): Promise<GitHubReviewThread> => ipcRenderer.invoke('review-thread-action', req),
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
  getPendingUpdateReady: (): Promise<string | null> => ipcRenderer.invoke('get-pending-update-ready'),
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
  onShowTrayPrompt: (callback: () => void): void => {
    ipcRenderer.on('show-tray-prompt', () => callback());
  },
  offShowTrayPrompt: (): void => {
    ipcRenderer.removeAllListeners('show-tray-prompt');
  },
  markReviewRead: (id: string): Promise<void> => ipcRenderer.invoke('mark-review-read', id),
  getPrState: (prUrl: string): Promise<{ prState: 'open' | 'merged' | 'closed'; headSha: string }> =>
    ipcRenderer.invoke('get-pr-state', prUrl),
  getPrFiles: (prUrl: string): Promise<ChangedFile[]> => ipcRenderer.invoke('get-pr-files', prUrl),
  pickRepoDir: (): Promise<string | null> => ipcRenderer.invoke('pick-repo-dir'),
  listRepoRefs: (
    repoPath: string,
  ): Promise<{
    branches: string[];
    tags: string[];
    defaultBase: string | null;
    defaultHead: string | null;
    error?: string;
  }> => ipcRenderer.invoke('list-repo-refs', repoPath),
  validateLocalRepo: (
    repoPath: string,
    baseRef: string,
    headRef: string,
  ): Promise<
    | {
        ok: true;
        baseSha: string;
        headSha: string;
        mergeBase: string | null;
        changedFileCount: number;
      }
    | {
        ok: false;
        reason: 'not-a-repo' | 'same-refs' | 'unknown-ref' | 'other';
        message: string;
        ref?: string;
      }
  > => ipcRenderer.invoke('validate-local-repo', repoPath, baseRef, headRef),
  platform: process.platform,
  isPackaged: process.env.APP_IS_PACKAGED === '1',
});
