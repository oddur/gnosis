import type { Root } from 'hast';
import type { GitHubMarkdownSource } from './github-markdown';
export type MarkdownSide = 'before' | 'after';
export interface MarkdownLocation {
  side: MarkdownSide;
  start: number;
  end: number;
}
export interface MarkdownReviewRequest {
  before: string | null;
  after: string | null;
  beforeSource: GitHubMarkdownSource;
  afterSource: GitHubMarkdownSource;
}
export interface MarkdownReviewBlock {
  id: string;
  change: 'unchanged' | 'added' | 'removed' | 'changed' | 'moved';
  tree: Root;
  before?: MarkdownLocation;
  after?: MarkdownLocation;
}
export interface MarkdownReview {
  blocks: MarkdownReviewBlock[];
  clean: Root;
  deleted: boolean;
  sourceOnly: boolean;
}
export const isMarkdownFile = (path: string) => /\.(md|markdown|mdown|mkd)$/i.test(path);
