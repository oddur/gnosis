import http from 'node:http';
import crypto from 'node:crypto';

/** Browser OAuth is optional; device authorization is available without its build-time secret. */
export function createGitHubWebAuth(io: {
  clientId: string;
  clientSecret: string;
  open: (url: string) => Promise<void>;
  identify: (token: string) => Promise<string>;
  save: (token: string, login: string) => void;
  fetch?: typeof fetch;
  timeoutMs?: number;
}) {
  let stop: (() => void) | undefined;
  return {
    cancel: () => stop?.(),
    start(): Promise<void> {
      stop?.();
      if (!io.clientSecret)
        return Promise.reject(new Error('Browser sign-in is unavailable. Use a sign-in code instead.'));
      return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const state = crypto.randomBytes(24).toString('hex');
        const verifier = crypto.randomBytes(32).toString('base64url');
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        let done = false;
        const isDone = () => done;
        let exchanging = false;
        let redirectUri = '';
        let pendingResponse: http.ServerResponse | undefined;
        const finish = (error?: Error) => {
          if (isDone()) return;
          done = true;
          clearTimeout(timeout);
          controller.abort();
          if (error && pendingResponse && !pendingResponse.writableEnded) {
            pendingResponse.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            pendingResponse.end('<html><body><p>Sign-in stopped. Return to Gnosis to try again.</p></body></html>');
          }
          server.close();
          if (stop === cancel) stop = undefined;
          if (error) reject(error);
          else resolve();
        };
        const cancel = () => finish(new Error('GitHub sign-in was cancelled.'));
        const server = http.createServer((req, res) => {
          const respond = (status: number, message: string) => {
            res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(`<html><body><p>${message}</p></body></html>`);
          };
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          if (url.pathname !== '/callback') {
            respond(404, 'Not found.');
            return;
          }
          if (url.searchParams.get('state') !== state) {
            respond(400, 'This sign-in link is invalid. Return to Gnosis to try again.');
            return;
          }
          if (done || exchanging) {
            respond(409, 'This sign-in is already being handled. Return to Gnosis.');
            return;
          }
          const code = url.searchParams.get('code');
          if (url.searchParams.has('error') || !code) {
            respond(400, 'Sign-in was not approved. Return to Gnosis to try again or use a sign-in code.');
            finish(new Error('GitHub sign-in was not approved. Try again or use a sign-in code.'));
            return;
          }
          exchanging = true;
          pendingResponse = res;
          void (async () => {
            try {
              const response = await (io.fetch ?? fetch)('https://github.com/login/oauth/access_token', {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                  client_id: io.clientId,
                  client_secret: io.clientSecret,
                  code,
                  code_verifier: verifier,
                  redirect_uri: redirectUri,
                }).toString(),
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
              });
              const data = (await response.json()) as { access_token?: string };
              if (!response.ok || !data.access_token)
                throw new Error('Browser sign-in could not be completed. Use a sign-in code instead.');
              const login = await io.identify(data.access_token);
              if (isDone()) return;
              io.save(data.access_token, login);
              respond(200, 'You are now signed in to Gnosis. You can close this tab.');
              finish();
            } catch {
              if (isDone()) return;
              respond(500, 'Sign-in failed. Return to Gnosis and use a sign-in code or personal access token.');
              finish(new Error('Browser sign-in could not be completed. Use a sign-in code instead.'));
            }
          })();
        });
        const timeout = setTimeout(
          () => finish(new Error('Browser sign-in timed out. Try again or use a sign-in code.')),
          io.timeoutMs ?? 5 * 60 * 1000
        );
        stop = cancel;
        server.on('error', () => finish(new Error('Could not start browser sign-in. Use a sign-in code instead.')));
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          if (!address || typeof address === 'string') {
            finish(new Error('Could not start browser sign-in. Use a sign-in code instead.'));
            return;
          }
          redirectUri = `http://127.0.0.1:${address.port}/callback`;
          const params = new URLSearchParams({
            client_id: io.clientId,
            redirect_uri: redirectUri,
            scope: 'repo',
            state,
            code_challenge: challenge,
            code_challenge_method: 'S256',
          });
          void io
            .open(`https://github.com/login/oauth/authorize?${params}`)
            .catch(() => finish(new Error('Could not open your browser. Use a sign-in code instead.')));
        });
      });
    },
  };
}
