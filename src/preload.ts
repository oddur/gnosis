import type { GitHubSyncInterest, GitHubSyncEvent } from '../lib/github-sync';
import type { OnboardingState, SetupDraft } from '../lib/onboarding';
import type { HarnessEnvironment, EnvironmentVariable } from '../lib/harness-environment';
import type { CheckTarget, CheckSelection, ChecksOptions, PrChecks, CheckDetails, CheckLog } from '../lib/pr-checks';
import type { ExplanationMarkdownRequest } from '../lib/explanation-markdown';
import type { MarkdownReviewRequest, MarkdownReview } from '../lib/markdown-review';
import type { FileKinds, FileFilterState } from '../lib/file-kinds';
import type { FileFilterAction } from './file-filter-state';
import type { ReviewStateWrite, FileProgressPatch } from '../lib/review-state';
import type { MarkPrReadRequest } from '../lib/pr-read-state';
import type { PreparedInventories } from '../lib/pr-inspection-cache';
import type { InspectionRevision, InspectionLoadOptions } from '../lib/pr-changes';
import type { MutePrRequest } from '../lib/muted-prs';
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
import type { WorkbenchQueue, GroupingOverride, ReviewSnapshot, ReviewSubject } from '../lib/workbench';
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
  githubSyncVersion: 1 as const,
  watchGitHub: (id: string, interest: GitHubSyncInterest | null) => ipcRenderer.send('github-sync-watch', id, interest),
  onGitHubSync: (callback: (event: GitHubSyncEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: GitHubSyncEvent) => callback(value);
    ipcRenderer.on('github-sync', handler);
    return () => ipcRenderer.removeListener('github-sync', handler);
  },
  onWorkbenchChanged: (callback: () => void) => {
    ipcRenderer.on('workbench-changed', callback);
    return () => ipcRenderer.removeListener('workbench-changed', callback);
  },
  onActivityChanged: (callback: () => void) => {
    ipcRenderer.on('activity-changed', callback);
    return () => ipcRenderer.removeListener('activity-changed', callback);
  },
  getPrBadgePreview: (url: string): Promise<import('../lib/pr-badge-preview').PrBadgePreview | null> => ipcRenderer.invoke('pr-badge-preview', url),
  loadFileFilters: (): Promise<FileFilterState> => ipcRenderer.invoke('load-file-filters'),
  updateFileFilters: (action: FileFilterAction): Promise<FileFilterState> => ipcRenderer.invoke('update-file-filters', action),
  getFileClassifications: (request: PrFileRequest): Promise<Record<string,FileKinds>> => ipcRenderer.invoke('file-classifications', request),
  onFileFiltersChanged: (callback: (state:FileFilterState)=>void) => {
    const handler=(_event:Electron.IpcRendererEvent,state:FileFilterState)=>callback(state);
    ipcRenderer.on('file-filters-changed',handler);return ()=>ipcRenderer.removeListener('file-filters-changed',handler);
  },
  onFileClassificationsChanged: (callback: (key:string,kinds:Record<string,FileKinds>)=>void) => {
    const handler=(_event:Electron.IpcRendererEvent,value:{key:string;kinds:Record<string,FileKinds>})=>callback(value.key,value.kinds);
    ipcRenderer.on('file-classifications-changed',handler);return ()=>ipcRenderer.removeListener('file-classifications-changed',handler);
  },
  onHistoryNavigate: (callback: (direction: -1 | 1) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, direction: unknown) => {
      if (direction === -1 || direction === 1) callback(direction);
    };
    ipcRenderer.on('history-navigate', handler);
    return () => ipcRenderer.removeListener('history-navigate', handler);
  },
  clearGitHubCache: (): Promise<void> => ipcRenderer.invoke('clear-github-cache'),
  getPreparedInventories: (revisions: InspectionRevision[]): Promise<PreparedInventories> => ipcRenderer.invoke('prepared-inventories', revisions),
  preparePrReview: (url: string, revision: { baseSha: string; headSha: string }): Promise<void> => ipcRenderer.invoke('prepare-pr-review', url, revision),
  getPrCommits: (url: string, refresh = false, options?: InspectionLoadOptions): Promise<PrCommits> => ipcRenderer.invoke('pr-commits', url, refresh, options),
  getCommitComparison: (selection: CommitSelection, background?: boolean): Promise<PrChanges> => ipcRenderer.invoke('commit-comparison', selection, background),
  renderMarkdownReview: (request: MarkdownReviewRequest | ExplanationMarkdownRequest): Promise<MarkdownReview> => ipcRenderer.invoke('markdown-review', request),
  getStackChanges: (subject: ReviewSubject, refresh = false, options?: InspectionLoadOptions): Promise<PrChanges> => ipcRenderer.invoke('stack-changes', subject, refresh, options),
  getPrChanges: (url: string, refresh = false, options?: InspectionLoadOptions): Promise<PrChanges> => ipcRenderer.invoke('pr-changes', url, refresh, options),
  cancelInspection: (requestId: string): Promise<void> => ipcRenderer.invoke('cancel-inspection', requestId),
  getPrChangeFile: (request: PrFileRequest, background?: boolean): Promise<PrFileContents> => ipcRenderer.invoke('pr-change-file', request, background),
  checkPrChanges: (url: string): Promise<{ baseSha: string; headSha: string }> => ipcRenderer.invoke('pr-changes-revision', url),
  cancelChat: (requestId: string): Promise<void> => ipcRenderer.invoke('cancel-chat', requestId),
  onFileChatProgress: (callback: (event: { requestId: string; chunk: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: { requestId: string; chunk: string }) => callback(value);
    ipcRenderer.on('file-chat-progress', listener);
    return () => ipcRenderer.removeListener('file-chat-progress', listener);
  },
  askPrFile: (request: FileChatRequest): Promise<string> => ipcRenderer.invoke('ask-pr-file', request),
  getGitHubProfile: (login:string):Promise<GitHubProfile> => ipcRenderer.invoke('get-github-profile',login),
  getQueueSignals: (requests: QueueSignalRequest[], options?: QueueSignalOptions): Promise<QueueSignals[]> => ipcRenderer.invoke('get-queue-signals', requests, options),
  commandSearch: (query: string, includeBots = false, recentIds: string[] = []): Promise<LocalSearchResponse> => ipcRenderer.invoke('command-search', query, includeBots, recentIds),
  commandGitHubSearch: (query: string): Promise<PrSearchResult[]> => ipcRenderer.invoke('command-github-search', query),
  reviewStateStorageVersion: 1 as const,
  loadReviewState: (legacy: Record<string,string>): Promise<Record<string,unknown>> => ipcRenderer.invoke('load-review-state',legacy),
  saveReviewState: (value: ReviewStateWrite): Promise<void> => ipcRenderer.invoke('save-review-state',value),
  saveFileProgress: (value: FileProgressPatch): Promise<void> => ipcRenderer.invoke('save-file-progress',value),
  listActivity: (): Promise<ActivityTask[]> => ipcRenderer.invoke('list-activity'),
  activityAction: (id:string, action:ActivityAction): Promise<void> => ipcRenderer.invoke('activity-action',id,action),
  workbenchMarkPrRead: (request: MarkPrReadRequest): Promise<WorkbenchQueue> => ipcRenderer.invoke('workbench-mark-pr-read', request),
  onPrReadStateChanged: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('pr-read-state-changed', handler);
    return () => ipcRenderer.removeListener('pr-read-state-changed', handler);
  },
  workbenchSnapshot: (): Promise<WorkbenchQueue> => ipcRenderer.invoke('workbench-snapshot'),
  workbenchRenameStack: (id: string, name: string, account?: string): Promise<WorkbenchQueue> => ipcRenderer.invoke('workbench-rename-stack', id, name, account),
  workbenchMutePrs: (request: MutePrRequest): Promise<WorkbenchQueue> => ipcRenderer.invoke('workbench-mute-prs', request),
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
  conflictResolution: (request: import('../lib/conflict-resolution').ConflictRequest): Promise<import('../lib/conflict-resolution').ConflictReply> => ipcRenderer.invoke('conflict-resolution', request),
  getPrActionState: (url: string, force = false): Promise<import('../lib/pr-actions').PrActionState> => ipcRenderer.invoke('get-pr-action-state', url, force),
  getStackMergePlan: (urls: string[]): Promise<import('../lib/pr-actions').PrMergePlan> => ipcRenderer.invoke('get-stack-merge-plan', urls),
  performPrAction: (request: import('../lib/pr-actions').PrActionRequest): Promise<import('../lib/pr-actions').PrActionResult> => ipcRenderer.invoke('perform-pr-action', request),
  submitReview: (req: SubmitReviewRequest): Promise<{ reviewUrl: string; droppedCommentCount: number }> =>
    ipcRenderer.invoke('submit-review', req),
  checkPrFreshness: (prUrl: string, headSha: string | undefined): Promise<FreshnessResult> =>
    ipcRenderer.invoke('check-pr-freshness', prUrl, headSha),
  loadOnboarding: (): Promise<OnboardingState> => ipcRenderer.invoke('load-onboarding'),
  saveOnboarding: (state: OnboardingState, account: string | null): Promise<void> => ipcRenderer.invoke('save-onboarding', state, account),
  applyOnboarding: (draft: SetupDraft, account: string | null): Promise<Preferences> => ipcRenderer.invoke('apply-onboarding', draft, account),
  loadHarnessEnvironment: (): Promise<HarnessEnvironment> => ipcRenderer.invoke('load-harness-environment'),
  saveHarnessEnvironment: (provider: import('../lib/models').Provider, variables: EnvironmentVariable[]): Promise<void> => ipcRenderer.invoke('save-harness-environment', provider, variables),
  onPreferencesChanged: (callback: (prefs: Preferences) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, prefs: Preferences) => callback(prefs);
    ipcRenderer.on('preferences-changed', handler);
    return () => { ipcRenderer.removeListener('preferences-changed', handler); };
  },
  loadPreferences: (): Promise<Preferences> => ipcRenderer.invoke('load-preferences'),
  savePreferences: (prefs: Preferences): Promise<void> => ipcRenderer.invoke('save-preferences', prefs),
  searchPullRequests: (): Promise<PrSearchResult[]> => ipcRenderer.invoke('search-pull-requests'),
  searchRepos: (query: string): Promise<RepoSearchResult[]> => ipcRenderer.invoke('search-repos', query),
  reRenderHunks: (review: ReviewGuide): Promise<ReviewGuide> => ipcRenderer.invoke('re-render-hunks', review),
  getPrChecks: (target: CheckTarget, options?: ChecksOptions): Promise<PrChecks | undefined> => ipcRenderer.invoke('pr-checks', target, options),
  getCheckDetails: (target: CheckSelection): Promise<CheckDetails> => ipcRenderer.invoke('check-details', target),
  getCheckLog: (target: CheckSelection): Promise<CheckLog> => ipcRenderer.invoke('check-log', target),
  rerunChecks: (target: CheckSelection & { mode: 'failed' | 'all' }): Promise<void> => ipcRenderer.invoke('rerun-checks', target),
  getPrStatus: (prUrl: string, force?: boolean): Promise<PrStatus> => ipcRenderer.invoke('get-pr-status', prUrl, force),
  getPrMetadata: (prUrl: string): Promise<PrMetadata> => ipcRenderer.invoke('get-pr-metadata', prUrl),
  loadReviewImages: (reviewId: string, filePath: string, downloadLfs = false): Promise<import('../lib/review-images').ReviewImageComparison> => ipcRenderer.invoke('load-review-images', reviewId, filePath, downloadLfs),
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
  checkCliInstalled: (provider: string, refresh = false): Promise<{ installed: boolean; resolvedPath: string }> =>
    ipcRenderer.invoke('check-cli-installed', provider, refresh),
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
  getLocalClones: (): Promise<import('../lib/local-clone').LocalCloneStatus[]> => ipcRenderer.invoke('local-clones'),
  connectLocalClone: (repo: string, directory: string): Promise<import('../lib/local-clone').LocalCloneStatus[]> => ipcRenderer.invoke('connect-local-clone', repo, directory),
  disconnectLocalClone: (repo: string): Promise<import('../lib/local-clone').LocalCloneStatus[]> => ipcRenderer.invoke('disconnect-local-clone', repo),
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
