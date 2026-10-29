import { createByteCache } from './byte-cache';
import { INVENTORY_MEMORY_BYTES } from './inspection-limits';
import { stackRevisionKey } from './stack-changes';
import type { ReviewSubject } from './workbench';
import type { PrChanges } from './pr-changes';

const values = createByteCache<string, PrChanges>(INVENTORY_MEMORY_BYTES, 50);
let epoch = 0;
const key = (account: string, subject: ReviewSubject) => `${account}:${stackRevisionKey(subject)}`;
export const peekStackChanges = (account: string, subject: ReviewSubject) => values.get(key(account, subject));
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
