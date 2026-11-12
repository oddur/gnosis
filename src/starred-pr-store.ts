import { createHash } from 'node:crypto';
import type { StateStorage } from './app-data-store';
import { deepFreeze } from '../lib/deep-freeze';
import type { ReviewMember } from '../lib/workbench';
import type { StarredPr, StarPrRequest } from '../lib/starred-prs';

function validMember(value: unknown): value is ReviewMember {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  const fields = [
    'url',
    'repo',
    'headRepo',
    'baseRepo',
    'headSha',
    'baseSha',
    'baseBranch',
    'headBranch',
    'title',
    'description',
    'author',
    'createdAt',
    'updatedAt',
  ];
  return (
    fields.every((key) => typeof m[key] === 'string') &&
    m.url === `https://github.com/${String(m.repo)}/pull/${String(m.number)}` &&
    /^[\w.-]+\/[\w.-]+$/.test(String(m.repo)) &&
    typeof m.number === 'number' &&
    Number.isSafeInteger(m.number) &&
    m.number > 0 &&
    ['open', 'closed'].includes(String(m.state)) &&
    typeof m.merged === 'boolean' &&
    typeof m.isDraft === 'boolean' &&
    ['labels', 'requestedReviewers', 'requestedTeams'].every(
      (key) => Array.isArray(m[key]) && (m[key] as unknown[]).every((value) => typeof value === 'string')
    )
  );
}

/** One saved row. `seq` keeps the order PRs were first starred in. */
interface SavedStarredPr extends StarredPr {
  seq: number;
}
interface StarredIndex {
  entries: readonly Readonly<StarredPr>[];
  seq: ReadonlyMap<string, number>;
}
export const starredPrsName = (account: string) =>
  `starred-prs:${createHash('sha256').update(account.toLowerCase()).digest('hex')}`;

/**
 * User bookmarks have a lifetime independent of GitHub discovery and its cache. `load` returns one
 * frozen, shared list per account, replaced only when a change is saved; a change saves only its rows.
 */
export function createStarredPrStore(storage: StateStorage, now = Date.now) {
  const accounts = new Map<string, StarredIndex>();
  const indexOf = (entries: SavedStarredPr[]): StarredIndex => ({
    entries: deepFreeze(entries.map(({ member, starredAt }) => ({ member, starredAt }))),
    seq: new Map(entries.map((entry) => [entry.member.url, entry.seq])),
  });
  const saved = (index: StarredIndex): SavedStarredPr[] =>
    index.entries.map((entry) => ({ ...entry, seq: index.seq.get(entry.member.url) ?? 0 }));
  const index = (account: string): StarredIndex => {
    const key = account.toLowerCase();
    const cached = accounts.get(key);
    if (cached) return cached;
    const value = storage.take(starredPrsName(account));
    const rows = value && typeof value === 'object' ? (value as { entries?: unknown }).entries : undefined;
    const entries = (rows && typeof rows === 'object' ? Object.values(rows) : [])
      .filter((entry: unknown): entry is SavedStarredPr => {
        if (!entry || typeof entry !== 'object') return false;
        const value = entry as Record<string, unknown>;
        return typeof value.starredAt === 'string' && typeof value.seq === 'number' && validMember(value.member);
      })
      .sort((a, b) => a.seq - b.seq);
    const result = indexOf([...new Map(entries.map((entry) => [entry.member.url, entry])).values()]);
    accounts.set(key, result);
    return result;
  };
  const commit = (account: string, entries: SavedStarredPr[], put: Record<string, SavedStarredPr>, remove: string[]) => {
    storage.patch(starredPrsName(account), { put, remove });
    accounts.set(account.toLowerCase(), indexOf(entries));
  };
  /** Frozen and shared: never change it. */
  const load = (account: string): readonly Readonly<StarredPr>[] => index(account).entries;
  return {
    load,
    set(account: string, request: StarPrRequest) {
      if (
        !Array.isArray(request.members) ||
        !request.members.length ||
        request.members.length > 1000 ||
        typeof request.starred !== 'boolean' ||
        !request.members.every(validMember)
      )
        throw new Error('Choose valid GitHub PRs to star.');
      const entries = new Map(saved(index(account)).map((entry) => [entry.member.url, entry]));
      let next = Math.max(-1, ...[...entries.values()].map((entry) => entry.seq)) + 1;
      const put: Record<string, SavedStarredPr> = {};
      const remove: string[] = [];
      for (const member of request.members) {
        const previous = entries.get(member.url);
        if (request.starred) {
          // The request is this store's own copy from IPC, so it is frozen in place, not copied.
          const entry = {
            seq: previous?.seq ?? next++,
            member: deepFreeze(member),
            starredAt: previous?.starredAt ?? new Date(now()).toISOString(),
          };
          entries.set(member.url, entry);
          put[member.url] = entry;
        } else if (entries.delete(member.url)) remove.push(member.url);
      }
      if (Object.keys(put).length || remove.length) commit(account, [...entries.values()], put, remove);
      return load(account);
    },
    /** Saves newer details of starred PRs. Only the members passed in are compared. */
    update(account: string, members: ReviewMember[]) {
      const current = index(account);
      const entries = new Map(saved(current).map((entry) => [entry.member.url, entry]));
      const put: Record<string, SavedStarredPr> = {};
      for (const member of members) {
        const entry = entries.get(member.url);
        if (!entry || JSON.stringify(member) === JSON.stringify(entry.member)) continue;
        // Queue members stay mutable in the live workbench state, so the store freezes its own copy.
        const next = { ...entry, member: deepFreeze(structuredClone(member)) };
        entries.set(member.url, next);
        put[member.url] = next;
      }
      if (Object.keys(put).length) commit(account, [...entries.values()], put, []);
    },
  };
}
