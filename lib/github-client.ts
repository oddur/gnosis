import { Octokit } from '@octokit/rest';
import type { OctokitResponse } from '@octokit/types';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createGitHubCache, isCacheRecord, type GitHubCache } from './github-cache';

const clientCaches = new WeakMap<Octokit, GitHubCache>();
export const githubCacheFor = (client: Octokit) => clientCaches.get(client);
interface CachedResponse {
  response: OctokitResponse<unknown>;
  freshUntil: number;
}
function isCachedResponse(value: unknown): value is CachedResponse {
  return (
    isCacheRecord(value) &&
    typeof value.freshUntil === 'number' &&
    Number.isFinite(value.freshUntil) &&
    isCacheRecord(value.response) &&
    value.response.status === 200 &&
    typeof value.response.url === 'string' &&
    isCacheRecord(value.response.headers) &&
    Object.values(value.response.headers).every((header) => typeof header === 'string') &&
    'data' in value.response
  );
}
function freshness(headers: Headers, now: number) {
  const control = String(headers['cache-control'] ?? '');
  if (/\b(no-cache|no-store)\b/i.test(control)) return now;
  const seconds = /(?:^|,)\s*max-age=(\d+)/i.exec(control)?.[1];
  const age = Number(headers.age) || 0;
  return now + Math.max(0, Math.min(60, seconds === undefined ? 60 : Number(seconds)) - age) * 1000;
}

interface Budget {
  remaining: number;
  limit: number;
  reset: number;
}
interface AccountState {
  budgets: Partial<Record<string, Budget>>;
  blockedUntil: number;
  secondaryStrikes: number;
  lastSecondary: number;
  login?: string;
}
type Headers = Record<string, string | number | undefined>;
export class GitHubBackoffError extends Error {
  constructor(
    public readonly retryAt: number,
    public readonly reason = 'GitHub’s API limit was reached'
  ) {
    super(`${reason}. GitHub requests can resume after ${new Date(retryAt).toLocaleTimeString()}.`);
    this.name = 'GitHubBackoffError';
  }
}

/** Only rate-limit responses qualify: a normal permissions-related 403 must remain an error. */
export function githubRateLimit(error: unknown, now = Date.now()): GitHubBackoffError | undefined {
  if (error instanceof GitHubBackoffError) return error;
  const e = error as { status?: number; message?: string; response?: { headers?: Headers } } | null;
  if (!e || (e.status !== 403 && e.status !== 429)) return;
  const headers = e.response?.headers ?? {};
  const exhausted = String(headers['x-ratelimit-remaining']) === '0';
  if (e.status !== 429 && !exhausted && !headers['retry-after'] && !/rate limit|abuse detection/i.test(e.message ?? ''))
    return;
  const retry = headers['retry-after'];
  const seconds = Number(retry);
  const retryAt = retry === undefined ? 0 : Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(String(retry));
  const reset = exhausted ? Number(headers['x-ratelimit-reset']) * 1000 : 0;
  const deadline = Math.max(Number.isFinite(retryAt) ? retryAt : 0, Number.isFinite(reset) ? reset : 0);
  return new GitHubBackoffError(deadline > now ? deadline + 1000 : now + 60_000);
}

