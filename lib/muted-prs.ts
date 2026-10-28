import type { ReviewMember, ReviewSubject } from './workbench';
import type { ReviewHistoryEntry } from './types';

export interface MutedPr {
  member: ReviewMember;
  mutedAt: string;
}
export interface MutePrRequest {
  members: ReviewMember[];
  muted: boolean;
}

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
