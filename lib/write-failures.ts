import { useSyncExternalStore } from 'react';
import { failureTitle, type OptimisticAction } from './optimistic-patches';

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
}
const failures = new Map<string, WriteFailure>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

/** GitHub's reason without Electron's IPC wrapper. */
export function writeErrorDetail(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (
    text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').trim() ||
    'GitHub did not accept the change.'
  );
}
export function reportWriteFailure(input: Omit<WriteFailure, 'title' | 'detail'> & { error: unknown; title?: string }) {
  const { error, title, ...rest } = input;
  failures.set(input.key, { ...rest, title: title ?? failureTitle(input.action), detail: writeErrorDetail(error) });
  emit();
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
  clearWriteFailure(input.key);
  input.clear?.();
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
  }
}
