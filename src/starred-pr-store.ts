import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
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

/** User bookmarks have a lifetime independent of GitHub discovery and its cache. */
export function createStarredPrStore(directory: () => string, now = Date.now) {
  const accounts = new Map<string, StarredPr[]>();
  const file = (account: string) =>
    path.join(directory(), `starred-prs-${createHash('sha256').update(account.toLowerCase()).digest('hex')}.json`);
  const load = (account: string): StarredPr[] => {
    const key = account.toLowerCase();
    const cached = accounts.get(key);
    if (cached) return structuredClone(cached);
    let entries: StarredPr[] = [];
    try {
      const value: unknown = JSON.parse(fs.readFileSync(file(account), 'utf8'));
      if (Array.isArray(value))
        entries = value.filter((entry: unknown): entry is StarredPr => {
          if (!entry || typeof entry !== 'object') return false;
          const value = entry as Record<string, unknown>;
          return typeof value.starredAt === 'string' && validMember(value.member);
        });
    } catch {
      /* First use or an unreadable bookmark file. */
    }
    entries = [...new Map(entries.map((entry) => [entry.member.url, entry])).values()];
    accounts.set(key, entries);
    return structuredClone(entries);
  };
  const save = (account: string, entries: StarredPr[]) => {
    fs.mkdirSync(directory(), { recursive: true });
    fs.writeFileSync(file(account) + '.tmp', JSON.stringify(entries), { mode: 0o600 });
    fs.renameSync(file(account) + '.tmp', file(account));
    accounts.set(account.toLowerCase(), structuredClone(entries));
    return structuredClone(entries);
  };
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
      const entries = new Map(load(account).map((entry) => [entry.member.url, entry]));
      for (const member of request.members) {
        if (request.starred)
          entries.set(member.url, {
            member,
            starredAt: entries.get(member.url)?.starredAt ?? new Date(now()).toISOString(),
          });
        else entries.delete(member.url);
      }
      return save(account, [...entries.values()]);
    },
    update(account: string, members: ReviewMember[]) {
      const latest = new Map(members.map((member) => [member.url, member]));
      const previous = load(account);
      const next = previous.map((entry) => ({ ...entry, member: latest.get(entry.member.url) ?? entry.member }));
      if (JSON.stringify(next) !== JSON.stringify(previous)) save(account, next);
    },
  };
}
