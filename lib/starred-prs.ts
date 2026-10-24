import type { QueueItem, ReviewMember, ReviewSubject } from './workbench';

export interface StarredPr {
  member: ReviewMember;
  starredAt: string;
}
export interface StarPrRequest {
  members: ReviewMember[];
  starred: boolean;
}

export function isStarredSubject(subject: ReviewSubject, urls: ReadonlySet<string>): boolean {
  return subject.members.some((member) => urls.has(member.url));
}

/** Stable partition keeps the existing priority within each group. */
export function starredFirst<T>(items: T[], starred: (item: T) => boolean): T[] {
  return [...items.filter(starred), ...items.filter((item) => !starred(item))];
}

export function orderQueueItems(items: QueueItem[]): QueueItem[] {
  return starredFirst(
    (['updated', 'requested', 'other'] as const).flatMap((category) =>
      items.filter((item) => item.attention === category)
    ),
    (item) => !!item.starred
  );
}
