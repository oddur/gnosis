export const FILE_PROGRESS_KEY = 'gnosis-file-progress:v1';
export const isReviewStateKey = (key: string) =>
  key === 'gnosis-markdown-view:v1' || key === FILE_PROGRESS_KEY || /^gnosis-(?:agent-brief|changes-drafts|drafts|viewed-files|recently-viewed):/.test(key);
export interface ReviewStateWrite {
  key: string;
  value: unknown;
}
export interface FileProgressPatch {
  aliases: Record<string, string>;
  marks: Record<string, boolean>;
}
