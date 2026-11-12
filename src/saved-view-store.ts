import { createHash, randomUUID } from 'node:crypto';
import type { StateStorage } from './app-data-store';
import {
  normalizeViews,
  applyViewAction,
  editViewFilters,
  type QueueViewAction,
  type QueueViewsState,
} from '../lib/saved-views';

export const queueViewsName = (account: string) =>
  `queue-views:${createHash('sha256').update(account.toLowerCase()).digest('hex')}`;
export function createSavedViewStore(storage: StateStorage) {
  const states = new Map<string, QueueViewsState>();
  const load = (account: string, fallback?: unknown) => {
    const key = account.toLowerCase();
    let state = states.get(key);
    if (!state) {
      state = normalizeViews(storage.take(queueViewsName(account)), fallback);
      states.set(key, state);
    }
    return state;
  };
  const save = (account: string, next: QueueViewsState) => {
    storage.write(queueViewsName(account), next);
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
