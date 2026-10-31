import type { SvgIllustration } from './svg-illustration';
import type { MechanismScene } from './mechanism';
import type { ReviewSnapshot } from './workbench';
import type { ModelId, Provider } from './models';

export type SlideType = 'foundation' | 'feature' | 'refactor' | 'bugfix' | 'test' | 'config' | 'docs';

export interface CiCheck {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
  url: string | null;
}

export interface ReviewSummary {
  approved: number;
  changesRequested: number;
  commented: number;
}

export interface DiffHunk {
  filePath: string;
  hunkHeader: string;
  content: string;
  language: string;
  renderedHtml: string;
}

export interface ReviewCheck {
  text: string;
  filePath?: string;
  startLine?: number;
}

export interface EducationNote {
  concept: string;
  explanation: string;
}

export type SlideImportance = 'critical' | 'important' | 'minor';

export interface ExplainerIdea {
  title: string;
  description: string;
}

export interface InteractiveExplainer {
  version: 1;
  title: string;
  description: string;
  assumptions: string[];
  sources: { filePath: string; explanation: string }[];
  html: string;
  css: string;
  javascript: string;
}

export interface GenerateExplainerRequest {
  reviewId: string;
  slideId: string;
  refinement?: string;
}

export interface FileChangeSummary {
  filePath: string;
  summary: string;
}

export interface InlineExplanation {
  filePath: string;
  line: number;
  side: DiffSide;
  /** Exact source line, used to verify the generated location before display. */
  code: string;
  text: string;
}

/** Saved D2 source; named captions identify the overview or a native board path. */
export interface D2DiagramSpec {
  source: string;
  caption?: string;
  kind?: 'map' | 'walkthrough' | 'comparison';
  steps?: {
    board?: string;
    title: string;
    description: string;
    /** Exact D2 node or connection identifiers to spotlight on a shared board. */
    focus?: string[];
    /** The meaningful event or difference from the previous view. */
    change?: string;
    evidence?: { filePath: string; startLine: number };
  }[];
}

export interface Slide {
  id: string;
  slideNumber: number;
  title: string;
  slideType: SlideType;
  narrative: string;
  reviewFocus: string | null;
  diffHunks: DiffHunk[];
  contextSnippets: string[];
  affectedFiles: string[];
  /** Short file header summaries scoped to the hunks in this topic. */
  fileSummaries?: FileChangeSummary[];
  inlineExplanations?: InlineExplanation[];
  dependsOn: string[];
  mermaidDiagram?: string | null;
  d2Diagram?: D2DiagramSpec | null;
  mechanism?: MechanismScene | null;
  svgIllustration?: SvgIllustration | null;
  reviewChecks?: ReviewCheck[];
  educationNotes?: EducationNote[];
  // AI-assigned importance. "critical" = auth, data integrity, API
  // contract changes. "important" = core logic, new features.
  // "minor" = config, docs, test boilerplate, import reordering.
  importance?: SlideImportance;
  explainerIdea?: ExplainerIdea | null;
  explainer?: InteractiveExplainer;
  /** Snapshot of relevant source at review time, used only on demand. */
  explainerContext?: string;
}

// Intermediate types for raw AI response (before hunk resolution)
export interface AISlide {
  id: string;
  slideNumber: number;
  title: string;
  slideType: SlideType;
  narrative: string;
  reviewFocus: string | null;
  diffHunkIds: string[];
  contextSnippets: string[];
  affectedFiles: string[];
  /** Short file header summaries scoped to the hunks in this topic. */
  fileSummaries?: FileChangeSummary[];
  inlineExplanations?: InlineExplanation[];
  dependsOn: string[];
  mermaidDiagram?: string | null;
  d2Diagram?: D2DiagramSpec | null;
  mechanism?: MechanismScene | null;
  svgIllustration?: SvgIllustration | null;
  reviewChecks?: ReviewCheck[];
  educationNotes?: EducationNote[];
  importance?: SlideImportance;
  explainerIdea?: ExplainerIdea | null;
}

