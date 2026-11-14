import type { PrMetadata } from './types';
import type { QueueItem, ReviewMember, ReviewSubject } from './workbench';

/** Whether a PR is open, merged or closed, as GitHub reported it at `updatedAt`. */
export type PrLifecycle = Pick<PrMetadata, 'state' | 'merged' | 'updatedAt'>;

export const isOpenPr = (member: Pick<PrMetadata, 'state' | 'merged'>) => member.state === 'open' && !member.merged;
export const lifecycleOf = ({ state, merged, updatedAt }: PrLifecycle): PrLifecycle => ({ state, merged, updatedAt });

const time = (value: string) => Date.parse(value) || 0;

/** The newer of two lifecycle reports. On a tie, a merged or closed report wins: GitHub cannot reopen a PR without updating it. */
export function newerLifecycle(a: PrLifecycle | undefined, b: PrLifecycle | undefined): PrLifecycle | undefined {
  if (!a || !b) return a ?? b;
  const order = time(a.updatedAt) - time(b.updatedAt);
  if (order) return order > 0 ? a : b;
  return isOpenPr(a) && !isOpenPr(b) ? b : a;
}

/**
 * A member with a fresher lifecycle applied. A queue row, a saved tab or a search result can hold a PR as open
 * after it merged: searches for open PRs never return it again, so nothing else replaces that copy.
 * Returns the same member when nothing changes.
 */
export function withLifecycle<T extends Pick<ReviewMember, 'state' | 'merged' | 'updatedAt'>>(member: T, fresh: PrLifecycle | undefined): T {
  if (!fresh || newerLifecycle(member, fresh) !== fresh) return member;
  if (fresh.state === member.state && fresh.merged === member.merged && fresh.updatedAt === member.updatedAt) return member;
  return { ...member, state: fresh.state, merged: fresh.merged, updatedAt: fresh.updatedAt };
}

function subjectWithLifecycle(subject: ReviewSubject, fresh: (url: string) => PrLifecycle | undefined): ReviewSubject {
  const members = subject.members.map((member) => withLifecycle(member, fresh(member.url)));
  return members.every((member, index) => member === subject.members[index]) ? subject : { ...subject, members };
}

/** The item with fresher lifecycles applied to its PRs and its stack context. Returns the same item when nothing changes. */
export function itemWithLifecycle(item: QueueItem, fresh: (url: string) => PrLifecycle | undefined): QueueItem {
  const subject = subjectWithLifecycle(item.subject, fresh);
  const parentStack = item.parentStack && subjectWithLifecycle(item.parentStack, fresh);
  return subject === item.subject && parentStack === item.parentStack ? item : { ...item, subject, parentStack };
}
