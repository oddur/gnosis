import type { PrMetadata } from './types';

export const READ_REASONS = ['new', 'commits', 'comments', 'reviews', 'state', 'manual'] as const;
export type ReadReason = (typeof READ_REASONS)[number];
export type ReadVersions = Record<ReadReason, number>;
export interface PrReadState {
  url: string;
  headSha: string;
  versions: ReadVersions;
  unread: ReadReason[];
}
export interface MarkPrReadRequest {
  account: string;
  read: boolean;
  receipts: PrReadState[];
}
export const emptyReadVersions = (): ReadVersions => ({
  new: 0,
  commits: 0,
  comments: 0,
  reviews: 0,
  state: 0,
  manual: 0,
});
export function unreadDescription(reasons: ReadReason[]): string {
  if (reasons.includes('manual')) return 'Marked as unread';
  if (reasons.includes('new')) return 'New PR';
  const labels = reasons.map(
    (reason) =>
      ({
        commits: 'new commits',
        comments: 'new comments',
        reviews: 'new reviews',
        state: 'PR status changes',
        new: 'new PR',
        manual: 'unread updates',
      })[reason]
  );
  const text = labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}` : labels[0];
  return text ? `${text[0].toUpperCase()}${text.slice(1)} since your last visit` : 'No unread updates';
}
export function prReadMetadata(meta: PrMetadata) {
  return {
    headSha: meta.headSha,
    state: `${meta.state}:${meta.merged}:${meta.isDraft}`,
    comments: meta.commentCount,
    inlineComments: meta.reviewCommentCount,
  };
}
