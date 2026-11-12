import type { ReviewMember, ReviewSubject } from './workbench';
import type { ReviewHistoryEntry } from './types';

/** The fields the Muted PRs page and its listings show. The full PR stays on disk for an unmute. */
export type MutedPrSummary = Pick<
  ReviewMember,
  'url' | 'repo' | 'number' | 'title' | 'author' | 'state' | 'merged' | 'isDraft'
>;
export interface MutedPr {
  member: MutedPrSummary;
  mutedAt: string;
}
/** Muting sends the PRs to save. Unmuting needs only their URLs: the saved PRs are restored. */
export type MutePrRequest = { muted: true; members: ReviewMember[] } | { muted: false; urls: string[] };

export function isMutedReview(
  entry: Pick<ReviewHistoryEntry, 'prUrl' | 'snapshot'>,
  urls: ReadonlySet<string>
): boolean {
  return urls.has(entry.prUrl) || !!entry.snapshot?.subject.members.some((member) => urls.has(member.url));
}

/** Keep remaining stack members together, without leaking hidden metadata or old briefings. */
export function withoutMutedMembers(subject: ReviewSubject, urls: ReadonlySet<string>): ReviewSubject | undefined {
  const members = subject.members.filter((member) => !urls.has(member.url));
  if (!members.length) return undefined;
  if (members.length === subject.members.length) return subject;
  return {
    ...subject,
    id: subject.id,
    kind: subject.kind,
    title: subject.name ?? subject.title,
    members,
    edges: subject.edges.filter((edge) => !urls.has(edge.parent) && !urls.has(edge.child)),
    warnings: [],
  };
}
