import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  normalizeViews,
  applyViewAction,
  editViewFilters,
  type QueueViewAction,
  type QueueViewsState,
} from '../lib/saved-views';

export function createSavedViewStore(directory: () => string) {
  const states = new Map<string, QueueViewsState>();
  const file = (account: string) =>
    path.join(directory(), `queue-views-${createHash('sha256').update(account.toLowerCase()).digest('hex')}.json`);
  const load = (account: string, fallback?: unknown) => {
    const key = account.toLowerCase();
    let state = states.get(key);
    if (!state) {
      let saved: unknown;
      try {
        saved = JSON.parse(fs.readFileSync(file(account), 'utf8'));
      } catch {
        /* First use or unreadable file. */
      }
      state = normalizeViews(saved, fallback);
      states.set(key, state);
    }
    return state;
  };
  const save = (account: string, next: QueueViewsState) => {
    fs.mkdirSync(directory(), { recursive: true });
    fs.writeFileSync(file(account) + '.tmp', JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(file(account) + '.tmp', file(account));
    states.set(account.toLowerCase(), next);
    return next;
  };
  return {
    load,
    replace: (account: string, next: QueueViewsState) => save(account, normalizeViews(next)),
    edit(account: string, filters: unknown) {
      return save(account, editViewFilters(load(account), filters));
    },
    act(account: string, action: QueueViewAction) {
      return save(account, applyViewAction(load(account), action, randomUUID));
    },
  };
}
