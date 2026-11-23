import type { PrMetadata } from './types';
import type { QueueItem, ReviewMember, ReviewSubject } from './workbench';

/** Whether a PR is open, merged or closed, as GitHub reported it at `updatedAt`. */
export type PrLifecycle = Pick<PrMetadata, 'state' | 'merged' | 'updatedAt'>;

export const isOpenPr = (member: Pick<PrMetadata, 'state' | 'merged'>) => member.state === 'open' && !member.merged;
/** GitHub reported the PR merged or closed. A PR whose state is not known yet is neither. */
export const isMergedOrClosedPr = (member: Partial<Pick<PrMetadata, 'state' | 'merged'>>) => member.merged === true || member.state === 'closed';
export const lifecycleOf = ({ state, merged, updatedAt }: PrLifecycle): PrLifecycle => ({ state, merged, updatedAt });

const time = (value: string) => Date.parse(value) || 0;

/** The newer of two lifecycle reports. On a tie, a merged or closed report wins: GitHub cannot reopen a PR without updating it. */
export function newerLifecycle(a: PrLifecycle | undefined, b: PrLifecycle | undefined): PrLifecycle | undefined {
  if (!a || !b) return a ?? b;
  const order = time(a.updatedAt) - time(b.updatedAt);
  if (order) return order > 0 ? a : b;
  return isOpenPr(a) && !isOpenPr(b) ? b : a;
}

/** A fresh report of a PR: its lifecycle, and the whole PR when the read returned it. */
export type FreshPr = PrLifecycle & Partial<PrMetadata>;

/** The freshest report a status read holds: its full PR when present, with the newer of the two lifecycles. */
export function freshPr(status: { lifecycle?: PrLifecycle; metadata?: PrMetadata } | undefined): FreshPr | undefined {
  if (!status?.metadata) return status?.lifecycle;
  const lifecycle = newerLifecycle(lifecycleOf(status.metadata), status.lifecycle);
  return { ...status.metadata, ...lifecycle };
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * A member with a fresher report applied. A queue row, a saved tab or a search result can hold a PR as open
 * after it merged: searches for open PRs never return it again, so nothing else replaces that copy. The same holds
 * for its title, draft flag, base and head, so a full report replaces all of them. An older report changes nothing,
 * and a report of the same time never reopens a merged or closed copy. Returns the same member when nothing changes.
 */
export function withLifecycle<T extends Pick<ReviewMember, 'state' | 'merged' | 'updatedAt'>>(member: T, fresh: FreshPr | undefined): T {
  if (!fresh) return member;
  const order = time(fresh.updatedAt) - time(member.updatedAt);
  if (order < 0 || (order === 0 && isOpenPr(fresh) && !isOpenPr(member))) return member;
  const patch = Object.fromEntries(
    Object.entries(fresh as Record<string, unknown>).filter(([key, value]) => value !== undefined && key !== 'url' && !same(value, (member as Record<string, unknown>)[key]))
  );
  return Object.keys(patch).length ? { ...member, ...patch } : member;
}

function subjectWithLifecycle(subject: ReviewSubject, fresh: (url: string) => FreshPr | undefined): ReviewSubject {
  const members = subject.members.map((member) => withLifecycle(member, fresh(member.url)));
  return members.every((member, index) => member === subject.members[index]) ? subject : { ...subject, members };
}

/** The item with fresher reports applied to its PRs and its stack context. Returns the same item when nothing changes. */
export function itemWithLifecycle(item: QueueItem, fresh: (url: string) => FreshPr | undefined): QueueItem {
  const subject = subjectWithLifecycle(item.subject, fresh);
  const parentStack = item.parentStack && subjectWithLifecycle(item.parentStack, fresh);
  return subject === item.subject && parentStack === item.parentStack ? item : { ...item, subject, parentStack };
}
