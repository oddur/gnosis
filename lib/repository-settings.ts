import lucideIconNames from './lucide-icon-names.json';
import type { Preferences } from './types';
import type { ReviewSubject } from './workbench';
import { isPrRecentlyUpdated, normalizePrInactivityDays, MAX_PR_INACTIVITY_DAYS } from './pr-inactivity';

// Names only: main-process validation must not load React or the SVG library.
const lucideNames = new Set<string>(lucideIconNames);
export const LEGACY_REPOSITORY_ICONS: Record<string, string> = {
  book: 'book-marked',
  flask: 'flask-conical',
  gamepad: 'gamepad-2',
};
export function repositoryLucideName(icon: string): string | undefined {
  const name = icon.startsWith('lucide:') ? icon.slice(7) : (LEGACY_REPOSITORY_ICONS[icon] ?? icon);
  return lucideNames.has(name) ? name : undefined;
}
export const REPOSITORY_COLORS = ['blue', 'purple', 'cyan', 'teal', 'green', 'amber', 'orange', 'rose'] as const;
export interface RepositorySettings {
  prInactivityDays?: number;
  ignoreDependabotPrs?: boolean;
  autoBriefings?: boolean;
  briefingDailyLimit?: number;
  icon?: string;
  color?: (typeof REPOSITORY_COLORS)[number];
}
export type RepositorySettingsMap = Record<string, RepositorySettings>;
export type RepositoryDefaults = Pick<
  Preferences,
  | 'prInactivityDays'
  | 'ignoreDependabotPrs'
  | 'autoBriefings'
  | 'briefingDailyLimit'
  | 'repositoryBriefingDailyLimit'
  | 'repositorySettings'
>;
export const repositoryKey = (repo: string) => repo.trim().toLowerCase();
export const validRepository = (repo: string) => /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo);
export function normalizeBriefingLimit(value: unknown, fallback = 10): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100 ? value : fallback;
}
export function validRepositoryIcon(value: string): boolean {
  if (repositoryLucideName(value)) return true;
  return (
    value.startsWith('emoji:') &&
    value.length <= 40 &&
    /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(value.slice(6)) &&
    [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value.slice(6))].length === 1
  );
}
export function normalizeRepositorySettings(input: unknown): RepositorySettingsMap {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return Object.fromEntries(
    Object.entries(input).flatMap(([name, raw]) => {
      if (!validRepository(name) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
      const v = raw as Record<string, unknown>,
        settings: RepositorySettings = {};
      if (
        typeof v.prInactivityDays === 'number' &&
        Number.isInteger(v.prInactivityDays) &&
        v.prInactivityDays >= 0 &&
        v.prInactivityDays <= MAX_PR_INACTIVITY_DAYS
      )
        settings.prInactivityDays = v.prInactivityDays;
      if (typeof v.ignoreDependabotPrs === 'boolean') settings.ignoreDependabotPrs = v.ignoreDependabotPrs;
      if (typeof v.autoBriefings === 'boolean') settings.autoBriefings = v.autoBriefings;
      if (typeof v.briefingDailyLimit === 'number' && normalizeBriefingLimit(v.briefingDailyLimit, -1) !== -1)
        settings.briefingDailyLimit = v.briefingDailyLimit;
      if (typeof v.icon === 'string' && validRepositoryIcon(v.icon)) settings.icon = v.icon;
      if (typeof v.color === 'string' && (REPOSITORY_COLORS as readonly string[]).includes(v.color))
        settings.color = v.color as RepositorySettings['color'];
      return Object.keys(settings).length ? [[repositoryKey(name), settings]] : [];
    })
  );
}
export function repositorySettings(p: RepositoryDefaults, repo: string) {
  const overrides = p.repositorySettings?.[repositoryKey(repo)] ?? {};
  return {
    prInactivityDays: overrides.prInactivityDays ?? normalizePrInactivityDays(p.prInactivityDays),
    ignoreDependabotPrs: overrides.ignoreDependabotPrs ?? p.ignoreDependabotPrs !== false,
    autoBriefings: overrides.autoBriefings ?? p.autoBriefings !== false,
    briefingDailyLimit: overrides.briefingDailyLimit ?? normalizeBriefingLimit(p.repositoryBriefingDailyLimit),
    icon: overrides.icon,
    color: overrides.color,
  };
}
export function subjectRepositories(subject: ReviewSubject): string[] {
  return [...new Set(subject.members.map((m) => repositoryKey(m.repo)))];
}
export function subjectRecentlyUpdated(
  subject: ReviewSubject,
  p: RepositoryDefaults,
  now: number,
  starred: ReadonlySet<string>
): boolean {
  return subject.members.some(
    (m) =>
      starred.has(m.url) ||
      (m.state === 'open' &&
        !m.merged &&
        isPrRecentlyUpdated(m.updatedAt, repositorySettings(p, m.repo).prInactivityDays, now))
  );
}
/** Search must include the widest configured cutoff; apply each repository's exact rule afterwards. */
export function discoveryInactivityDays(p: RepositoryDefaults): number {
  const days = [
    normalizePrInactivityDays(p.prInactivityDays),
    ...Object.keys(p.repositorySettings ?? {}).map((repo) => repositorySettings(p, repo).prInactivityDays),
  ];
  return days.includes(0) ? 0 : Math.max(...days);
}
export function repositoryDiscoverySettings(p: RepositoryDefaults) {
  return Object.entries(p.repositorySettings ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([, s]) => s.prInactivityDays !== undefined || s.ignoreDependabotPrs !== undefined)
    .map(([repo, s]) => [repo, s.prInactivityDays, s.ignoreDependabotPrs]);
}
export function localBriefingDay(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function briefingResetAt(now: number): string {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.toISOString();
}
export interface BriefingBudget {
  limit: number;
  used: number;
  remaining: number;
  resetsAt: string;
  repositories: Record<string, { limit: number; used: number; remaining: number; automatic: boolean }>;
}
export function briefingBudget(
  p: RepositoryDefaults,
  repos: string[],
  used: number,
  repositoryUsed: Record<string, number>,
  now: number
): BriefingBudget {
  const limit = normalizeBriefingLimit(p.briefingDailyLimit);
  return {
    limit,
    used,
    remaining: Math.max(0, limit - used),
    resetsAt: briefingResetAt(now),
    repositories: Object.fromEntries(
      [...new Set(repos.map(repositoryKey))].map((repo) => {
        const settings = repositorySettings(p, repo),
          used = repositoryUsed[repo] ?? 0;
        return [
          repo,
          {
            limit: settings.briefingDailyLimit,
            used,
            remaining: Math.max(0, settings.briefingDailyLimit - used),
            automatic: settings.autoBriefings,
          },
        ];
      })
    ),
  };
}
export function automaticBriefingBlock(
  subject: ReviewSubject,
  p: RepositoryDefaults,
  used: number,
  repositoryUsed: Record<string, number>
): string | undefined {
  const repos = subjectRepositories(subject);
  const disabled = repos.filter((repo) => !repositorySettings(p, repo).autoBriefings);
  if (disabled.length)
    return `Automatic briefings are off for ${disabled.join(', ')}. You can generate a briefing manually.`;
  if (used >= normalizeBriefingLimit(p.briefingDailyLimit))
    return 'Overall daily automatic briefing limit reached. Resets at midnight. You can generate a briefing manually.';
  const limited = repos.filter((repo) => (repositoryUsed[repo] ?? 0) >= repositorySettings(p, repo).briefingDailyLimit);
  if (limited.length)
    return `Daily automatic briefing limit reached for ${limited.join(', ')}. Resets at midnight. You can generate a briefing manually.`;
}
