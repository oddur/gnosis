import type { Briefing, ReviewMember, ReviewSubject } from './workbench';
import type { QueueSignals } from './queue-signals';
export interface PrBadgePreview {
  member: Pick<
    ReviewMember,
    | 'url'
    | 'number'
    | 'repo'
    | 'title'
    | 'author'
    | 'headSha'
    | 'baseBranch'
    | 'headBranch'
    | 'merged'
    | 'state'
    | 'isDraft'
    | 'updatedAt'
    | 'commentCount'
  >;
  briefing?: Pick<Briefing, 'status' | 'summary' | 'updatedAt'>;
  stack?: { title: string; count: number };
  savedReview?: boolean;
  signals?: QueueSignals;
}
/** Send only the preview fields, never the full PR description or review data. */
export function prBadgePreview(
  member: ReviewMember,
  subject?: ReviewSubject,
  briefing?: Briefing,
  savedReview = false
): PrBadgePreview {
  const {
    url,
    number,
    repo,
    title,
    author,
    headSha,
    baseBranch,
    headBranch,
    merged,
    state,
    isDraft,
    updatedAt,
    commentCount,
  } = member;
  return {
    member: {
      url,
      number,
      repo,
      title,
      author,
      headSha,
      baseBranch,
      headBranch,
      merged,
      state,
      isDraft,
      updatedAt,
      commentCount,
    },
    briefing: briefing
      ? { status: briefing.status, summary: briefing.summary, updatedAt: briefing.updatedAt }
      : undefined,
    stack: subject?.kind === 'stack' ? { title: subject.title, count: subject.members.length } : undefined,
    savedReview,
  };
}
