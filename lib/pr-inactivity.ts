import type { ReviewSubject } from './workbench';

export const DEFAULT_PR_INACTIVITY_DAYS = 30;
export const MAX_PR_INACTIVITY_DAYS = 36500;
export function normalizePrInactivityDays(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_PR_INACTIVITY_DAYS
    ? value
    : DEFAULT_PR_INACTIVITY_DAYS;
}
export function isPrRecentlyUpdated(updatedAt: string, days: number, now: number): boolean {
  if (!days) return true;
  const updated = Date.parse(updatedAt);
  // Missing dates must not silently discard work.
  return !Number.isFinite(updated) || updated >= now - days * 86400000;
}
export function matchesPrInactivity(
  subject: ReviewSubject,
  days: number,
  now: number,
  starredUrls: ReadonlySet<string>
): boolean {
  return subject.members.some(
    (member) =>
      starredUrls.has(member.url) ||
      (member.state === 'open' && !member.merged && isPrRecentlyUpdated(member.updatedAt, days, now))
  );
}
