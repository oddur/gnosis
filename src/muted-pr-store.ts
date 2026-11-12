import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ReviewMember } from '../lib/workbench';
import type { MutedPr, MutedPrSummary, MutePrRequest } from '../lib/muted-prs';
import { deepFreeze } from '../lib/deep-freeze';

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

interface StoredMutedPr {
  member: ReviewMember;
  mutedAt: string;
}
interface MutedIndex {
  urls: ReadonlySet<string>;
  rows: readonly MutedPr[];
  members: ReadonlyMap<string, Readonly<ReviewMember>>;
  entries: readonly StoredMutedPr[];
}
const summary = ({ url, repo, number, title, author, state, merged, isDraft }: ReviewMember): MutedPrSummary => ({
  url,
  repo,
  number,
  title,
  author,
  state,
  merged,
  isDraft,
});
function indexOf(entries: StoredMutedPr[]): MutedIndex {
  const frozen = deepFreeze(entries);
  return Object.freeze({
    urls: new Set(frozen.map((entry) => entry.member.url)),
    rows: deepFreeze(frozen.map((entry) => ({ member: summary(entry.member), mutedAt: entry.mutedAt }))),
    members: new Map(frozen.map((entry) => [entry.member.url, entry.member])),
    entries: frozen,
  });
}

/**
 * User muted PRs have a lifetime independent of GitHub discovery and its cache. The file keeps each
 * full PR, because its description is part of the briefing key after an unmute. Reads share one frozen
 * index per account, rebuilt only when a change is saved.
 */
export function createMutedPrStore(directory: () => string, now = Date.now) {
  const accounts = new Map<string, MutedIndex>();
  const file = (account: string) =>
    path.join(directory(), `muted-prs-${createHash('sha256').update(account.toLowerCase()).digest('hex')}.json`);
  const load = (account: string): MutedIndex => {
    const key = account.toLowerCase();
    const cached = accounts.get(key);
    if (cached) return cached;
    let entries: StoredMutedPr[] = [];
    try {
      const value: unknown = JSON.parse(fs.readFileSync(file(account), 'utf8'));
      if (Array.isArray(value))
        entries = value.filter((entry: unknown): entry is StoredMutedPr => {
          if (!entry || typeof entry !== 'object') return false;
          const value = entry as Record<string, unknown>;
          return typeof value.mutedAt === 'string' && validMember(value.member);
        });
    } catch {
      /* First use or an unreadable mute file. */
    }
    const index = indexOf([...new Map(entries.map((entry) => [entry.member.url, entry])).values()]);
    accounts.set(key, index);
    return index;
  };
  const save = (account: string, entries: StoredMutedPr[]) => {
    fs.mkdirSync(directory(), { recursive: true });
    fs.writeFileSync(file(account) + '.tmp', JSON.stringify(entries), { mode: 0o600 });
    fs.renameSync(file(account) + '.tmp', file(account));
    accounts.set(account.toLowerCase(), indexOf(entries));
  };
  return {
    /** Muted URLs and the rows the Muted PRs page shows. Frozen and shared: never change them. */
    index: (account: string): Pick<MutedIndex, 'urls' | 'rows'> => load(account),
    /** The full saved PR, for restoring it after an unmute. Frozen and shared. */
    member: (account: string, url: string): Readonly<ReviewMember> | undefined => load(account).members.get(url),
    set(account: string, request: MutePrRequest) {
      /* eslint-disable @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unnecessary-boolean-literal-compare -- IPC is an untrusted runtime boundary */
      const valid =
        request.muted === true
          ? Array.isArray(request.members) &&
            request.members.length > 0 &&
            request.members.length <= 1000 &&
            request.members.every(validMember)
          : request.muted === false &&
            Array.isArray(request.urls) &&
            request.urls.length > 0 &&
            request.urls.length <= 1000 &&
            request.urls.every((url) => typeof url === 'string');
      /* eslint-enable @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unnecessary-boolean-literal-compare */
      if (!valid) throw new Error('Choose valid GitHub PRs to mute.');
      const entries = new Map(load(account).entries.map((entry) => [entry.member.url, entry]));
      if (request.muted)
        for (const member of request.members)
          entries.set(member.url, {
            member: structuredClone(member),
            mutedAt: entries.get(member.url)?.mutedAt ?? new Date(now()).toISOString(),
          });
      else for (const url of request.urls) entries.delete(url);
      save(account, [...entries.values()]);
    },
  };
}
export type MutedPrStore = ReturnType<typeof createMutedPrStore>;
