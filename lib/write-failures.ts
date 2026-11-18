import { useSyncExternalStore } from 'react';
import { failureTitle, type OptimisticAction } from './optimistic-patches';
import { githubWriteError } from './github-access';

/**
 * Failed GitHub writes, kept in the renderer until the reader retries or dismisses them. Main already rolled the change
 * back. A failure outlives the view that made the write: a resolved thread that leaves a filtered list comes back
 * with its error. Keyed by target, so a newer write to it replaces the older failure.
 */
export interface WriteFailure {
  key: string;
  action: OptimisticAction;
  /** What did not happen. */
  title: string;
  /** GitHub's reason. */
  detail: string;
  /** The text the reader typed, so nothing is lost. */
  body?: string;
  retry?: () => Promise<unknown>;
  /** GitHub refused for the workflow permission: the notice offers the sign-in prompt instead of Retry. */
  workflowPermission?: boolean;
}
const failures = new Map<string, WriteFailure>();
/** Notices on screen, by failure key. A failure no notice shows is announced another way. */
const notices = new Map<string, number>();
let unseen: ((failure: WriteFailure) => void) | undefined;
/** How a failure is shown when no notice for it is on screen, such as after its file scrolled away. */
export function onUnseenWriteFailure(handler: (failure: WriteFailure) => void) {
  unseen = handler;
}
/** A notice for this key is on screen. Returns the cleanup. */
export function showingWriteFailure(key: string) {
  notices.set(key, (notices.get(key) ?? 0) + 1);
  return () => {
    const count = (notices.get(key) ?? 1) - 1;
    if (count) notices.set(key, count);
    else notices.delete(key);
  };
}
/** Targets with a write GitHub has not answered. A second write to one waits, so nothing is posted twice. */
const inFlight = new Set<string>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

/** GitHub's reason without Electron's IPC wrapper, or "Needs the workflow permission" (`githubWriteError`). */
export function writeErrorDetail(error: unknown): string {
  return githubWriteError(error).message || 'GitHub did not accept the change.';
}
export function reportWriteFailure(
  input: Omit<WriteFailure, 'title' | 'detail' | 'workflowPermission'> & { error: unknown; title?: string }
) {
  const { error, title, ...rest } = input;
  const failure: WriteFailure = {
    ...rest,
    title: title ?? failureTitle(input.action),
    detail: writeErrorDetail(error),
    ...(githubWriteError(error).workflowPermission ? { workflowPermission: true } : {}),
  };
  failures.set(input.key, failure);
  emit();
  // The view that made the write may have gone, or not come back yet after the rollback restored its composer.
  setTimeout(() => {
    if (failures.get(input.key) === failure && !notices.has(input.key)) unseen?.(failure);
  }, 400);
}
export function clearWriteFailure(key: string) {
  if (failures.delete(key)) emit();
}
export const writeFailure = (key: string) => failures.get(key);
export function subscribeWriteFailures(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export const isWriteInFlight = (key: string) => inFlight.has(key);
/** Whether a write to this target is waiting for GitHub. Survives the view remounting. */
export function useWriteInFlight(key: string): boolean {
  return useSyncExternalStore(subscribeWriteFailures, () => inFlight.has(key));
}
export function useWriteFailure(key: string | undefined): WriteFailure | undefined {
  return useSyncExternalStore(subscribeWriteFailures, () => (key ? failures.get(key) : undefined));
}

/**
 * Runs a write whose change main shows at once. The caller has already cleared its composer; on failure the
 * failure is kept with the typed text and a retry, and `restore` puts the text back where the reader typed it.
 */
export async function optimisticWrite<T>(input: {
  key: string;
  action: OptimisticAction;
  body?: string;
  write: () => Promise<T>;
  /** Empties the composer: the text now shows as the pending comment. */
  clear?: () => void;
  restore?: (body: string) => void;
}): Promise<T | undefined> {
  // The same target is already being written, for example a reply sent twice: the first one stands.
  if (inFlight.has(input.key)) return undefined;
  inFlight.add(input.key);
  clearWriteFailure(input.key);
  input.clear?.();
  emit();
  try {
    return await input.write();
  } catch (error) {
    if (input.body !== undefined) input.restore?.(input.body);
    reportWriteFailure({
      key: input.key,
      action: input.action,
      body: input.body,
      error,
      retry: () => optimisticWrite(input),
    });
    return undefined;
  } finally {
    inFlight.delete(input.key);
    emit();
  }
}
