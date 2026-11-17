import type { WorkspaceTabEntry } from './workspace-tabs';

/** The PRs a tab shows at its current location: an open PR, or each PR of an open stack. */
export function tabPrUrls(tab: Pick<WorkspaceTabEntry, 'location'>): string[] {
  const location = tab.location;
  if (location?.page !== 'home' || !location.home.item) return [];
  return location.home.item.subject.members.map((member) => member.url);
}

/**
 * The PRs each open tab has shown, and the PRs to drop from the renderer's caches because the tabs that showed them
 * closed (#355). A PR another open tab has shown stays.
 */
export function retainTabPrs(previous: ReadonlyMap<string, ReadonlySet<string>>, tabs: Pick<WorkspaceTabEntry, 'id' | 'location'>[]) {
  const next = new Map<string, Set<string>>();
  for (const tab of tabs) next.set(tab.id, new Set([...(previous.get(tab.id) ?? []), ...tabPrUrls(tab)]));
  const kept = new Set([...next.values()].flatMap((urls) => [...urls]));
  const forget = new Set<string>();
  for (const [id, urls] of previous) if (!next.has(id)) for (const url of urls) if (!kept.has(url)) forget.add(url);
  return { next, forget: [...forget] };
}
