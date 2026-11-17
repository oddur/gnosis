import { createByteCache } from './byte-cache';
import { RENDERER_STACK_BYTES, RENDERER_STACK_ENTRIES } from './inspection-limits';
import { stackRevisionKey } from './stack-changes';
import type { ReviewSubject } from './workbench';
import type { PrChanges } from './pr-changes';

const values = createByteCache<string, PrChanges>(RENDERER_STACK_BYTES, RENDERER_STACK_ENTRIES);
let epoch = 0;
const key = (account: string, subject: ReviewSubject) => `${account}:${stackRevisionKey(subject)}`;
export const peekStackChanges = (account: string, subject: ReviewSubject) => values.get(key(account, subject));
export const stackCacheStats = () => ({ entries: values.size, bytes: values.bytes });
/** Drops stack comparisons that include any of these PRs. */
export function forgetStackChanges(urls: ReadonlySet<string>) {
  values.prune((snapshot) => !!snapshot.stackComparison?.members.some((member) => urls.has(member.metadata.url)));
}
/** The last use of each PR in a stack comparison, merged into `into` (the latest wins). */
export function stackLastUses(into: Map<string, number>) {
  for (const [snapshot, at] of values.uses())
    for (const member of snapshot.stackComparison?.members ?? [])
      if ((into.get(member.metadata.url) ?? -Infinity) < at) into.set(member.metadata.url, at);
}
export function clearStackChanges() {
  epoch++;
  values.clear();
}
export async function readStackChanges(
  account: string,
  subject: ReviewSubject,
  refresh: boolean,
  background: boolean,
  signal: AbortSignal
) {
  signal.throwIfAborted();
  const saved = !refresh && peekStackChanges(account, subject);
  if (saved) return saved;
  const generation = epoch;
  const requestId = crypto.randomUUID();
  const abort = () => {
    void window.electronAPI.cancelInspection(requestId).catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const snapshot = await window.electronAPI.getStackChanges(subject, refresh, { requestId, background });
    signal.throwIfAborted();
    const comparison = snapshot.stackComparison;
    if (generation === epoch && comparison) {
      const current = {
        ...subject,
        members: subject.members.map((m) => ({
          ...m,
          ...comparison.members.find((s) => s.metadata.url === m.url)?.metadata,
        })),
      };
      values.set(key(account, current), snapshot);
    }
    return snapshot;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
