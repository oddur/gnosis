export type SlideType = 'foundation' | 'feature' | 'refactor' | 'bugfix' | 'test' | 'config' | 'docs';

export interface CiCheck {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
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
  dependsOn: string[];
  mermaidDiagram?: string | null;
  reviewChecks?: ReviewCheck[];
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
  dependsOn: string[];
  mermaidDiagram?: string | null;
  reviewChecks?: ReviewCheck[];
}

export interface WebSource {
  url: string;
  title: string;
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

export interface ReviewGuide {
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
}

export interface PrStatus {
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
  prUrl: string;
  headSha: string;
  event: ReviewEvent;
  body: string;
  comments: { path: string; line: number; side: DiffSide; body: string }[];
}

export interface ReviewHistoryEntry {
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
}

export interface StartReviewResult {
  reviewId: string;
  prTitle: string;
  prUrl: string;
  author: string;
}

export type Provider = 'claude' | 'gemini';

export type ClaudeModel = 'claude-opus-4-6' | 'claude-sonnet-4-6' | 'claude-haiku-4-5-20251001';

export type GeminiModel =
  | 'gemini-3.1-pro-preview'
  | 'gemini-3-pro-preview'
  | 'gemini-3-flash-preview'
  | 'gemini-2.5-pro'
  | 'gemini-2.5-flash';

export type ModelId = ClaudeModel | GeminiModel;

export interface Preferences {
  instructions: string;
  provider: Provider;
  model: ModelId;
  thinking: boolean;
  signalBoost: boolean;
  smartImports: boolean;
  reviewSuggestions: boolean;
  enableTools: boolean;
  enableWebResearch: boolean;
  autoReviewOnRequest: boolean;
  codeTheme: string;
  codeFont: string;
  claudePath: string;
  geminiPath: string;
  notifications: boolean;
  diffLayout: 'unified' | 'split';
  includeAllFiles: boolean;
  reviewSignature: boolean;
}

export interface SendSlideChatRequest {
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
}

export interface GenerateReviewRequest {
  prUrl: string;
  provider: Provider;
  model: ModelId;
  instructions?: string;
  thinking?: boolean;
  signalBoost?: boolean;
  smartImports?: boolean;
  reviewSuggestions?: boolean;
  webResearch?: boolean;
  excludedFiles?: string[];
}

export interface GenerateReviewResponse {
  review: ReviewGuide;
}

export interface ChangedFile {
  filename: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  previous_filename?: string;
}

export interface FreshnessCommit {
  sha: string;
  message: string;
  authorLogin: string;
  authorDate: string;
}

export type FreshnessResult =
  | { status: 'current' }
  | { status: 'stale'; aheadBy: number; commits: FreshnessCommit[] }
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
  role: 'author' | 'review-requested';
}

export interface UpdateInfo {
  version: string;
  releaseUrl: string;
}

export interface PrMetadata {
  title: string;
  description: string;
  author: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  merged: boolean;
  state: 'open' | 'closed';
  createdAt: string;
  updatedAt: string;
  url: string;
  labels: string[];
  mergeable: boolean | null;
  isDraft: boolean;
  commitCount: number;
  requestedReviewers: string[];
  requestedTeams: string[];
  mergeableState: string | null;
  autoMerge: { method: string } | null;
  milestone: { title: string; dueOn: string | null } | null;
}
