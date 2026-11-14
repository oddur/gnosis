/**
 * Renderer side of "open Gnosis at this exact place" (#309 section 6.2). Pure: maps a target to the workspace tab
 * to use and the `SearchDestination` to run, the path the command palette uses.
 */
import { githubUrl, prUrl, TRUSTED_SOURCES, type DeepLinkError, type DeepLinkSource, type DeepLinkTarget, type PrLinkTarget, type PrRef, type PrTab } from './deep-link';
import type { SearchDestination } from './command-search';
import type { WorkspaceTab } from './navigation-history';
import type { WorkspaceTabsState } from './workspace-tabs';
import type { QueueItem, WorkbenchQueue } from './workbench';
import type { PrMetadata } from './types';
import { focusStackPr } from './stack-workspace';

export type DeepLinkTab = { kind: 'reuse'; id: string } | { kind: 'active' } | { kind: 'new' };
export interface DeepLinkRoute {
  tab: DeepLinkTab;
  destination: SearchDestination;
}
export const workspaceTab = (tab: PrTab | undefined): WorkspaceTab | undefined => (tab === 'notes' ? 'brief' : tab);

/** The queue item that shows a PR: a stack member is focused with its stack as context. */
export function queueItemFor(url: string, queue: Pick<WorkbenchQueue, 'items' | 'starredItems' | 'stacks'>): QueueItem | undefined {
  const items: QueueItem[] = [...queue.items, ...(queue.starredItems ?? [])];
  for (const stack of queue.stacks ?? []) if (!items.some((item) => item.subject.id === stack.id)) items.push({ subject: stack, attention: 'other' });
  const exact = items.find((item) => item.subject.kind === 'pr' && item.subject.id === url);
  if (exact) return exact;
  const parent = items.find((item) => item.subject.members.some((member) => member.url === url));
  const member = parent?.subject.members.find((m) => m.url === url);
  return parent && member ? (parent.subject.kind === 'stack' ? focusStackPr(parent, member) : parent) : undefined;
}

export function routeDeepLink(
  target: DeepLinkTarget,
  state: Pick<WorkspaceTabsState, 'tabs' | 'active'>,
  queue: Pick<WorkbenchQueue, 'items' | 'starredItems' | 'stacks'>,
  nonce = Date.now()
): DeepLinkRoute {
  if (target.kind === 'review') {
    // A tab already on that review is reused. Otherwise the active tab opens it, as "Explanation ready" always has.
    // `explore: false` opens the reader: without it, an open interactive explanation would stay in front.
    const reuse = state.tabs.find((tab) => tab.location?.page === 'review' && tab.location.reviewId === target.reviewId);
    return { tab: reuse ? { kind: 'reuse', id: reuse.id } : { kind: 'active' }, destination: { kind: 'review', reviewId: target.reviewId, explore: false } };
  }
  if (target.kind === 'queue') {
    const active = state.tabs.find((tab) => tab.id === state.active);
    const plainQueue = !active?.location || (active.location.page === 'home' && !active.location.home.item);
    return {
      tab: plainQueue ? { kind: 'active' } : { kind: 'new' },
      destination: {
        kind: 'home',
        section: target.section ?? 'all',
        ...(target.view ? { viewId: target.view } : {}),
        ...(target.filters?.repo ? { repo: target.filters.repo } : {}),
        ...(target.filters ? { filters: target.filters } : {}),
      },
    };
  }
  if (target.kind === 'settings' || target.kind === 'activity')
    return { tab: { kind: 'active' }, destination: target.kind === 'activity' ? { kind: 'activity' } : { kind: 'home', settings: target.section ?? 'queue' } };
  if (target.kind === 'commit' || target.kind === 'compare')
    // Resolving a commit or comparison to its PR needs a GitHub read (Phase 2b). The nearest parent is the repository.
    return routeDeepLink({ kind: 'queue', filters: { repo: `${target.owner}/${target.repo}` } }, state, queue, nonce);
  // A conflicts link opens the PR first; the confirmation before conflict resolution comes with Phase 3.
  const pr: PrLinkTarget = target.kind === 'conflicts' ? { kind: 'pr', pr: target.pr } : target;
  const url = prUrl(pr.pr);
  const open = { tab: workspaceTab(pr.tab), nonce };
  // Never replace what the user is looking at in another tab: reuse the tab showing this PR, or open one.
  const reuse = state.tabs.find(
    (tab) => tab.location?.page === 'home' && tab.location.home.item?.subject.members.some((member) => member.url === url)
  );
  const item = pr.scope === 'stack' ? stackItemFor(url, queue) ?? queueItemFor(url, queue) : queueItemFor(url, queue);
  return {
    tab: reuse ? { kind: 'reuse', id: reuse.id } : { kind: 'new' },
    destination: item ? { kind: 'home', subject: item, open } : { kind: 'home', url, open },
  };
}

/** The whole stack that contains a PR, unfocused. */
function stackItemFor(url: string, queue: Pick<WorkbenchQueue, 'items' | 'starredItems' | 'stacks'>): QueueItem | undefined {
  const item = [...queue.items, ...(queue.starredItems ?? [])].find((i) => i.subject.kind === 'stack' && i.subject.members.some((m) => m.url === url));
  if (item) return item;
  const stack = queue.stacks?.find((s) => s.kind === 'stack' && s.members.some((m) => m.url === url));
  return stack ? { subject: stack, attention: 'other' } : undefined;
}

