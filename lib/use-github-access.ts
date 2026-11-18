import { useSyncExternalStore } from 'react';
import { parseDismissedScopes, serializeDismissedScopes, type GitHubAccess } from './github-access';

/**
 * The signed-in account and the scopes GitHub reports for its token, shared by every component in this window. Read
 * once from `getAuthState`, then kept current by main's `github-access-changed` broadcasts.
 */
let access: GitHubAccess | undefined;
let started = false;
const listeners = new Set<() => void>();
const emit = (next: GitHubAccess) => {
  if (
    access &&
    access.login === next.login &&
    access.tokenKind === next.tokenKind &&
    JSON.stringify(access.scopes) === JSON.stringify(next.scopes)
  )
    return;
  access = next;
  for (const listener of listeners) listener();
};

/** Read the account and scopes again, after signing in or out. */
export function refreshGitHubAccess(): Promise<void> {
  const api = typeof window === 'undefined' ? undefined : window.electronAPI;
  if (!api?.getAuthState) return Promise.resolve();
  return api
    .getAuthState()
    .then((auth) =>
      emit({
        login: auth.authenticated ? auth.login : null,
        scopes: auth.authenticated ? auth.scopes : undefined,
        tokenKind: auth.authenticated ? auth.tokenKind : undefined,
      })
    )
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
  /** Open on the personal access token form, to replace a token that lacks scopes. */
  token?: boolean;
}
export const requestGitHubSignIn = (detail: GitHubSignInRequest = {}) =>
  window.dispatchEvent(new CustomEvent<GitHubSignInRequest>(GITHUB_SIGN_IN_EVENT, { detail }));
/** "Sign in again" outside the dialog: one click starts the same sign-in the dialog's button does. */
export const startGitHubSignIn = () => requestGitHubSignIn({ start: true });
/** "Sign in with it" after creating a new token: the dialog opens on the token form. */
export const startGitHubTokenSignIn = () => requestGitHubSignIn({ token: true });

/**
 * "Not now" on the sign-in prompt and the team-request notes, per account: the scopes missing when it was dismissed
 * (see `parseDismissedScopes`). The GitHub account dialog's prompt uses the bare key; each note adds its surface.
 */
export const scopePromptKey = (login: string, surface?: string) =>
  `gnosis:github-scope-prompt-dismissed:${login}${surface ? `:${surface}` : ''}`;
const dismissalListeners = new Set<() => void>();
const dismissalVersion = { value: 0 };
const sessionDismissals = new Map<string, string[]>();
export function readScopeDismissal(login: string | null | undefined, surface?: string): string[] {
  if (!login) return [];
  try {
    return parseDismissedScopes(localStorage.getItem(scopePromptKey(login, surface)));
  } catch {
    return [];
  }
}
export function dismissScopes(login: string | null | undefined, missing: readonly string[], surface?: string) {
  if (!login) return;
  try {
    localStorage.setItem(scopePromptKey(login, surface), serializeDismissedScopes(missing));
  } catch {
    /* Storage unavailable: hidden until the window reloads. */
    sessionDismissals.set(scopePromptKey(login, surface), [...missing]);
  }
  dismissalVersion.value++;
  for (const listener of dismissalListeners) listener();
}
/** The dismissed scopes for this account and surface, kept current when any surface dismisses. */
export function useScopeDismissal(login: string | null | undefined, surface?: string): string[] {
  useSyncExternalStore(
    (listener) => {
      dismissalListeners.add(listener);
      return () => void dismissalListeners.delete(listener);
    },
    () => dismissalVersion.value,
    () => 0
  );
  if (!login) return [];
  return sessionDismissals.get(scopePromptKey(login, surface)) ?? readScopeDismissal(login, surface);
}
