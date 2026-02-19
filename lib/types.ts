export type SlideType =
  | 'foundation'
  | 'feature'
  | 'refactor'
  | 'bugfix'
  | 'test'
  | 'config'
  | 'docs';

export interface DiffHunk {
  filePath: string;
  hunkHeader: string;
  content: string;
  language: string;
  renderedHtml: string;
}

export interface Slide {
  id: string;
  slideNumber: number;
  title: string;
  slideType: SlideType;
  narrative: string;
  reviewFocus: string;
  diffHunks: DiffHunk[];
  contextSnippets: string[];
  affectedFiles: string[];
  dependsOn: string[];
  mermaidDiagram?: string | null;
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
  slides: Slide[];
}

export interface ReviewHistoryEntry {
  id: string;
  prTitle: string;
  prUrl: string;
  author: string;
  riskLevel: 'low' | 'medium' | 'high';
  savedAt: string; // ISO date string
}

export interface GenerateReviewRequest {
  prUrl: string;
  model: 'opus' | 'sonnet';
  instructions?: string;
  thinking?: boolean;
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

export interface PrMetadata {
  title: string;
  description: string;
  author: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  merged: boolean;
  createdAt: string;
  updatedAt: string;
  url: string;
}