export interface WebSource {
  url: string;
  title: string;
}

// Claude Code conventions discovered in the target repo — fed into
// the review prompt and surfaced on the overview slide so the user
// knows what the AI saw.
export interface ProjectClaudeContext {
  /** Full CLAUDE.md contents, truncated at a hard cap. */
  projectInstructions: string | null;
  /** CLAUDE.md size in bytes before any truncation — shown in the UI. */
  projectInstructionsBytes?: number;
  commands: { name: string; summary: string }[];
  agents: { name: string; summary: string }[];
  skills: { name: string; summary: string }[];
}

export interface AIReviewGuide {
  prTitle: string;
  prDescription: string;
  prUrl: string;
  author: string;
  summary: string;
  riskLevel: 'low' | 'medium' | 'high';
  riskRationale: string;
  totalFilesChanged: number;
  totalLinesChanged: number;
  slides: AISlide[];
  webSources?: WebSource[];
}

/** A proposed teaching goal, verified by the writer against the actual source. */
export interface DiagramBrief {
  question: string;
  takeaway: string;
  assumedKnowledge: string[];
  essentialConcepts: string[];
  omit: string[];
  visualApproach: string;
}

// Planner output for two-phase review generation
export interface TopicPlan {
  title: string;
  slideType: SlideType;
  importance: SlideImportance;
  hunkIds: string[];
  dependsOn: string[];
  order: number;
  narrativeBrief: string; // 1-2 sentence direction for the writer
  diagramBrief?: DiagramBrief | string | null; // Strings preserve plans saved by earlier versions.
}

export interface PlannerOutput {
  summary: string;
  riskLevel: 'low' | 'medium' | 'high';
  riskRationale: string;
  storyArc: string; // Overall narrative thread connecting all topics
  topics: TopicPlan[];
}

// Writer output for a single slide in two-phase generation
export interface WriterSlideOutput {
  title?: string; // Source-verified title; older writers fall back to the planner title.
  fileSummaries?: FileChangeSummary[];
  inlineExplanations?: InlineExplanation[];
  narrative: string;
  reviewFocus: string | null;
  contextSnippets: string[];
  mermaidDiagram?: string | null;
  d2Diagram?: D2DiagramSpec | null;
  mechanism?: MechanismScene | null;
  svgIllustration?: SvgIllustration | null;
  reviewChecks?: ReviewCheck[];
  educationNotes?: EducationNote[];
  explainerIdea?: ExplainerIdea | null;
}

export interface FileMetadata {
  filename: string;
  previousFilename?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  // Last commit date for this file BEFORE the PR (ISO string).
  // null if the file is new (added in this PR).
  lastModified?: string | null;
  // How many commits in this PR touch this file. >1 = churn.
  prCommitCount?: number;
}

export interface ReviewGuide {
  /** Immutable revisions and eligible image paths for on-demand previews. */
  baseSha?: string;
  baseRepo?: string;
  headRepo?: string;
  imageFiles?: string[];
  snapshot?: ReviewSnapshot;
  /** Assigned by the local store when loading a saved review. */
  reviewId?: string;
  prTitle: string;
  prDescription: string;
  prUrl: string;
  author: string;
  summary: string;
  riskLevel: 'low' | 'medium' | 'high';
  riskRationale: string;
  totalFilesChanged: number;
  totalLinesChanged: number;
  neighborFileCount?: number;
  excludedFiles?: string[];
  generationDurationMs?: number;
  slides: Slide[];
  headSha?: string;
  webSources?: WebSource[];
  projectClaudeContext?: ProjectClaudeContext;
  // Full list of changed files with metadata (age, churn). Used by
  // the Remaining Changes section (files not in any slide) and by
  // file age/churn badges on diff headers.
  changedFiles?: FileMetadata[];
}