interface Options {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
  minSpacingMs?: number;
}
/** One scheduler per credential, shared by every caller in this process. No automatic replay of writes. */
export function createGitHubClientPool(options: Options = {}) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const states = new Map<string, AccountState>();
  const clients = new Map<string, Octokit>();
  const snapshots = createGitHubCache(now);
  let storage: string | undefined;
  const keyFor = (token?: string | null) =>
    createHash('sha256')
      .update(token || 'anonymous')
      .digest('hex');
  const stateFor = (key: string) => {
    let state = states.get(key);
    if (!state) {
      state = { budgets: {}, blockedUntil: 0, secondaryStrikes: 0, lastSecondary: 0 };
      states.set(key, state);
    }
    return state;
  };
  const persist = () => {
    if (!storage) return;
    try {
      fs.mkdirSync(path.dirname(storage), { recursive: true });
      fs.writeFileSync(storage + '.tmp', JSON.stringify(Object.fromEntries(states)), { mode: 0o600 });
      fs.renameSync(storage + '.tmp', storage);
    } catch {
      /* A disk failure must not replace the API result or disable in-memory backoff. */
    }
  };
  const backoff = (token?: string | null, background = false) => {
    const state = stateFor(keyFor(token));
    const deadlines = [state.blockedUntil];
    for (const [resource, budget] of Object.entries(state.budgets)) {
      if (!budget) continue;
      const reserve = background && resource === 'core' ? Math.min(100, budget.limit * 0.1) : 0;
      if (budget.remaining <= reserve) deadlines.push(budget.reset);
    }
    const deadline = Math.max(...deadlines);
    if (deadline > now())
      return new GitHubBackoffError(
        deadline,
        background ? 'GitHub updates are paused to protect your API allowance' : undefined
      );
  };
  return {
    backoff,
    setStorage(file: string) {
      storage = file;
      snapshots.setStorage(path.join(path.dirname(file), 'github-cache.json'));
      try {
        const record = (value: unknown): Record<string, unknown> | undefined =>
          value !== null && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined;
        const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
        const saved = record(JSON.parse(fs.readFileSync(file, 'utf8')));
        for (const [key, raw] of Object.entries(saved ?? {})) {
          const value = record(raw);
          if (!/^[a-f0-9]{64}$/.test(key) || !value) continue;
          const budgets: AccountState['budgets'] = {};
          for (const [resource, rawBudget] of Object.entries(record(value.budgets) ?? {})) {
            const budget = record(rawBudget);
            if (
              !budget ||
              !['remaining', 'limit', 'reset'].every(
                (field) => typeof budget[field] === 'number' && Number.isFinite(budget[field])
              )
            )
              continue;
            budgets[resource] = {
              remaining: number(budget.remaining),
              limit: number(budget.limit),
              reset: number(budget.reset),
            };
          }
          states.set(key, {
            budgets,
            blockedUntil: number(value.blockedUntil),
            secondaryStrikes: number(value.secondaryStrikes),
            lastSecondary: number(value.lastSecondary),
            login: typeof value.login === 'string' ? value.login : undefined,
          });
        }
      } catch {
        /* First use or an unreadable cache. */
      }
    },
    savedLogin(token: string) {
      return stateFor(keyFor(token)).login;
    },
    rememberLogin(token: string, login: string) {
      stateFor(keyFor(token)).login = login;
      persist();
    },
    forget(token: string) {
      // Keep the cooldown: signing out and back in must not bypass GitHub's deadline.
      delete stateFor(keyFor(token)).login;
      clients.delete(keyFor(token));
      snapshots.scope(keyFor(token)).clear();
      persist();
    },
    client(token?: string | null): Octokit {
      const key = keyFor(token);
      const existing = clients.get(key);
      if (existing) return existing;
      const state = stateFor(key);
      const client = new Octokit({
        auth: token || undefined,
        userAgent: 'Gnosis-App',
        request: { fetch: options.fetch },
      });
      let tail = Promise.resolve();
      let lastRequest = 0;
      const cache = snapshots.scope(key);
      clientCaches.set(client, cache);
      const inflight = new Map<string, Promise<OctokitResponse<unknown>>>();
      const observe = (headers: Headers) => {
        const resource = String(headers['x-ratelimit-resource'] ?? 'core');
        const remaining = Number(headers['x-ratelimit-remaining']);
        const limit = Number(headers['x-ratelimit-limit']);
        const reset = Number(headers['x-ratelimit-reset']) * 1000 + 1000;
        if ([remaining, limit, reset].every(Number.isFinite)) {
          state.budgets[resource] = { remaining, limit, reset };
          persist();
        }
      };
      client.hook.wrap('request', (request, requestOptions) => {
        const endpoint = client.request.endpoint(requestOptions);
        const graph = new URL(endpoint.url).pathname === '/graphql';
        const resource = graph ? 'graphql' : endpoint.url.includes('/search/') ? 'search' : 'core';
        const get = endpoint.method === 'GET';
        // Binary images use a separate bounded memory cache, never the JSON disk cache.
        const cacheable = get && requestOptions.request.cache !== 'no-store';
        const graphRead =
          graph && typeof requestOptions.query === 'string' && /^\s*(query\b|\{)/.test(requestOptions.query);
        const requestKey = JSON.stringify([
          endpoint.url,
          endpoint.headers.accept,
          endpoint.headers['x-github-api-version'],
        ]);
        const force = /\b(no-cache|no-store)\b/i.test(String(endpoint.headers['cache-control'] ?? ''));
        const deduplicate = get && !force && !requestOptions.request.signal;
        const shared = deduplicate ? inflight.get(requestKey) : undefined;
        if (shared) return shared.then((result) => structuredClone(result));
        const run = async () => {
          const stored = cacheable ? cache.get(requestKey, isCachedResponse) : undefined;
          const cached = stored?.value;
          if (
            cached &&
            !force &&
            !stored.revalidate &&
            cached.freshUntil > now() &&
            cached.freshUntil <= stored.savedAt + 60_000
          ) {
            if (requestOptions.request.signal?.aborted) throw new Error('GitHub request was aborted');
            return structuredClone(cached.response);
          }
          const gate = () => {
            const deadline = Math.max(
              state.blockedUntil,
              state.budgets[resource]?.remaining === 0 ? state.budgets[resource].reset : 0
            );
            if (deadline > now()) throw new GitHubBackoffError(deadline);
          };
          gate();
          const spacing = (options.minSpacingMs ?? 100) - (now() - lastRequest);
          if (spacing > 0) await sleep(spacing);
          gate();
          lastRequest = now();
          // A failed write may still have reached GitHub. Invalidate without replaying it.
          if (!get && !graphRead) cache.clear();
          const version = cache.version();
          if (cached?.response.headers.etag) requestOptions.headers['if-none-match'] = cached.response.headers.etag;
          else if (cached?.response.headers['last-modified'])
            requestOptions.headers['if-modified-since'] = cached.response.headers['last-modified'];
          try {
            const response = await request(requestOptions);
            observe(response.headers);
            if (
              graph &&
              (response.data as { errors?: { type?: string }[] }).errors?.some((e) => e.type === 'RATE_LIMITED')
            ) {
              throw Object.assign(new Error('GitHub API rate limit exceeded'), { status: 403, response });
            }
            if (cacheable && version === cache.version()) {
              if (response.status === 200 && !/\bno-store\b/i.test(response.headers['cache-control'] ?? '')) {
                // Persist response data and validators, never authorization or request configuration.
                const headers = Object.fromEntries(
                  Object.entries(response.headers).filter(([name]) =>
                    ['etag', 'last-modified', 'cache-control', 'content-type', 'link', 'x-github-media-type'].includes(
                      name
                    )
                  )
                );
                const data: unknown = response.data;
                cache.set(requestKey, {
                  response: { status: response.status, url: response.url, headers, data },
                  freshUntil: freshness(response.headers, now()),
                });
              } else cache.delete(requestKey);
            }
            return response;
          } catch (error) {
            const e = error as { status?: number; response?: { headers?: Headers } };
            observe(e.response?.headers ?? {});
            if (e.status === 304 && cached) {
              const response = {
                ...structuredClone(cached.response),
                headers: { ...cached.response.headers, ...e.response?.headers },
              } as OctokitResponse<unknown>;
              if (/\bno-store\b/i.test(response.headers['cache-control'] ?? '')) cache.delete(requestKey);
              else if (version === cache.version())
                cache.set(requestKey, {
                  response: {
                    ...cached.response,
                    headers: {
                      ...cached.response.headers,
                      ...(response.headers.etag ? { etag: response.headers.etag } : {}),
                      ...(response.headers['cache-control']
                        ? { 'cache-control': response.headers['cache-control'] }
                        : {}),
                    },
                  },
                  freshUntil: freshness(response.headers, now()),
                });
              return response;
            }
            if (get && [401, 403, 404].includes(e.status ?? 0) && !githubRateLimit(error, now()))
              cache.delete(requestKey);
            const limited = githubRateLimit(error, now());
            if (limited) {
              if (String(e.response?.headers?.['x-ratelimit-remaining']) === '0') {
                state.blockedUntil = Math.max(state.blockedUntil, limited.retryAt);
              } else {
                state.secondaryStrikes = now() - state.lastSecondary > 3_600_000 ? 1 : state.secondaryStrikes + 1;
                state.lastSecondary = now();
                state.blockedUntil = Math.max(
                  state.blockedUntil,
                  limited.retryAt,
                  now() + Math.min(3_600_000, 60_000 * 2 ** (state.secondaryStrikes - 1))
                );
              }
              persist();
              throw new GitHubBackoffError(state.blockedUntil);
            }
            throw error;
          }
        };
        const result = tail.then(run);
        tail = result.then(
          () => {},
          () => {}
        );
        if (deduplicate) {
          inflight.set(requestKey, result);
          void result
            .finally(() => {
              if (inflight.get(requestKey) === result) inflight.delete(requestKey);
            })
            .catch(() => {});
        }
        return result.then((response) => structuredClone(response));
      });
      clients.set(key, client);
      return client;
    },
  };
}
export const githubClients = createGitHubClientPool();
export const getGitHubClient = (token?: string | null) => githubClients.client(token);

export async function fetchGitHubLogin(token: string, pool = githubClients): Promise<string> {
  const { data } = await pool.client(token).users.getAuthenticated();
  if (!data.login) throw new Error('GitHub did not return your username. Please try again.');
  pool.rememberLogin(token, data.login);
  return data.login;
}
