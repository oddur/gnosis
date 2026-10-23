import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGitHubAuthService } from '../src/github-auth-service';
import { createGitHubWebAuth } from '../src/github-web-auth';
import { checkGitHubPrAccess, githubAccessMessage } from '../lib/github-auth';
import { createGitHubClientPool } from '../lib/github-client';

const deviceResponse = {
  device_code: 'private-device-code',
  user_code: 'ABCD-1234',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
};
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

void test('device sign-in keeps its secret in main, respects polling/slow-down/Retry-After, and saves once', async () => {
  let now = 0;
  const waits: number[] = [];
  const requests: URLSearchParams[] = [];
  const responses = [
    json(deviceResponse),
    json({ error: 'authorization_pending' }),
    json({ error: 'slow_down' }),
    json({}, 429, { 'retry-after': '20' }),
    json({ access_token: 'result-token' }),
  ];
  const saved: string[] = [];
  const service = createGitHubAuthService({
    clientId: 'public-client',
    now: () => now,
    wait: (ms) => {
      waits.push(ms);
      now += ms;
      return Promise.resolve();
    },
    fetch: ((_url, init) => {
      requests.push(new URLSearchParams(typeof init?.body === 'string' ? init.body : ''));
      const r = responses.shift();
      assert.ok(r);
      return Promise.resolve(r);
    }) as typeof fetch,
    identify: () => Promise.resolve('reviewer'),
    save: (token, login) => saved.push(token + ':' + login),
  });
  const prompt = await service.begin();
  assert.equal(JSON.stringify(prompt).includes('private-device-code'), false);
  const first = service.complete(prompt.id);
  assert.equal(service.complete(prompt.id), first);
  assert.equal(await first, 'reviewer');
  assert.deepEqual(waits, [5000, 5000, 10000, 20000]);
  assert.deepEqual(saved, ['result-token:reviewer']);
  assert.ok(requests.every((r) => !r.has('client_secret')));
  assert.equal(requests[1].get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
});
void test('device denial, expiry, and disabled applications offer recovery without saving tokens', async () => {
  for (const error of ['access_denied', 'expired_token', 'device_flow_disabled']) {
    let now = 0;
    let n = 0;
    const service = createGitHubAuthService({
      clientId: 'client',
      now: () => now,
      wait: (ms) => {
        now += ms;
        return Promise.resolve();
      },
      fetch: (() => Promise.resolve(json(n++ ? { error } : deviceResponse))) as typeof fetch,
      identify: () => Promise.resolve('reviewer'),
      save: () => assert.fail('must not save'),
    });
    const p = await service.begin();
    await assert.rejects(service.complete(p.id), /declined|expired|unavailable/);
  }
  let now = 0;
  const service = createGitHubAuthService({
    clientId: 'client',
    now: () => now,
    wait: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    fetch: (() => Promise.resolve(json({ ...deviceResponse, expires_in: 5 }))) as typeof fetch,
    identify: () => Promise.resolve('reviewer'),
    save: () => assert.fail('expired'),
  });
  const p = await service.begin();
  await assert.rejects(service.complete(p.id), /expired/);
});
void test('cancelling device sign-in during identity lookup cannot overwrite a newer account', async () => {
  let resolveIdentity: (login: string) => void = () => {};
  let entered: () => void = () => {};
  const identifying = new Promise<void>((r) => {
    entered = r;
  });
  let calls = 0;
  const service = createGitHubAuthService({
    clientId: 'client',
    wait: () => Promise.resolve(),
    fetch: (() => Promise.resolve(json(calls++ ? { access_token: 'old-token' } : deviceResponse))) as typeof fetch,
    identify: () => {
      entered();
      return new Promise((r) => {
        resolveIdentity = r;
      });
    },
    save: () => assert.fail('cancelled flow saved'),
  });
  const p = await service.begin();
  const complete = service.complete(p.id);
  const rejected = assert.rejects(complete, /cancelled/);
  await identifying;
  service.cancel(p.id);
  resolveIdentity('old-account');
  await rejected;
});
void test('malformed device response cannot redirect sign-in to another host', async () => {
  const service = createGitHubAuthService({
    clientId: 'client',
    fetch: (() =>
      Promise.resolve(json({ ...deviceResponse, verification_uri: 'https://evil.example' }))) as typeof fetch,
    identify: () => Promise.resolve('x'),
    save: () => assert.fail('unexpected'),
  });
  await assert.rejects(service.begin(), /incomplete/);
});
void test('browser OAuth uses state and PKCE, ignores an invalid callback, then saves the account', async () => {
  let opened: (url: string) => void = () => {};
  const opening = new Promise<string>((r) => {
    opened = r;
  });
  const saved: string[] = [];
  let params = new URLSearchParams();
  const service = createGitHubWebAuth({
    clientId: 'client',
    clientSecret: 'build-secret',
    open: (url) => {
      opened(url);
      return Promise.resolve();
    },
    identify: () => Promise.resolve('reviewer'),
    save: (token, login) => saved.push(token + ':' + login),
    fetch: ((_url, init) => {
      params = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
      return Promise.resolve(json({ access_token: 'browser-token' }));
    }) as typeof fetch,
  });
  const completing = service.start();
  try {
    const auth = new URL(await opening);
    const callback = auth.searchParams.get('redirect_uri');
    assert.ok(callback);
    assert.equal((await fetch(callback + '?state=wrong&code=bad')).status, 400);
    const response = await fetch(
      callback + '?' + new URLSearchParams({ state: auth.searchParams.get('state') ?? '', code: 'approved' }).toString()
    );
    assert.equal(response.status, 200);
    await completing;
    assert.equal(
      createHash('sha256')
        .update(params.get('code_verifier') ?? '')
        .digest('base64url'),
      auth.searchParams.get('code_challenge')
    );
    assert.equal(params.get('client_secret'), 'build-secret');
    assert.deepEqual(saved, ['browser-token:reviewer']);
  } finally {
    service.cancel();
  }
});
void test('browser failures and cancellation support device fallback without late saves', async () => {
  let opens = 0;
  const missing = createGitHubWebAuth({
    clientId: 'client',
    clientSecret: '',
    open: () => {
      opens++;
      return Promise.resolve();
    },
    identify: () => Promise.resolve('x'),
    save: () => assert.fail('saved'),
  });
  await assert.rejects(missing.start(), /sign-in code/);
  assert.equal(opens, 0);
  const failed = createGitHubWebAuth({
    clientId: 'client',
    clientSecret: 'secret',
    open: () => Promise.reject(new Error('no browser')),
    identify: () => Promise.resolve('x'),
    save: () => assert.fail('saved'),
  });
  await assert.rejects(failed.start(), /sign-in code/);
  let opened: () => void = () => {};
  const ready = new Promise<void>((r) => {
    opened = r;
  });
  const cancelled = createGitHubWebAuth({
    clientId: 'client',
    clientSecret: 'secret',
    open: () => {
      opened();
      return Promise.resolve();
    },
    identify: () => Promise.resolve('x'),
    save: () => assert.fail('saved'),
  });
  const pending = cancelled.start();
  const rejected = assert.rejects(pending, /cancelled/);
  await ready;
  cancelled.cancel();
  await rejected;
});
void test('PR access checks require contents on both source repositories and reuse shared cached reads', async () => {
  const reads: string[] = [];
  let denied = true;
  const pool = createGitHubClientPool({
    minSpacingMs: 0,
    fetch: ((url: string) => {
      reads.push(url);
      if (url.includes('/pulls/'))
        return Promise.resolve(
          json({
            base: { repo: { full_name: 'o/r' }, sha: 'base' },
            head: { repo: { full_name: 'fork/r' }, sha: 'head' },
          })
        );
      if (denied) return Promise.resolve(json({ message: 'Resource not accessible by personal access token' }, 403));
      return Promise.resolve(json({ sha: 'revision' }));
    }) as typeof fetch,
  });
  const client = pool.client('token');
  await assert.rejects(checkGitHubPrAccess(client, 'https://github.com/o/r/pull/1'), /Contents: Read/);
  denied = false;
  await checkGitHubPrAccess(client, 'https://github.com/o/r/pull/1');
  assert.ok(reads.some((r) => r.includes('/repos/fork/r/git/commits/head')));
  const count = reads.length;
  await checkGitHubPrAccess(client, 'https://github.com/o/r/pull/1');
  assert.equal(reads.length, count);
  assert.match(githubAccessMessage({ status: 404 }, 'o/private'), /o\/private.*Pull requests: Read/);
  assert.match(githubAccessMessage({ status: 401 }), /expired|invalid/);
});

void test('cancelling browser OAuth during identity lookup ends its callback and never saves the late account', async () => {
  let opened: (url: string) => void = () => {};
  const opening = new Promise<string>((r) => {
    opened = r;
  });
  let entered: () => void = () => {};
  const identifying = new Promise<void>((r) => {
    entered = r;
  });
  let identify: (login: string) => void = () => {};
  let saves = 0;
  const service = createGitHubWebAuth({
    clientId: 'client',
    clientSecret: 'secret',
    open: (url) => {
      opened(url);
      return Promise.resolve();
    },
    fetch: (() => Promise.resolve(json({ access_token: 'late-token' }))) as typeof fetch,
    identify: () => {
      entered();
      return new Promise((r) => {
        identify = r;
      });
    },
    save: () => {
      saves++;
    },
  });
  const run = service.start();
  const rejected = assert.rejects(run, /cancelled/);
  const url = new URL(await opening);
  const callback = url.searchParams.get('redirect_uri');
  assert.ok(callback);
  const response = fetch(
    callback + '?' + new URLSearchParams({ state: url.searchParams.get('state') ?? '', code: 'ok' }).toString()
  );
  await identifying;
  service.cancel();
  identify('late-account');
  await rejected;
  assert.equal((await response).status, 400);
  assert.equal(saves, 0);
});
