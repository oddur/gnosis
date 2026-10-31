import { Octokit } from '@octokit/rest';
import type { OctokitResponse } from '@octokit/types';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createGitHubCache, isCacheRecord, type GitHubCache } from './github-cache';
import {
  createGitHubScheduler,
  githubPriority,
  githubPriorityScope,
  createGitHubWork,
  joinGitHubWork,
  githubReadSignal,
  type GitHubWork,
} from './github-scheduler';

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
/** Read existing account snapshots without revalidating them or making requests. */
export function githubCachedResponses(client: Octokit) {
  return (
    clientCaches
      .get(client)
      ?.values(isCachedResponse)
      .map((entry) => entry.response) ?? []
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
// Leave ten percent of each allowance for explicit user work and other clients.
const backgroundReserve = (resource: string, budget: Budget) =>
  Math.min(resource === 'search' ? 3 : 1000, budget.limit * 0.1);
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
    super(`${reason}. GitHub requests can resume after ${new Date(retryAt).toISOString()}.`);
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
  readTimeoutMs?: number;
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
  const backoff = (token?: string | null, background = false, resources?: readonly string[]) => {
    const state = stateFor(keyFor(token));
    let hardDeadline = state.blockedUntil;
    let reserveDeadline = 0;
    for (const [resource, budget] of Object.entries(state.budgets)) {
      if (resources && !resources.includes(resource)) continue;
      if (!budget) continue;
      if (budget.remaining <= 0) hardDeadline = Math.max(hardDeadline, budget.reset);
      else if (background && budget.remaining <= backgroundReserve(resource, budget))
        reserveDeadline = Math.max(reserveDeadline, budget.reset);
    }
    if (hardDeadline > now()) return new GitHubBackoffError(hardDeadline);
    if (reserveDeadline > now())
      return new GitHubBackoffError(reserveDeadline, 'Background updates paused to preserve your API allowance');
  };
  return {
    backoff,
    setCacheSizeMB: (value: unknown) => snapshots.setSizeMB(value),
    flushStorage: () => snapshots.flush(),
    closeStorage: () => snapshots.close(),
    async setStorage(file: string) {
      storage = file;
      await snapshots.setStorage(path.join(path.dirname(file), 'github-cache.json'));
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
      const schedule = createGitHubScheduler();
      const backgroundDue = new Map<string, number>();
      let lastRequest = 0;
      const cache = snapshots.scope(key);
      clientCaches.set(client, cache);
      const inflight = new Map<string, GitHubWork<OctokitResponse<unknown>>>();
      // An expensive PR can repeatedly return 5xx. Cool down that read only;
      // cached data, other PRs, and explicit writes must stay independent.
      const unavailable = new Map<string, { retryAt: number; failures: number; error: Error }>();
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
        // Octokit can reuse default request options. A completed/aborted signal
        // belongs to this invocation, never to later reads through the client.
        requestOptions.request = { ...requestOptions.request };
        const endpoint = client.request.endpoint(requestOptions);
        const graph = new URL(endpoint.url).pathname === '/graphql';
        const resource = graph ? 'graphql' : endpoint.url.includes('/search/') ? 'search' : 'core';
        const get = endpoint.method === 'GET';
        // Binary images use a separate bounded memory cache, never the JSON disk cache.
        const binary = requestOptions.request.responseType === 'arraybuffer';
        const cacheable = get && !binary && requestOptions.request.cache !== 'no-store';
        const graphRead =
          graph && typeof requestOptions.query === 'string' && /^\s*(query\b|\{)/.test(requestOptions.query);
        const readOnly = get || graphRead;
        const inherited = readOnly && githubReadSignal();
        if (inherited) requestOptions.request.signal = requestOptions.request.signal
          ? AbortSignal.any([inherited, requestOptions.request.signal]) : inherited;
        const requestKey = JSON.stringify([
          endpoint.url,
          endpoint.headers.accept,
          endpoint.headers['x-github-api-version'],
          ...(binary ? ['arraybuffer'] : []),
        ]);
        const force = /\b(no-cache|no-store)\b/i.test(String(endpoint.headers['cache-control'] ?? ''));
        const deduplicate = get && !force && !requestOptions.request.signal;
        const fresh = () => {
          const saved = cacheable ? cache.get(requestKey, isCachedResponse) : undefined;
          if (
            saved &&
            !force &&
            !saved.revalidate &&
            saved.value.freshUntil > now() &&
            saved.value.freshUntil <= saved.savedAt + 60_000
          )
            return saved.value.response;
        };
        // Local reads never join the network scheduler, including during backoff.
        const local = fresh();
        if (local) {
          if (requestOptions.request.signal?.aborted) return Promise.reject(new Error('GitHub request was aborted'));
          return Promise.resolve(structuredClone(local));
        }
        const shared = deduplicate ? inflight.get(requestKey) : undefined;
        if (shared) return joinGitHubWork(shared).then((result) => structuredClone(result));
        const paced = Symbol('background pacing');
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
            requestOptions.request.signal?.throwIfAborted();
            const failed = get && unavailable.get(requestKey);
            if (failed && failed.retryAt > now()) throw failed.error;
            const priority = githubPriority();
            const budget = state.budgets[resource];
            const reserve =
              priority === 'background' && budget ? backgroundReserve(resource, budget) : 0;
            const deadline = Math.max(
              state.blockedUntil,
              budget && budget.remaining <= reserve ? budget.reset : 0
            );
            if (deadline > now())
              throw new GitHubBackoffError(
                deadline,
                priority === 'background'
                  ? 'Background updates are waiting to preserve your GitHub allowance'
                  : undefined
              );
          };
          gate();
          // Pacing is not a failed operation. Release the network scheduler while
          // waiting, and resume this request so multi-request reads keep their progress.
          if (githubPriority() === 'background' && (backgroundDue.get(resource) ?? 0) > now()) return paced;
          const spacing = (options.minSpacingMs ?? 100) - (now() - lastRequest);
          if (spacing > 0) await sleep(spacing);
          gate();
          lastRequest = now();
          // A failed write may still have reached GitHub. Invalidate without replaying it.
          const invalidateWrite = () => {
            const lfsDownload =
              endpoint.method === 'POST' &&
              new URL(endpoint.url).hostname === 'github.com' &&
              /^\/[\w.-]+\/[\w.-]+\.git\/info\/lfs\/objects\/batch$/.test(new URL(endpoint.url).pathname) &&
              (requestOptions.data as { operation?: string } | undefined)?.operation === 'download';
            if (get || graphRead || lfsDownload) return;
            const match = /^\/repos\/([^/]+)\/([^/]+)\/(?:issues|pulls)(?:\/(\d+))?/.exec(
              new URL(endpoint.url).pathname
            );
            if (!match) {
              cache.revalidate();
              return;
            }
            const repoPath = `/repos/${match[1]}/${match[2]}/`;
            const prUrl = `https://github.com/${match[1]}/${match[2]}/pull/`;
            cache.invalidate((value) => {
              if (isCachedResponse(value)) {
                let pathname: string;
                try {
                  pathname = new URL(value.response.url).pathname;
                } catch {
                  return true;
                }
                if (pathname.startsWith('/search/')) return true;
                if (!pathname.startsWith(repoPath)) return false;
                const number = /\/(?:issues|pulls)\/(\d+)(?:\/|$)/.exec(pathname)?.[1];
                return !match[3] || !number || number === match[3];
              }
              // Derived status snapshots store the source PR URL alongside their data.
              return (
                isCacheRecord(value) &&
                typeof value.url === 'string' &&
                (match[3] ? value.url === prUrl + match[3] : value.url.startsWith(prUrl))
              );
            });
          };
          invalidateWrite();
          const version = cache.version();
          if (cached?.response.headers.etag) requestOptions.headers['if-none-match'] = cached.response.headers.etag;
          else if (cached?.response.headers['last-modified'])
            requestOptions.headers['if-modified-since'] = cached.response.headers['last-modified'];
          const timeout = new AbortController();
          const timer = readOnly ? setTimeout(() => timeout.abort(new Error('GitHub took too long to respond. Retry this PR.')), options.readTimeoutMs ?? 30_000) : undefined;
          if (readOnly) requestOptions.request.signal = requestOptions.request.signal
            ? AbortSignal.any([requestOptions.request.signal, timeout.signal]) : timeout.signal;
          try {
            // Hooks share the original options object, including auth and request logging.
            if (binary) requestOptions.request.parseSuccessResponseBody = false;
            const response = await request(requestOptions);
            if (get) unavailable.delete(requestKey);
            if (binary) {
              // GitHub raw images can carry charset=utf-8. Bypass Octokit's text decoding,
              // then consume the stream before cloning/coalescing the response for callers.
              response.data = await new Response(response.data as ReadableStream<Uint8Array>).arrayBuffer();
            }
            observe(response.headers);
            const budget = state.budgets[resource];
            const priority = githubPriority();
            if (priority === 'background' && budget && budget.reset > now()) {
              const reserve = backgroundReserve(resource, budget);
              backgroundDue.set(
                resource,
                now() + Math.ceil((budget.reset - now()) / Math.max(1, budget.remaining - reserve))
              );
            }
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
                  response: { status: response.status, url: response.url || endpoint.url, headers, data },
                  freshUntil: freshness(response.headers, now()),
                });
              } else cache.delete(requestKey);
            }
            return response;
          } catch (error) {
            // Abort is not a server failure and must not poison the endpoint cooldown.
            if (requestOptions.request.signal?.aborted) throw requestOptions.request.signal.reason;
            const e = error as { status?: number; response?: { headers?: Headers } };
            observe(e.response?.headers ?? {});
            if (e.status === 304 && cached) {
              unavailable.delete(requestKey);
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
                // Primary allowances are independent. A depleted search budget
                // must not stop an interactive REST or GraphQL request.
                state.budgets[resource] = {
                  remaining: 0,
                  limit: state.budgets[resource]?.limit ?? 0,
                  reset: limited.retryAt,
                };
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
              throw new GitHubBackoffError(Math.max(state.blockedUntil, limited.retryAt));
            }
            if (get && [500, 502, 503, 504].includes(e.status ?? 0)) {
              const previous = unavailable.get(requestKey);
              const failures = previous && now() - previous.retryAt < 300_000 ? previous.failures + 1 : 1;
              const retry = e.response?.headers?.['retry-after'];
              const seconds = Number(retry);
              const serverDeadline = retry === undefined ? 0 : Number.isFinite(seconds)
                ? now() + seconds * 1000 : Date.parse(String(retry));
              const retryAt = Math.max(now() + Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4)),
                Number.isFinite(serverDeadline) ? serverDeadline + 1000 : 0);
              const failure = Object.assign(new Error(
                `GitHub could not load this data (HTTP ${e.status}). Try again after ${new Date(retryAt).toISOString()}.`
              ), { retryAt, status: e.status });
              unavailable.delete(requestKey);
              unavailable.set(requestKey, { retryAt, failures, error: failure });
              while (unavailable.size > 200) {
                const oldest = unavailable.keys().next().value;
                if (oldest === undefined) break;
                unavailable.delete(oldest);
              }
              throw failure;
            }
            throw error;
          } finally {
            if (timer) clearTimeout(timer);
            invalidateWrite();
          }
        };
        const work = createGitHubWork(async () => {
          for (;;) {
            const result = await schedule(githubPriorityScope(), run);
            if (result !== paced) return result;
            // A coalesced click can promote this work. Recheck often without
            // occupying a network slot or delaying unrelated interactive requests.
            await sleep(Math.min(100, Math.max(1, (backgroundDue.get(resource) ?? 0) - now())));
          }
        });
        const result = work.promise;
        if (deduplicate) {
          inflight.set(requestKey, work);
          void result
            .finally(() => {
              if (inflight.get(requestKey) === work) inflight.delete(requestKey);
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
