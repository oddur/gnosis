import type { Octokit } from '@octokit/rest';
import { githubCacheFor } from '../lib/github-client';
import { isCacheRecord } from '../lib/github-cache';
import { isGitHubLogin, type GitHubProfile } from '../lib/github-profile';
const DAY = 24 * 60 * 60_000;
function isProfile(value: unknown): value is GitHubProfile {
  return (
    isCacheRecord(value) &&
    typeof value.login === 'string' &&
    typeof value.type === 'string' &&
    ['name', 'bio', 'company', 'location'].every((key) => value[key] === null || typeof value[key] === 'string')
  );
}
/** User-initiated reads only. Share hover requests and retain profile snapshots across restarts. */
export function createGitHubProfileService(now = Date.now) {
  interface Entry {
    value?: GitHubProfile;
    expires: number;
    retryAt: number;
    pending?: Promise<GitHubProfile>;
  }
  const accounts = new WeakMap<Octokit, Map<string, Entry>>();
  return async (client: Octokit, username: string): Promise<GitHubProfile> => {
    if (!isGitHubLogin(username)) throw new Error('This author does not have a GitHub profile.');
    const login = username.toLowerCase();
    if (login.endsWith('[bot]'))
      return { login: username, name: null, bio: null, company: null, location: null, type: 'Bot' };
    let entries = accounts.get(client);
    if (!entries) {
      entries = new Map();
      accounts.set(client, entries);
    }
    let entry = entries.get(login);
    const cache = githubCacheFor(client),
      key = `user-profile:${login}`;
    if (!entry) {
      const saved = cache?.get(key, isProfile);
      entry = { value: saved?.value, expires: saved ? saved.savedAt + DAY : 0, retryAt: 0 };
      entries.set(login, entry);
      if (entries.size > 256) {
        for (const [id, value] of entries) {
          if (id !== login && !value.pending) {
            entries.delete(id);
            break;
          }
        }
      }
    }
    if (entry.value && entry.expires > now()) return entry.value;
    if (entry.pending) return entry.pending;
    if (entry.retryAt > now()) {
      if (entry.value) return entry.value;
      throw new Error('Profile details are temporarily unavailable.');
    }
    const record = entry,
      version = cache?.version();
    record.pending = Promise.resolve().then(async () => {
      try {
        const { data } = await client.users.getByUsername({ username });
        const value: GitHubProfile = {
          login: data.login,
          name: data.name ?? null,
          bio: data.bio ?? null,
          company: data.company ?? null,
          location: data.location ?? null,
          type: data.type,
        };
        record.value = value;
        record.expires = now() + DAY;
        record.retryAt = 0;
        if (cache?.version() === version) cache?.set(key, value);
        return value;
      } catch (error) {
        record.retryAt = now() + 2 * 60_000;
        if (record.value) return record.value;
        throw error;
      } finally {
        record.pending = undefined;
      }
    });
    return record.pending;
  };
}
