import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { GitHubDevicePrompt } from '../lib/github-auth';

const cancelledMessage = 'GitHub sign-in was cancelled.';
const expiredMessage = 'The GitHub sign-in code expired. Start sign-in again for a new code.';
const failureMessages: Record<string, string> = {
  access_denied: 'GitHub sign-in was declined. Try again or use a personal access token.',
  expired_token: expiredMessage,
  incorrect_device_code: expiredMessage,
  device_flow_disabled: 'Sign-in codes are unavailable for Gnosis. Use a personal access token instead.',
};
interface DeviceResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
  access_token?: string;
  error?: string;
}

/** Owns device secrets, polling and cancellation in the main process. */
export function createGitHubAuthService(io: {
  clientId: string;
  identify: (token: string) => Promise<string>;
  save: (token: string, login: string) => void;
  fetch?: typeof fetch;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
  const now = io.now ?? Date.now;
  const wait = io.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
  let active:
    | {
        id: string;
        controller: AbortController;
        code?: string;
        expiresAt: number;
        interval: number;
        completion?: Promise<string>;
      }
    | undefined;

  const isActive = (id: string) => active?.id === id;
  function cancel(id?: string) {
    if (active && (!id || active.id === id)) {
      active.controller.abort();
      active = undefined;
    }
  }
  async function post(path: string, values: Record<string, string>, signal: AbortSignal) {
    const response = await (io.fetch ?? fetch)(`https://github.com${path}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: io.clientId, ...values }).toString(),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    if (response.status === 429 || response.status === 503) {
      const retry = response.headers.get('retry-after');
      const seconds = Number(retry);
      const retryMs = retry && Number.isFinite(seconds) ? seconds * 1000 : retry ? Date.parse(retry) - now() : 30000;
      return { retryMs: Math.max(5000, Number.isFinite(retryMs) ? retryMs : 30000) };
    }
    const data = (await response.json()) as DeviceResponse;
    if (!response.ok && !data.error) throw new Error('GitHub sign-in is unavailable. Try again shortly.');
    return { data };
  }
  return {
    cancel,
    async begin(): Promise<GitHubDevicePrompt> {
      cancel();
      const flow = { id: randomUUID(), controller: new AbortController(), expiresAt: 0, interval: 5000 };
      active = flow;
      try {
        const result = await post('/login/device/code', { scope: 'repo' }, flow.controller.signal);
        if (active !== flow) throw new Error(cancelledMessage);
        const data = result.data;
        if (!data) throw new Error('GitHub is busy. Wait a moment and try signing in again.');
        if (data.error)
          throw new Error(
            failureMessages[data.error] ?? 'Could not start GitHub sign-in. Try again or use a personal access token.'
          );
        if (
          !data.device_code ||
          !data.user_code ||
          data.verification_uri !== 'https://github.com/login/device' ||
          !data.expires_in ||
          !Number.isFinite(data.expires_in) ||
          data.expires_in <= 0
        )
          throw new Error('GitHub returned an incomplete sign-in code. Try again.');
        flow.expiresAt = now() + Math.min(data.expires_in, 1800) * 1000;
        flow.interval = Math.max(5, Number.isFinite(data.interval) ? (data.interval ?? 5) : 5) * 1000;
        active = { ...flow, code: data.device_code };
        return {
          id: flow.id,
          userCode: data.user_code,
          verificationUri: data.verification_uri,
          expiresAt: flow.expiresAt,
        };
      } catch (error) {
        if (isActive(flow.id)) active = undefined;
        if (flow.controller.signal.aborted) throw new Error(cancelledMessage);
        if (error instanceof TypeError || error instanceof SyntaxError || error instanceof DOMException)
          throw new Error('Could not reach GitHub. Check your connection and try again.');
        throw error;
      }
    },
    complete(id: string): Promise<string> {
      const flow = active;
      if (!flow || flow.id !== id || !flow.code)
        return Promise.reject(new Error('This GitHub sign-in is no longer active. Start again.'));
      if (flow.completion) return flow.completion;
      const code = flow.code;
      const isCancelled = () => flow.controller.signal.aborted || active !== flow;
      const run = async () => {
        try {
          while (now() < flow.expiresAt) {
            await wait(Math.min(flow.interval, flow.expiresAt - now()), flow.controller.signal);
            if (isCancelled()) throw new Error(cancelledMessage);
            if (now() >= flow.expiresAt) break;
            const result = await post(
              '/login/oauth/access_token',
              {
                device_code: code,
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
              },
              flow.controller.signal
            );
            if (result.retryMs) {
              flow.interval = Math.max(flow.interval, result.retryMs);
              continue;
            }
            const data = result.data;
            if (!data) throw new Error('GitHub did not return a sign-in result. Try again.');
            if (data.error === 'authorization_pending') continue;
            if (data.error === 'slow_down') {
              flow.interval += 5000;
              continue;
            }
            if (data.error)
              throw new Error(
                failureMessages[data.error] ?? 'GitHub sign-in failed. Try again or use a personal access token.'
              );
            if (!data.access_token) throw new Error('GitHub did not return an access token. Start sign-in again.');
            const login = await io.identify(data.access_token);
            if (isCancelled()) throw new Error(cancelledMessage);
            if (now() >= flow.expiresAt) throw new Error(expiredMessage);
            io.save(data.access_token, login);
            return login;
          }
          throw new Error(expiredMessage);
        } catch (error) {
          if (isCancelled()) throw new Error(cancelledMessage);
          if (error instanceof TypeError || error instanceof SyntaxError || error instanceof DOMException)
            throw new Error('Could not reach GitHub. Check your connection and try again.');
          throw error;
        } finally {
          if (active === flow) active = undefined;
        }
      };
      flow.completion = run();
      return flow.completion;
    },
  };
}
