import type { QueueItem, ReviewMember, ReviewSubject } from './workbench';
import type { QueueFilters } from './queue-filters';
import { matchesQueueFilters } from './queue-filters';

/** A PR keeps its own identity and generation scope, with its parent as navigation context. */
export function focusStackPr(stack: QueueItem, member: ReviewMember): QueueItem {
  return {
    attention: stack.attention,
    parentStack: stack.subject.kind === 'stack' ? stack.subject : stack.parentStack,
    subject: { id: member.url, kind: 'pr', scope: 'single', title: member.title, members: [member], edges: [], warnings: [] },
    unreadUrls: stack.unreadUrls?.filter(url => url === member.url),
    starredUrls: stack.starredUrls?.filter(url => url === member.url),
  };
}

/** Resolve cached navigation without promoting a PR back into its whole stack. */
export function resolveWorkspace(item: QueueItem, items: QueueItem[]): QueueItem {
  if (item.subject.kind === 'stack') return items.find(i => i.subject.id === item.subject.id) ?? item;
  const url = item.subject.members[0]?.url;
  const parent = items.find(i => i.subject.kind === 'stack' && i.subject.members.some(m => m.url === url));
  if (parent) return { ...item, ...focusStackPr(parent, parent.subject.members.find(m => m.url === url)!) };
  const current = items.find(i => i.subject.id === item.subject.id);
  return current ? { ...current, subject: { ...current.subject, scope: 'single' }, parentStack: item.parentStack } : item;
}

export function matchingStackMembers(item: QueueItem, filters: QueueFilters, login?: string | null, now = Date.now()) {
  return item.subject.members.filter(member => matchesQueueFilters(
    { ...item, subject: { ...item.subject, members: [member] } }, filters, now, login
  )).map(member => member.url);
}

export function stackScopeChoices(stack: ReviewSubject) {
  return [
    { value: stack.id, label: `Whole stack · ${stack.title}` },
    ...stack.members.map((m, index) => ({ value: m.url, label: `${index + 1}. #${m.number} · ${m.title}` })),
  ];
}
