import type { InspectionLoadOptions } from '../lib/pr-changes';
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
import type { WorkbenchQueue, GroupingOverride, ReviewSnapshot } from '../lib/workbench';
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

declare global {
  interface Window {
    electronAPI: {
      preparePrReview: (url: string, revision: { baseSha: string; headSha: string }) => Promise<void>;
      getPrCommits: (url: string, refresh?: boolean, options?: InspectionLoadOptions) => Promise<PrCommits>;
      getCommitComparison: (selection: CommitSelection, background?: boolean) => Promise<PrChanges>;
      getPrChanges: (url: string, refresh?: boolean, options?: InspectionLoadOptions) => Promise<PrChanges>;
      getPrChangeFile: (request: PrFileRequest, background?: boolean) => Promise<PrFileContents>;
      checkPrChanges: (url: string) => Promise<{ baseSha: string; headSha: string }>;
      askPrFile: (request: FileChatRequest) => Promise<string>;
      getGitHubProfile: (login:string) => Promise<GitHubProfile>;
      getQueueSignals: (requests: QueueSignalRequest[], options?: QueueSignalOptions) => Promise<QueueSignals[]>;
      commandSearch: (query: string, includeBots?: boolean, recentIds?: string[]) => Promise<LocalSearchResponse>;
      commandGitHubSearch: (query: string) => Promise<PrSearchResult[]>;
      listActivity: () => Promise<ActivityTask[]>;
      activityAction: (id:string, action:ActivityAction) => Promise<void>;
      workbenchSnapshot: () => Promise<WorkbenchQueue>;
      workbenchMutePrs: (request: MutePrRequest) => Promise<WorkbenchQueue>;
      workbenchStarPrs: (request: StarPrRequest) => Promise<WorkbenchQueue>;
      workbenchViewAction: (action: QueueViewAction) => Promise<WorkbenchQueue>;
      workbenchSetFilters: (filters: QueueFilters) => Promise<WorkbenchQueue>;
      workbenchQueue: (force?: boolean) => Promise<WorkbenchQueue>;
      workbenchGroup: (correction: GroupingOverride) => Promise<WorkbenchQueue>;
      workbenchBriefing: (id: string) => Promise<WorkbenchQueue>;
      workbenchFreshness: (snapshot: ReviewSnapshot) => Promise<FreshnessResult>;
      generateExplainer: (req: GenerateExplainerRequest) => Promise<InteractiveExplainer>;
      cancelExplainer: (req: GenerateExplainerRequest) => Promise<void>;
      startReview: (req: GenerateReviewRequest) => Promise<StartReviewResult>;
      cancelReview: (reviewId: string) => Promise<void>;
      getConfig: () => Promise<{ githubToken: string | null }>;
      githubAuthOptions: () => Promise<{ web: boolean }>;
      startOAuth: () => Promise<void>;
      cancelOAuth: () => Promise<void>;
      beginGitHubSignIn: () => Promise<GitHubDevicePrompt>;
      completeGitHubSignIn: (id: string) => Promise<string>;
      cancelGitHubSignIn: (id: string) => Promise<void>;
      getAuthState: () => Promise<{ authenticated: boolean; login: string | null }>;
      signOut: () => Promise<void>;
      savePat: (token: string, prUrl?: string) => Promise<string>;
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
      getPrStatus: (prUrl: string, force?: boolean) => Promise<PrStatus>;
      getPrMetadata: (prUrl: string) => Promise<PrMetadata>;
      loadReviewImages: (reviewId: string, filePath: string) => Promise<import('../lib/review-images').ReviewImageComparison>;
      loadPrImage: (url: string) => Promise<string>;
      getReviewThreads: (prUrl: string, refresh?: boolean) => Promise<GitHubReviewThreads>;
      createReviewComment: (req: CreateReviewCommentRequest) => Promise<void>;
      reviewCommentAction: (req: ReviewCommentAction) => Promise<GitHubReviewThread>;
      reviewThreadAction: (req: ReviewThreadAction) => Promise<GitHubReviewThread>;
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
      pickRepoDir: () => Promise<string | null>;
      listRepoRefs: (
        repoPath: string,
      ) => Promise<{
        branches: string[];
        tags: string[];
        defaultBase: string | null;
        defaultHead: string | null;
        error?: string;
      }>;
      validateLocalRepo: (
        repoPath: string,
        baseRef: string,
        headRef: string,
      ) => Promise<
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
      >;
      platform: NodeJS.Platform;
      isPackaged: boolean;
    };
  }
}

export {};
