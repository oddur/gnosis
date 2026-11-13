import type { WorkflowRuns, WorkflowGraph, WorkflowGraphInput } from '../lib/workflow-graph';
import type { GitHubSyncInterest, GitHubSyncEvent } from '../lib/github-sync';
import type { OpenTarget } from '../lib/pr-open-targets';
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
import type { WorkbenchQueue, GroupingOverride, ReviewSnapshot } from '../lib/workbench';
import type {
  ChangedFile,
  GenerateReviewRequest,
  Preferences,
  PrSearchResult,
  PrStatus,
  PrStatusOptions,
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
      githubSyncVersion?: 1;
      watchGitHub?: (id: string, interest: GitHubSyncInterest | null) => void;
      prOpenPreload?: (targets: OpenTarget[]) => void;
      prOpenIntent?: (targets: OpenTarget[] | null) => void;
      /** Committed predictions: the open PR's threads and failing check details. Resolves when they have run. */
      prOpenCommitted?: (targets: OpenTarget[] | null, label: string) => Promise<void>;
      predictWorkflowGraph?: (targets: CheckTarget[], label: string) => Promise<void>;
      predictionState?: () => Promise<import('../lib/navigation-predictor').PredictionState>;
      onPredictionState?: (callback: (state: import('../lib/navigation-predictor').PredictionState) => void) => () => void;
      onGitHubSync?: (callback: (event: GitHubSyncEvent) => void) => () => void;
      onWorkbenchChanged?: (callback: (revisions?: import('../lib/workbench-revision').WorkbenchRevisions) => void) => () => void;
      onActivityChanged?: (callback: () => void) => () => void;
      clearGitHubCache: () => Promise<void>;
      /** Database file sizes, including their write-ahead logs. */
      storageSizes: () => Promise<{ savedWorkBytes: number; githubCacheBytes: number }>;
      getPreparedInventories: (revisions: InspectionRevision[]) => Promise<PreparedInventories>;
      preparePrReview: (url: string, revision: { baseSha: string; headSha: string }) => Promise<void>;
      getPrCommits: (url: string, refresh?: boolean, options?: InspectionLoadOptions) => Promise<PrCommits>;
      getCommitComparison: (selection: CommitSelection, background?: import('../lib/pr-changes').InspectionMode) => Promise<PrChanges>;
      renderMarkdownReview: (request: MarkdownReviewRequest | ExplanationMarkdownRequest) => Promise<MarkdownReview>;
      getStackChanges: (subject: ReviewSubject, refresh?: boolean, options?: InspectionLoadOptions) => Promise<PrChanges>;
      getPrChanges: (url: string, refresh?: boolean, options?: InspectionLoadOptions) => Promise<PrChanges>;
      cancelInspection: (requestId: string) => Promise<void>;
      getPrChangeFile: (request: PrFileRequest, background?: import('../lib/pr-changes').InspectionMode) => Promise<PrFileContents>;
      checkPrChanges: (url: string) => Promise<{ baseSha: string; headSha: string }>;
      cancelChat: (requestId: string) => Promise<void>;
      onFileChatProgress: (callback: (event: { requestId: string; chunk: string }) => void) => () => void;
      askPrFile: (request: FileChatRequest) => Promise<string>;
      getGitHubProfile: (login:string) => Promise<GitHubProfile>;
      getQueueSignals: (requests: QueueSignalRequest[], options?: QueueSignalOptions) => Promise<QueueSignals[]>;
      commandSearch: (query: string, includeBots?: boolean, recentIds?: string[]) => Promise<LocalSearchResponse>;
      commandGitHubSearch: (query: string) => Promise<PrSearchResult[]>;
      reviewStateStorageVersion: 1;
      loadReviewState: (legacy: Record<string,string>) => Promise<Record<string,unknown>>;
      saveReviewState: (value: ReviewStateWrite) => Promise<void>;
      saveFileProgress: (value: FileProgressPatch) => Promise<void>;
      /** Main calls this at quit, before it closes saved data. The promise ends when pending saves are answered. */
      onFlushReviewState: (callback: () => Promise<void>) => void;
      listActivity: () => Promise<ActivityTask[]>;
      activityAction: (id:string, action:ActivityAction) => Promise<void>;
      workbenchSnapshot: (withSignals?: boolean) => Promise<WorkbenchQueue>;
      workbenchRenameStack: (id: string, name: string, account?: string) => Promise<WorkbenchQueue>;
      workbenchMutePrs: (request: MutePrRequest) => Promise<WorkbenchQueue>;
      workbenchMarkPrRead: (request: MarkPrReadRequest) => Promise<WorkbenchQueue>;
      onPrReadStateChanged: (callback: () => void) => () => void;
      workbenchStarPrs: (request: StarPrRequest) => Promise<WorkbenchQueue>;
      workbenchViewAction: (action: QueueViewAction) => Promise<WorkbenchQueue>;
      workbenchSetFilters: (filters: QueueFilters) => Promise<WorkbenchQueue>;
      workbenchQueue: (force?: boolean) => Promise<WorkbenchQueue>;
      workbenchGroup: (correction: GroupingOverride) => Promise<WorkbenchQueue>;
      workbenchBriefing: (id: string) => Promise<WorkbenchQueue>;
      workbenchFreshness: (snapshot: ReviewSnapshot) => Promise<FreshnessResult>;
      generateExplainer: (req: GenerateExplainerRequest) => Promise<InteractiveExplainer>;
      cancelExplainer: (req: GenerateExplainerRequest) => Promise<void>;
      getExplanationSetup: (req: GenerateReviewRequest) => Promise<import('../lib/explanation-options').ExplanationSetup>;
      /** GitHub's answer for a setup that came from saved data. Returns the unsubscribe function. */
      onExplanationSetupUpdate?: (
        callback: (update: import('../lib/explanation-options').ExplanationSetupUpdate) => void
      ) => () => void;
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
      /** Finished topics of a running explanation, with placeholders; null once it has finished. */
      loadDraftReview: (id: string) => Promise<ReviewGuide | null>;
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
      getPrBadgePreview: (url: string) => Promise<import('../lib/pr-badge-preview').PrBadgePreview | null>;
      loadFileFilters: () => Promise<FileFilterState>;
      updateFileFilters: (action:FileFilterAction) => Promise<FileFilterState>;
      getFileClassifications: (request:PrFileRequest) => Promise<Record<string,FileKinds>>;
      onFileFiltersChanged: (callback:(state:FileFilterState)=>void) => () => void;
      onFileClassificationsChanged: (callback:(key:string,kinds:Record<string,FileKinds>)=>void) => () => void;
      onWorkspaceShortcut: (callback: (action: NonNullable<ReturnType<typeof import('../lib/workspace-tabs').workspaceShortcut>>) => void) => () => void;
      onHistoryNavigate: (callback: (direction: -1 | 1) => void) => () => void;
      /** Whether macOS has hidden the traffic lights for full screen. Absent in browser fixtures. */
      isFullScreen?: () => Promise<boolean>;
      onFullScreenChange?: (callback: (fullScreen: boolean) => void) => () => void;
      /** Recolours the Windows and Linux caption buttons drawn over the title bar row. */
      setWindowChromeTheme?: (dark: boolean) => void;
      offReviewNavigate: () => void;
      sendSlideChat: (req: SendSlideChatRequest) => Promise<string>;
      onChatProgress: (callback: (chunk: string) => void) => void;
      offChatProgress: () => void;
      onChatTrace: (
        callback: (event: { requestId?: string; steps: import('../lib/chat-trace').ChatTraceStep[] }) => void
      ) => () => void;
      conflictResolution: (request: import('../lib/conflict-resolution').ConflictRequest) => Promise<import('../lib/conflict-resolution').ConflictReply>;
      getPrActionState: (url: string, force?: boolean) => Promise<import('../lib/pr-actions').PrActionState>;
      getStackMergePlan: (urls: string[]) => Promise<import('../lib/pr-actions').PrMergePlan>;
      performPrAction: (request: import('../lib/pr-actions').PrActionRequest) => Promise<import('../lib/pr-actions').PrActionResult>;
      submitReview: (req: SubmitReviewRequest) => Promise<{ reviewUrl: string; droppedCommentCount: number }>;
      checkPrFreshness: (prUrl: string, headSha: string | undefined) => Promise<FreshnessResult>;
      loadOnboarding: () => Promise<OnboardingState>;
      saveOnboarding: (state: OnboardingState, account: string | null) => Promise<void>;
      applyOnboarding: (draft: SetupDraft, account: string | null) => Promise<Preferences>;
      loadHarnessEnvironment: () => Promise<HarnessEnvironment>;
      saveHarnessEnvironment: (provider: import('../lib/models').Provider, variables: EnvironmentVariable[]) => Promise<void>;
      onPreferencesChanged?: (callback: (prefs: Preferences) => void) => () => void;
      loadPreferences: () => Promise<Preferences>;
      savePreferences: (prefs: Preferences) => Promise<void>;
      searchPullRequests: () => Promise<PrSearchResult[]>;
      searchRepos: (query: string) => Promise<RepoSearchResult[]>;
      reRenderHunks: (review: ReviewGuide) => Promise<ReviewGuide>;
      prepareWorkflowGraph?: (target?: CheckTarget) => Promise<void>;
      getWorkflowRuns: (target: CheckTarget, options?: ChecksOptions) => Promise<WorkflowRuns | undefined>;
      getWorkflowGraph: (input: WorkflowGraphInput, options?: ChecksOptions) => Promise<WorkflowGraph | undefined>;
      getPrChecks: (target: CheckTarget, options?: ChecksOptions) => Promise<PrChecks | undefined>;
      getCachedCheckDetails: (target: CheckSelection) => Promise<CheckDetails | undefined>;
      getCheckDetails: (target: CheckSelection, options?: { force?: boolean }) => Promise<CheckDetails>;
      getCheckLog: (target: CheckSelection) => Promise<CheckLog>;
      rerunChecks: (target: CheckSelection & { mode: 'failed' | 'all' }) => Promise<void>;
      getPrStatus: {
        /** The saved status for this head revision, or null. Never contacts GitHub. */
        (prUrl: string, force: boolean, options: PrStatusOptions & { cachedOnly: true; headSha: string }): Promise<PrStatus | null>;
        (prUrl: string, force?: boolean, options?: Omit<PrStatusOptions, 'cachedOnly'>): Promise<PrStatus>;
      };
      getPrMetadata: (prUrl: string) => Promise<PrMetadata>;
      loadReviewImages: (reviewId: string, filePath: string, downloadLfs?: boolean) => Promise<import('../lib/review-images').ReviewImageComparison>;
      loadPrImage: (url: string) => Promise<string>;
      getCachedReviewThreads: (prUrl: string) => Promise<import('../lib/review-threads').GitHubReviewThreads | undefined>;
      feedbackAction: (req: import('../lib/review-threads').FeedbackAction) => Promise<void>;
      /** `revalidate` refreshes a displayed saved copy at foreground priority. */
      getReviewThreads: (prUrl: string, refresh?: boolean, options?: { revalidate?: boolean }) => Promise<GitHubReviewThreads>;
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
      checkCliInstalled: (provider: string, refresh?: boolean) => Promise<{ installed: boolean; resolvedPath: string }>;
      onShowTrayPrompt: (callback: () => void) => void;
      offShowTrayPrompt: () => void;
      onNewReviewInHistory: (callback: () => void) => void;
      offNewReviewInHistory: () => void;
      markReviewRead: (id: string) => Promise<void>;
      getPrState: (prUrl: string) => Promise<{ prState: 'open' | 'merged' | 'closed'; headSha: string }>;
      getPrFiles: (prUrl: string) => Promise<ChangedFile[]>;
      pickRepoDir: () => Promise<string | null>;
      getLocalClones: () => Promise<import('../lib/local-clone').LocalCloneStatus[]>;
      connectLocalClone: (repo: string, directory: string) => Promise<import('../lib/local-clone').LocalCloneStatus[]>;
      disconnectLocalClone: (repo: string) => Promise<import('../lib/local-clone').LocalCloneStatus[]>;
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
      /** Present only when GNOSIS_PERF_TRACE is set. */
      perfMark?: (name: string) => void;
      /** Present only when GNOSIS_PERF_TRACE is set. Prints `[perf] <name> <value>` in main. */
      perfNote?: (name: string, value: unknown) => void;
      /** GNOSIS_PREDICT=off: navigation predictions never run. */
      predictOff?: boolean;
    };
  }
}

export {};
