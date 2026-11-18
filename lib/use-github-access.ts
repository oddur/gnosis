import { useSyncExternalStore } from 'react';
import type { GitHubAccess } from './github-access';

/**
 * The signed-in account and the scopes GitHub reports for its token, shared by every component in this window. Read
 * once from `getAuthState`, then kept current by main's `github-access-changed` broadcasts.
 */
let access: GitHubAccess | undefined;
let started = false;
const listeners = new Set<() => void>();
const emit = (next: GitHubAccess) => {
  if (access && access.login === next.login && JSON.stringify(access.scopes) === JSON.stringify(next.scopes)) return;
  access = next;
  for (const listener of listeners) listener();
};

/** Read the account and scopes again, after signing in or out. */
export function refreshGitHubAccess(): Promise<void> {
  const api = typeof window === 'undefined' ? undefined : window.electronAPI;
  if (!api?.getAuthState) return Promise.resolve();
  return api
    .getAuthState()
    .then((auth) => emit({ login: auth.authenticated ? auth.login : null, scopes: auth.authenticated ? auth.scopes : undefined }))
    .catch(() => {});
}

function start() {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.electronAPI.onGitHubAccessChanged?.((next) => emit(next));
  void refreshGitHubAccess();
}

function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useGitHubAccess(): GitHubAccess | undefined {
  return useSyncExternalStore(subscribe, () => access, () => undefined);
}

/**
 * Open the GitHub account dialog. With `start`, the dialog begins sign-in at once (browser or code, as offered), which
 * asks for the new scopes. HomePage listens.
 */
export const GITHUB_SIGN_IN_EVENT = 'gnosis-github-sign-in';
export interface GitHubSignInRequest {
  start?: boolean;
}
export const requestGitHubSignIn = (detail: GitHubSignInRequest = {}) =>
  window.dispatchEvent(new CustomEvent<GitHubSignInRequest>(GITHUB_SIGN_IN_EVENT, { detail }));
/** "Sign in again" outside the dialog: one click starts the same sign-in the dialog's button does. */
export const startGitHubSignIn = () => requestGitHubSignIn({ start: true });
