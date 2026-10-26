export interface PrLabelFilter {
  names: string[];
  match: 'any' | 'all';
  unlabelled: boolean;
}
export const DEFAULT_LABEL_FILTER: PrLabelFilter = { names: [], match: 'any', unlabelled: false };

/** Accept the old single-label setting, but keep special choices separate from real names. */
export function normalizeLabelFilter(value: unknown): PrLabelFilter {
  if (typeof value === 'string') return { ...DEFAULT_LABEL_FILTER, names: value && value !== 'all' ? [value] : [] };
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const seen = new Set<string>();
  const names = (Array.isArray(raw.names) ? raw.names : []).flatMap((name: unknown) => {
    if (typeof name !== 'string' || !name.trim()) return [];
    const trimmed = name.trim().slice(0, 300);
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [trimmed];
  }).slice(0, 100).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  const unlabelled = raw.unlabelled === true;
  return { names: unlabelled ? [] : names, match: raw.match === 'all' ? 'all' : 'any', unlabelled };
}
export const labelFilterActive = (filter: PrLabelFilter) => filter.unlabelled || filter.names.length > 0;
export function matchesLabelFilter(names: string[], filter: PrLabelFilter): boolean {
  if (filter.unlabelled) return names.length === 0;
  if (!filter.names.length) return true;
  const available = new Set(names.map(name => name.toLowerCase()));
  const has = (name: string) => available.has(name.toLowerCase());
  return filter.match === 'all' ? filter.names.every(has) : filter.names.some(has);
}
export function describeLabelFilter(filter: PrLabelFilter): string {
  if (filter.unlabelled) return 'No labels';
  return `${filter.names.length > 1 ? `Labels (${filter.match})` : 'Label'}: ${filter.names.join(', ')}`;
}