/** A queue item for a PR outside the queue, from its metadata: the existing Open PR path. */
export function prMetadataItem(ref: PrRef, meta: PrMetadata): QueueItem {
  const url = prUrl(ref);
  const repo = `${ref.owner}/${ref.repo}`;
  return {
    attention: 'other',
    subject: {
      id: url,
      kind: 'pr',
      title: meta.title,
      edges: [],
      warnings: [],
      members: [{ ...meta, number: ref.number, repo, headRepo: meta.headRepo ?? repo, baseRepo: meta.baseRepo ?? repo, role: 'watched' }],
    },
  };
}

// ── What a link may open in this version (Phase 1 of #309) ──

const TAB_LABELS: Record<PrTab, string> = {
  summary: 'Summary', changes: 'Changes', commits: 'Commits', checks: 'Checks', feedback: 'Feedback', explanation: 'Explanation', notes: 'Local notes',
};
const LOCATOR_LABELS: [keyof PrLinkTarget, string][] = [
  ['file', 'a file or line'],
  ['threadId', 'a comment'],
  ['commentId', 'a comment'],
  ['commit', 'a commit'],
  ['check', 'a check'],
  ['slide', 'a slide'],
];
const prName = (ref: PrRef) => `${ref.owner}/${ref.repo}#${ref.number}`;
/** One action for a link toast: run a target in the app, or open a URL rebuilt from parsed fields. */
export type LinkAction = { label: string; target: DeepLinkTarget } | { label: string; url: string } | { label: string; destination: SearchDestination };
export interface LinkNotice {
  title: string;
  description?: string;
  action?: LinkAction;
}
export type LinkSupport = { supported: true; target: DeepLinkTarget; note?: LinkNotice } | ({ supported: false } & LinkNotice);

/**
 * Whether this version opens a target, and the parent it opens instead. Links from outside (`os`, `content`) open
 * PRs only, at their tab; other routes say they are not supported yet. A locator this version cannot follow opens
 * the tab with a note, so a valid link never opens nothing. Targets that Gnosis built (notifications, the tray)
 * keep every route the app already handles.
 */
export function linkSupport(target: DeepLinkTarget, source: DeepLinkSource): LinkSupport {
  const trusted = TRUSTED_SOURCES.includes(source);
  if (target.kind === 'pr') {
    const notes: string[] = [];
    if (target.scope === 'stack') notes.push('Opening a whole stack from a link is not supported yet, so Gnosis opened this PR.');
    const skipped = [...new Set(LOCATOR_LABELS.filter(([key]) => target[key] !== undefined).map(([, label]) => label))];
    if (skipped.length)
      notes.push(`Links to ${skipped.join(' or ')} are not supported yet, so Gnosis opened the ${TAB_LABELS[target.tab ?? 'summary']} tab.`);
    const plain: PrLinkTarget = { kind: 'pr', pr: target.pr, ...(target.tab ? { tab: target.tab } : {}) };
    return { supported: true, target: plain, ...(notes.length ? { note: { title: `Opened ${prName(target.pr)}`, description: notes.join(' ') } } : {}) };
  }
  // The menu bar panel's ⌘, and its short menu open Settings; nothing outside Gnosis can yet.
  if (trusted && (target.kind === 'review' || target.kind === 'queue' || target.kind === 'settings' || target.kind === 'activity'))
    return { supported: true, target };
  const title = 'This link is not supported yet';
  if (target.kind === 'conflicts')
    return { supported: false, title, description: 'This version of Gnosis cannot open conflict resolution from a link.', action: { label: 'Open PR', target: { kind: 'pr', pr: target.pr } } };
  const url = githubUrl(target);
  const description = `This version of Gnosis can open links to pull requests only.`;
  return { supported: false, title, description, ...(url ? { action: { label: 'Open on GitHub', url } } : {}) };
}

/** The toast for a link main refused. It names the route at most and never echoes the link. */
export function linkErrorNotice(error: DeepLinkError): LinkNotice {
  if (error.code === 'rate-limited') {
    const count = error.count ?? 1;
    return { title: `Ignored ${count} ${count === 1 ? 'link' : 'links'}`, description: 'Too many links arrived at once.' };
  }
  if (error.code === 'unsupported-version') return { title: 'Could not open link', description: 'This link needs a newer version of Gnosis.' };
  const reasons: Record<Exclude<DeepLinkError['code'], 'rate-limited' | 'unsupported-version'>, string> = {
    malformed: 'The link is not a valid Gnosis link.',
    'too-long': 'The link is too long.',
    'unknown-route': 'Gnosis does not know where this link goes.',
    'bad-parameter': 'The link has a value Gnosis cannot use.',
    'unsupported-host': 'Gnosis opens github.com links only.',
    'unsupported-url': 'Gnosis cannot open this kind of GitHub page.',
  };
  const route = error.route ? ` (${error.route} link)` : '';
  return { title: 'Could not open link', description: `${reasons[error.code]}${route}` };
}

/** Why a PR link cannot open before any GitHub read: signed out, or muted. Muted links never unmute. */
export function prLinkBlock(target: PrLinkTarget, state: { signedIn: boolean; mutedUrls: ReadonlySet<string> }): LinkNotice | undefined {
  const name = prName(target.pr);
  if (!state.signedIn) return { title: `Connect GitHub to open ${name}`, action: { label: 'Connect GitHub', destination: { kind: 'home', account: true } } };
  if (state.mutedUrls.has(prUrl(target.pr).toLowerCase()))
    return { title: `${name} is muted`, description: 'This PR is muted. Restore it from Muted PRs first.', action: { label: 'Show muted PRs', target: { kind: 'queue', section: 'muted' } } };
  return undefined;
}
