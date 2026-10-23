import { useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import type { GitHubDevicePrompt } from '../lib/github-auth';

function message(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    ''
  );
}

export function GitHubAuthDialog({
  open,
  onOpenChange,
  onConnected,
  onSignedOut,
  onContinueLocally,
  connectionRequired = false,
  login,
  prUrl,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => Promise<void>;
  onSignedOut: () => Promise<void>;
  onContinueLocally: () => Promise<void>;
  connectionRequired?: boolean;
  login?: string | null;
  prUrl?: string;
}) {
  const [web, setWeb] = useState<boolean>();
  const [method, setMethod] = useState<'web' | 'device' | 'token'>('web');
  const [phase, setPhase] = useState<'idle' | 'starting' | 'waiting' | 'saving' | 'signing-out' | 'local'>('idle');
  const [prompt, setPrompt] = useState<GitHubDevicePrompt>();
  const [error, setError] = useState('');
  const [token, setToken] = useState('');
  const [checkUrl, setCheckUrl] = useState(prUrl ?? '');
  const [copied, setCopied] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  const attempt = useRef(0);
  const flow = useRef<string | undefined>(undefined);
  const webPending = useRef(false);
  const locked = phase === 'saving' || phase === 'signing-out' || phase === 'local';
  const busy = phase === 'starting' || locked;

  const cancel = () => {
    attempt.current++;
    if (flow.current) void window.electronAPI.cancelGitHubSignIn(flow.current).catch(() => {});
    if (webPending.current) void window.electronAPI.cancelOAuth().catch(() => {});
    flow.current = undefined;
    webPending.current = false;
  };
  const success = async (id: number) => {
    if (id !== attempt.current) return;
    flow.current = undefined;
    webPending.current = false;
    await onConnected();
    if (id === attempt.current) onOpenChange(false);
  };
  const device = async () => {
    cancel();
    const id = attempt.current;
    setMethod('device');
    setPhase('starting');
    setPrompt(undefined);
    setError('');
    setCopied(false);
    try {
      const next = await window.electronAPI.beginGitHubSignIn();
      if (id !== attempt.current) {
        await window.electronAPI.cancelGitHubSignIn(next.id);
        return;
      }
      flow.current = next.id;
      setPrompt(next);
      setPhase('waiting');
      await window.electronAPI.completeGitHubSignIn(next.id);
      await success(id);
    } catch (e) {
      if (id === attempt.current) {
        setError(message(e));
        setPrompt(undefined);
      }
    } finally {
      if (id === attempt.current) setPhase('idle');
    }
  };
  const browser = async () => {
    cancel();
    const id = attempt.current;
    webPending.current = true;
    setMethod('web');
    setPhase('waiting');
    setPrompt(undefined);
    setError('');
    try {
      await window.electronAPI.startOAuth();
      await success(id);
    } catch (e) {
      if (id === attempt.current) setError(message(e));
    } finally {
      if (id === attempt.current) {
        webPending.current = false;
        setPhase('idle');
      }
    }
  };
  useEffect(() => {
    if (!open) return;
    title.current?.focus();
    setError('');
    setToken('');
    setPrompt(undefined);
    setWeb(undefined);
    setPhase('idle');
    setMethod('web');
    setCheckUrl(prUrl ?? '');
    const id = ++attempt.current;
    void window.electronAPI
      .githubAuthOptions()
      .then((options) => {
        if (id !== attempt.current) return;
        setWeb(options.web);
        if (!options.web && !login) void device();
      })
      .catch((e: unknown) => {
        if (id === attempt.current) {
          setError(message(e));
          setWeb(false);
        }
      });
    return cancel;
    // The connection attempt belongs to this opening, not to queue polling renders.
  }, [open, login, connectionRequired]);

  const change = (next: boolean) => {
    if (locked || (!next && connectionRequired)) return;
    if (!next) cancel();
    onOpenChange(next);
  };
  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent
        className="github-auth-dialog"
        showCloseButton={!locked && !connectionRequired}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          title.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle ref={title} tabIndex={-1} className="outline-none">
            {login ? 'GitHub account' : 'Connect GitHub'}
          </DialogTitle>
          <DialogDescription>
            {login
              ? `Connected as ${login}. Sign in again after changing GitHub permissions, or connect another account.`
              : 'Sign in to load your PR queue and access private repositories. Connect your AI tool separately to generate explanations.'}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p className="github-auth-error" role="alert">
            {error}
          </p>
        )}
        {web === undefined ? (
          <p role="status">Checking sign-in options…</p>
        ) : (
          <>
            {method !== 'token' && (
              <>
                {prompt ? (
                  <div className="github-device-prompt">
                    <p>Copy this code, open GitHub, then enter it to authorize Gnosis:</p>
                    <code aria-label="GitHub sign-in code">{prompt.userCode}</code>
                    <div className="github-auth-actions">
                      <Button
                        size="sm"
                        onClick={() =>
                          void window.electronAPI
                            .openExternal(prompt.verificationUri)
                            .catch((e: unknown) => setError(message(e)))
                        }
                      >
                        Open GitHub <ExternalLink size={14} />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          void navigator.clipboard
                            .writeText(prompt.userCode)
                            .then(() => setCopied(true))
                            .catch(() => setError('Could not copy the code. Select it and copy it manually.'));
                        }}
                      >
                        <Copy size={14} />
                        {copied ? 'Copied' : 'Copy code'}
                      </Button>
                    </div>
                    <p role="status">
                      <Loader2 size={14} className="animate-spin" /> Waiting for you to authorize Gnosis on GitHub.
                      Return here afterward; sign-in completes automatically.
                    </p>
                    <p className="github-auth-hint">
                      Code expires at{' '}
                      {new Date(prompt.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.
                    </p>
                  </div>
                ) : (
                  <>
                    {web && (
                      <Button disabled={busy || phase === 'waiting'} onClick={() => void browser()}>
                        {phase === 'waiting' && method === 'web'
                          ? 'Waiting for GitHub authorization…'
                          : 'Sign in through browser'}{' '}
                        <ExternalLink size={14} />
                      </Button>
                    )}
                    <Button variant={web ? 'outline' : 'default'} disabled={busy} onClick={() => void device()}>
                      {phase === 'starting' ? 'Requesting a code…' : 'Sign in with a code'}
                    </Button>
                    {phase === 'waiting' && method === 'web' && (
                      <p className="github-auth-hint" role="status">
                        Finish signing in in your browser. If it does not work, use a sign-in code instead.
                      </p>
                    )}
                    {!web && <p className="github-auth-hint">Get a code to enter on GitHub in your browser.</p>}
                  </>
                )}
                <button
                  className="workbench-help-link"
                  disabled={busy}
                  onClick={() => {
                    cancel();
                    setMethod('token');
                    setPhase('idle');
                    setPrompt(undefined);
                    setError('');
                  }}
                >
                  Use a personal access token
                </button>
              </>
            )}
            {method === 'token' && (
              <form
                className="github-token-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  cancel();
                  const id = attempt.current;
                  setPhase('saving');
                  setError('');
                  void window.electronAPI
                    .savePat(token, checkUrl.trim() || undefined)
                    .then(() => success(id))
                    .catch((e: unknown) => {
                      if (id === attempt.current) setError(message(e));
                    })
                    .finally(() => {
                      if (id === attempt.current) setPhase('idle');
                    });
                }}
              >
                <p>
                  For explanations, allow <strong>Pull requests: Read</strong> and <strong>Contents: Read</strong> on
                  the repositories you review.
                </p>
                <details className="github-token-help">
                  <summary>Token setup and additional permissions</summary>
                  <p>
                    Under Resource owner, select the account or organization that owns the repositories, then include
                    the repositories you review. Your organization may require administrator approval or single sign-on
                    (SSO) authorization.
                  </p>
                  <p>
                    Allow <strong>Checks: Read</strong> and <strong>Commit statuses: Read</strong> for CI status. To
                    submit reviews and replies, allow <strong>Pull requests: Read and write</strong>. A classic token
                    needs the repo scope.
                  </p>
                  <button
                    className="workbench-help-link"
                    type="button"
                    onClick={() =>
                      void window.electronAPI
                        .openExternal('https://github.com/settings/personal-access-tokens/new')
                        .catch((e: unknown) => setError(message(e)))
                    }
                  >
                    Create a token on GitHub <ExternalLink size={12} />
                  </button>
                </details>
                <label htmlFor="github-auth-token">Personal access token</label>
                <input
                  id="github-auth-token"
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  autoComplete="off"
                  required
                  disabled={busy}
                />
                <label htmlFor="github-auth-pr">
                  PR URL to check <span>(optional)</span>
                </label>
                <input
                  aria-describedby="github-auth-pr-help"
                  id="github-auth-pr"
                  type="url"
                  value={checkUrl}
                  onChange={(e) => setCheckUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo/pull/123"
                  disabled={busy}
                />
                <p className="github-auth-hint" id="github-auth-pr-help">
                  Recommended: add a PR URL to check access to that PR and its code before saving. Leave it blank to
                  verify only your account; repository access is checked when you generate an explanation.
                </p>
                <Button disabled={busy || !token.trim()} type="submit">
                  {busy ? 'Checking access…' : 'Check and connect'}
                </Button>
                <button
                  className="workbench-help-link"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setToken('');
                    setError('');
                    setMethod('web');
                  }}
                >
                  Back to sign-in options
                </button>
              </form>
            )}
          </>
        )}
        {login && (
          <button
            className="workbench-help-link"
            disabled={busy}
            onClick={() => {
              cancel();
              setPhase('signing-out');
              setError('');
              void window.electronAPI
                .signOut()
                .then(onSignedOut)
                .catch((e: unknown) => {
                  setPhase('idle');
                  setError(message(e));
                });
            }}
          >
            {phase === 'signing-out' ? 'Signing out…' : 'Sign out of GitHub'}
          </button>
        )}
        {!login && (
          <Button
            size="sm"
            variant="ghost"
            disabled={locked}
            onClick={() => {
              cancel();
              setPrompt(undefined);
              setPhase('local');
              setError('');
              void onContinueLocally().catch((e: unknown) => {
                setPhase('idle');
                setError(message(e));
              });
            }}
          >
            {phase === 'local' ? 'Opening local reviews…' : 'Continue with local reviews'}
          </Button>
        )}
        {!connectionRequired && (
          <Button size="sm" variant="ghost" disabled={locked} onClick={() => change(false)}>
            {phase === 'starting' || phase === 'waiting' ? 'Cancel sign-in' : 'Close'}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