export interface PrStatus {
  checkSnapshot?: import('./pr-checks').PrChecks;
  ciError?: string;
  signals?: import('./queue-signals').QueueSignals;
  labels: string[];
  mergeable: boolean | null;
  isDraft: boolean;
  ciChecks: CiCheck[];
  ciConclusion: 'success' | 'failure' | 'pending' | 'neutral';
  reviewSummary: ReviewSummary;
  baseBranch: string;
  commitCount: number;
  requestedReviewers: string[];
  requestedTeams: string[];
  mergeableState: string | null;
  autoMerge: { method: string } | null;
  milestone: { title: string; dueOn: string | null } | null;
}

export type DiffSide = 'LEFT' | 'RIGHT';
export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export interface PendingReviewComment {
  startLine?: number;
  id: string;
  filePath: string;
  line: number;
  side: DiffSide;
  body: string;
  hunkHeader: string;
  codeSnippet: string;
  slideIndex: number;
}

export interface SubmitReviewRequest {
  baseSha?: string;
  baseBranch?: string;
  prUrl: string;
  headSha: string;
  event: ReviewEvent;
  body: string;
  comments: { path: string; line: number; startLine?: number; side: DiffSide; body: string }[];
}

export interface ReviewHistoryEntry {
  snapshot?: ReviewSnapshot;
  id: string;
  prTitle: string;
  prUrl: string;
  author: string;
  riskLevel: 'low' | 'medium' | 'high';
  status?: 'generating' | 'completed' | 'failed'; // undefined defaults to 'completed' (backward compat)
  error?: string;
  model?: ModelId;
  generationDurationMs?: number;
  savedAt: string; // ISO date string
  unread?: boolean;
  prState?: 'open' | 'merged' | 'closed';
  prHeadSha?: string;
  /** First ~200 chars of the AI summary, used as article lede on the homepage. */
  summary?: string;
  /** True when this review was auto-regenerated by proactive mode because the PR head changed. */
  autoUpdated?: boolean;
  /** True when the review was imported from a .gr archive rather than generated locally. */
  imported?: boolean;
}

export interface StartReviewResult {
  reviewId: string;
  prTitle: string;
  prUrl: string;
  author: string;
}

export type { ClaudeModel, CodexModel, ModelId, Provider } from './models';

export interface Preferences {
  repositorySettings?: import('./repository-settings').RepositorySettingsMap;
  /** Default per-repository cap. briefingDailyLimit remains the overall cap. */
  repositoryBriefingDailyLimit?: number;
  savedReviewSort?: import('./pr-list-sort').PrListSort;
  githubCacheSizeMB?: number;
  ignoreDependabotPrs?: boolean;
  /** Days since the last PR update; zero disables the global inactivity limit. */
  prInactivityDays?: number;
  /** Default automation policy; individual repositories may override it. */
  autoBriefings?: boolean;
  /** Overall cap on automatic attempts. Explicit requests do not count. */
  briefingDailyLimit?: number;
  instructions: string;
  provider: Provider;
  model: ModelId;
  thinking: boolean;
  effort?: import('./effort').Effort;
  smartImports: boolean;
  reviewSuggestions: boolean;
  enableTools: boolean;
  enableWebResearch: boolean;
  proactiveMode: boolean;
  watchedRepos: string[];
  /** Applied at renderer startup, before any diffs mount. */
  diffHighlighter?: import('./diff-highlighter-preference').DiffHighlighter;
  codeTheme: string;
  codeFont: string;
  claudePath: string;
  codexPath: string;
  notifications: boolean;
  diffLayout: 'unified' | 'split';
  stackChangesMode?: 'combined' | 'by-pr';
  diffAppearance?: import('./review-diff').DiffAppearance;
  showInlineExplanations?: boolean;
  includeAllFiles: boolean;
  reviewSignature: boolean;
  firstRunSeen: boolean;
  theme: 'light' | 'dark' | 'system';
  trayEnabled: boolean;
  maxPrsPerRepo: number;
  parallelReview: boolean;
  analytics: boolean;
  /** When true, proactive reviews use the proactiveProvider/Model/Thinking fields
   *  below instead of the regular provider/model/thinking. Lets users run a fast
   *  cheap model (e.g. Sonnet) for background reviews while keeping Opus for
   *  manual, hand-picked ones. */
  proactiveReviewOverrides: boolean;
  proactiveProvider: Provider;
  proactiveModel: ModelId;
  proactiveThinking: boolean;
  proactiveEffort?: import('./effort').Effort;
  educationMode: boolean;
  claudeContext: boolean;
  /** True once the user has opted in to using Gnosis without a GitHub
   *  account. Unlocks the rest of the app (compose form, history, local
   *  review) for users who only want to review local git diffs. */
  guestMode: boolean;
}

