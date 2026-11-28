import { useSyncExternalStore } from 'react';

/**
 * The guided session (#596) as the rest of the app sees it, so a PR opened from a session can show where it is in the
 * run and offer the next PR (components/SessionBar.tsx). The Overview owns the session and publishes it here; a PR
 * page asks for the way back or on, and the Overview answers. Pure state, no persistence: a session lasts while the
 * app runs.
 */
export interface SessionBarStep {
  id: string;
  url: string;
  number: number;
  title: string;
  /** Next up's reason for the step: "approved by lena", "updated since your review". */
  why: string;
}
export interface SessionBarState {
  steps: readonly SessionBarStep[];
  index: number;
  /** PRs finished where they were opened: a review submitted, or every change viewed. */
  finished: ReadonlySet<string>;
}
export type SessionRequest = 'back' | 'next';

let state: SessionBarState | null = null;
const listeners = new Set<() => void>();
let answer: ((request: SessionRequest, url: string) => void) | undefined;
const notify = () => listeners.forEach((listener) => listener());

/** The Overview's session, or null when none runs. What was finished stays while the same PRs are in the run. */
export function publishSession(next: Omit<SessionBarState, 'finished'> | null) {
  if (!next) {
    if (state === null) return;
    state = null;
  } else {
    const urls = new Set(next.steps.map((step) => step.url));
    const finished = new Set([...(state?.finished ?? [])].filter((url) => urls.has(url)));
    state = { ...next, finished };
  }
  notify();
}
/** A PR of the session was finished where it was opened. Other PRs are not the session's business. */
export function markSessionFinished(url: string) {
  if (!state || state.finished.has(url) || !state.steps.some((step) => step.url === url)) return;
  state = { ...state, finished: new Set([...state.finished, url]) };
  notify();
}
/** The Overview's answer to a PR page's Back or Next, while it is mounted. The latest Overview to mount owns it. */
export function answerSessionRequests(handler: (request: SessionRequest, url: string) => void): () => void {
  answer = handler;
  return () => {
    if (answer === handler) answer = undefined;
  };
}
let waiting: { request: SessionRequest; url: string } | undefined;
/**
 * Back or Next from a PR page. The Overview may not be mounted while another tab is in front: then the request waits
 * here, and the Overview takes it as it mounts (`takeSessionRequest`).
 */
export function requestSession(request: SessionRequest, url: string) {
  if (answer) answer(request, url);
  else waiting = { request, url };
}
/** The request that came while no Overview was mounted, once. */
export function takeSessionRequest() {
  const value = waiting;
  waiting = undefined;
  return value;
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const useSessionState = () => useSyncExternalStore(subscribe, () => state);
export const peekSessionState = () => state;
