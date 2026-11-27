export const FILE_PROGRESS_KEY = 'gnosis-file-progress:v1';
export const isReviewStateKey = (key: string) =>
  key === 'gnosis-markdown-view:v1' ||
  key === FILE_PROGRESS_KEY ||
  /^gnosis-(?:explanation-position|feedback-read|feedback-options|agent-brief|changes-drafts|drafts|viewed-files|viewed-parts|recently-viewed|workspace-tabs|saved-queue):/.test(
    key
  );
export interface ReviewStateWrite {
  key: string;
  value: unknown;
}
export interface FileProgressPatch {
  aliases: Record<string, string>;
  marks: Record<string, boolean>;
  /**
   * What each ticked item's content was when it was ticked, by its mark's key (lib/review-prints.ts): a tick carries to
   * a new revision of the file only where the item reads the same. Absent from progress saved before them.
   */
  prints?: Record<string, string>;
}