export interface SendSlideChatRequest {
  requestId?: string;
  prTitle: string;
  prDescription: string;
  summary: string;
  slideTitle: string;
  slideNarrative: string;
  slideReviewFocus: string | null;
  affectedFiles: string[];
  diffContent: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  question: string;
  provider: Provider;
  model: ModelId;
  effort?: import('./effort').Effort;
}

export interface GenerateReviewRequest {
  standalone?: boolean;
  subjectId?: string;
  memberUrls?: string[];
  prUrl: string;
  provider: Provider;
  model: ModelId;
  instructions?: string;
  thinking?: boolean;
  effort?: import('./effort').Effort;
  smartImports?: boolean;
  reviewSuggestions?: boolean;
  webResearch?: boolean;
  educationMode?: boolean;
  claudeContext?: boolean;
  excludedFiles?: string[];
  /** Local reviews only. When true, Claude runs with cwd=repoPath and can
   *  discover the repo's project-local config (.mcp.json, .claude/settings.json,
   *  skills) plus run read-only shell tools like tests. Ignored for GitHub URLs. */
  localTools?: boolean;
}

export interface GenerateReviewResponse {
  review: ReviewGuide;
}

export interface ChangedFile {
  sha?: string;
  filename: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  previous_filename?: string;
  patch?: string;
}

export interface FreshnessCommit {
  sha: string;
  message: string;
  authorLogin: string;
  authorDate: string;
}

export type FreshnessResult =
  | { status: 'current' }
  | { status: 'stale'; aheadBy: number; commits: FreshnessCommit[]; reason?: string }
  | { status: 'force-pushed' }
  | { status: 'unknown'; reason: string };

export interface PrSearchResult {
  number: number;
  title: string;
  url: string;
  repoOwner: string;
  repoName: string;
  author: string;
  updatedAt: string;
  isDraft: boolean;
  role: 'author' | 'assigned' | 'review-requested' | 'watched';
}

export interface RepoSearchResult {
  fullName: string;
  description: string | null;
}

export interface UpdateInfo {
  version: string;
  releaseUrl: string;
}

export interface PrLabel {
  name: string;
  color?: string;
  description?: string;
}

export interface PrMetadata {
  /** Archive state of the target repository; absent in older saved reviews. */
  repoArchived?: boolean;
  /** Conversation comments, excluding inline review threads. Optional for older snapshots. */
  commentCount?: number;
  /** Inline review comments, including replies; supplied by the existing PR detail read. */
  reviewCommentCount?: number;
  changedFileCount?: number;
  additions?: number;
  deletions?: number;
  headRepo?: string;
  baseRepo?: string;
  title: string;
  description: string;
  author: string;
  assignees?: string[];
  baseBranch: string;
  headBranch: string;
  baseSha: string;
  headSha: string;
  merged: boolean;
  state: 'open' | 'closed';
  createdAt: string;
  updatedAt: string;
  url: string;
  labels: string[];
  labelDetails?: PrLabel[];
  mergeable: boolean | null;
  isDraft: boolean;
  commitCount: number;
  requestedReviewers: string[];
  requestedTeams: string[];
  mergeableState: string | null;
  autoMerge: { method: string } | null;
  milestone: { title: string; dueOn: string | null } | null;
}
