/**
 * "Open Gnosis at this exact place", shared by notifications (#307), the menu bar (#308) and `gnosis://` links (#309).
 * Pure, with no Node or Electron imports. Targets hold identifiers only: no titles, queue items or SHAs.
 *
 * Phase 1 of #307 defines the `pr`, `review` and `queue` targets it needs. #309 adds the URL grammar
 * (`parseDeepLink`, `formatDeepLink`, `parseGitHubUrl`) and the other kinds in this module.
 */
export const DEEP_LINK_VERSION = 1;
/** `notes` is the internal `brief` tab. */
export type PrTab = 'summary' | 'changes' | 'commits' | 'checks' | 'feedback' | 'explanation' | 'notes';
export const PR_TABS: readonly PrTab[] = ['summary', 'changes', 'commits', 'checks', 'feedback', 'explanation', 'notes'];
/** `host` is `github.com` in version 1. */
export interface PrRef {
  host: string;
  owner: string;
  repo: string;
  number: number;
}
export interface LinkFilters {
  read?: 'unread' | 'read';
}
export type QueueSection = 'all' | 'response' | 'requested' | 'updated' | 'stacks' | 'saved' | 'starred' | 'muted';
export const QUEUE_SECTIONS: readonly QueueSection[] = ['all', 'response', 'requested', 'updated', 'stacks', 'saved', 'starred', 'muted'];

export type DeepLinkTarget =
  | { kind: 'queue'; section?: QueueSection; filters?: LinkFilters }
  | { kind: 'pr'; pr: PrRef; tab?: PrTab }
  | { kind: 'review'; reviewId: string };

/** `notification`, `menubar` and `tray` targets are built by Gnosis and are trusted. */
export type DeepLinkSource = 'os' | 'content' | 'notification' | 'menubar' | 'tray';
export const TRUSTED_SOURCES: readonly DeepLinkSource[] = ['notification', 'menubar', 'tray'];

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/pull\/([1-9]\d{0,8})$/;
/** Saved review ids are UUIDs, or `local-` prefixed ids for local reviews. */
const REVIEW_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function prRef(url: string): PrRef | undefined {
  const match = PR_URL.exec(url);
  return match ? { host: 'github.com', owner: match[1], repo: match[2], number: Number(match[3]) } : undefined;
}
export const prUrl = (ref: PrRef) => `https://${ref.host}/${ref.owner}/${ref.repo}/pull/${ref.number}`;
export function prTarget(url: string, tab?: PrTab): DeepLinkTarget | undefined {
  const pr = prRef(url);
  return pr ? { kind: 'pr', pr, ...(tab ? { tab } : {}) } : undefined;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Re-validates a target that crossed IPC. Unknown fields are dropped; an invalid target is `undefined`. */
export function parseDeepLinkTarget(value: unknown): DeepLinkTarget | undefined {
  if (!record(value)) return undefined;
  if (value.kind === 'pr') {
    const pr = value.pr;
    if (
      !record(pr) || pr.host !== 'github.com' || typeof pr.owner !== 'string' || !NAME.test(pr.owner) ||
      typeof pr.repo !== 'string' || !NAME.test(pr.repo) ||
      typeof pr.number !== 'number' || !Number.isSafeInteger(pr.number) || pr.number < 1
    ) return undefined;
    if (value.tab !== undefined && !PR_TABS.includes(value.tab as PrTab)) return undefined;
    return { kind: 'pr', pr: { host: 'github.com', owner: pr.owner, repo: pr.repo, number: pr.number }, ...(value.tab ? { tab: value.tab as PrTab } : {}) };
  }
  if (value.kind === 'review')
    return typeof value.reviewId === 'string' && REVIEW_ID.test(value.reviewId) ? { kind: 'review', reviewId: value.reviewId } : undefined;
  if (value.kind === 'queue') {
    if (value.section !== undefined && !QUEUE_SECTIONS.includes(value.section as QueueSection)) return undefined;
    let filters: LinkFilters | undefined;
    if (value.filters !== undefined) {
      if (!record(value.filters)) return undefined;
      const read = value.filters.read;
      if (read !== undefined && read !== 'unread' && read !== 'read') return undefined;
      filters = read ? { read } : {};
    }
    return { kind: 'queue', ...(value.section ? { section: value.section as QueueSection } : {}), ...(filters ? { filters } : {}) };
  }
  return undefined;
}
