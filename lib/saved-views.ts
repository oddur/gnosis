import { normalizeQueueFilters, type QueueFilters } from './queue-filters';

export interface SavedQueueView {
  id: string;
  name: string;
  filters: QueueFilters;
  draft: QueueFilters;
}
export interface QueueViewsState {
  views: SavedQueueView[];
  activeId: string | null;
  queueDraft: QueueFilters;
}
export type QueueViewAction =
  | { type: 'create'; name: string }
  | { type: 'activate'; id: string | null; filters?: Partial<QueueFilters> }
  | { type: 'update' | 'reset' | 'delete' | 'duplicate'; id: string }
  | { type: 'rename'; id: string; name: string }
  | { type: 'move'; id: string; beforeId: string | null };
export interface QueueViewsSnapshot extends QueueViewsState {
  counts: Record<string, number>;
}
export function normalizeViews(value: unknown, fallback?: unknown): QueueViewsState {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const ids = new Set<string>(),
    names = new Set<string>();
  const views = (Array.isArray(raw.views) ? raw.views : [])
    .flatMap((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return [];
      const view = entry as Record<string, unknown>;
      if (typeof view.id !== 'string' || typeof view.name !== 'string') return [];
      const name = view.name.trim().slice(0, 60);
      if (!name || ids.has(view.id) || names.has(name.toLowerCase())) return [];
      ids.add(view.id);
      names.add(name.toLowerCase());
      return [
        {
          id: view.id,
          name,
          filters: normalizeQueueFilters(view.filters),
          draft: normalizeQueueFilters(view.draft ?? view.filters),
        },
      ];
    })
    .slice(0, 100);
  return {
    views,
    activeId: typeof raw.activeId === 'string' && views.some((view) => view.id === raw.activeId) ? raw.activeId : null,
    queueDraft: normalizeQueueFilters(raw.queueDraft ?? fallback),
  };
}
export function activeViewFilters(state: QueueViewsState): QueueFilters {
  return state.views.find((view) => view.id === state.activeId)?.draft ?? state.queueDraft;
}
export function viewIsModified(view: SavedQueueView, draft = view.draft): boolean {
  return JSON.stringify(normalizeQueueFilters(view.filters)) !== JSON.stringify(normalizeQueueFilters(draft));
}
export function editViewFilters(state: QueueViewsState, filters: unknown): QueueViewsState {
  const next = structuredClone(state),
    normalized = normalizeQueueFilters(filters);
  const active = next.views.find((view) => view.id === next.activeId);
  if (active) active.draft = normalized;
  else next.queueDraft = normalized;
  return next;
}
/** Pure local transitions: view management never fetches GitHub or generates a briefing. */
export function applyViewAction(state: QueueViewsState, action: QueueViewAction, newId: () => string): QueueViewsState {
  const next = structuredClone(state);
  const find = (id: string) => {
    const view = next.views.find((view) => view.id === id);
    if (!view) throw new Error('This saved view no longer exists.');
    return view;
  };
  const name = (value: string, id?: string) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Enter a name for this view.');
    if (value.trim().length > 60) throw new Error('Use a name with 60 characters or fewer.');
    if (next.views.some((view) => view.id !== id && view.name.toLowerCase() === value.trim().toLowerCase()))
      throw new Error('A view already has that name. Choose another name.');
    return value.trim();
  };
  const create = (label: string, filters: QueueFilters) => {
    if (next.views.length >= 100) throw new Error('You can save up to 100 views. Delete a view before adding another.');
    const view = { id: newId(), name: name(label), filters: structuredClone(filters), draft: structuredClone(filters) };
    next.views.push(view);
    next.activeId = view.id;
  };
  switch (action.type) {
    case 'create':
      create(action.name, activeViewFilters(next));
      break;
    case 'activate':
      if (action.id !== null) find(action.id);
      next.activeId = action.id;
      if (action.id === null && action.filters)
        next.queueDraft = normalizeQueueFilters({ ...next.queueDraft, ...action.filters });
      break;
    case 'update': {
      const view = find(action.id);
      view.filters = structuredClone(view.draft);
      break;
    }
    case 'reset': {
      const view = find(action.id);
      view.draft = structuredClone(view.filters);
      break;
    }
    case 'rename':
      find(action.id).name = name(action.name, action.id);
      break;
    case 'delete':
      find(action.id);
      next.views = next.views.filter((view) => view.id !== action.id);
      if (next.activeId === action.id) next.activeId = null;
      break;
    case 'duplicate': {
      const view = find(action.id),
        base = view.name.slice(0, 48);
      let label = `${base} copy`,
        suffix = 2;
      while (next.views.some((view) => view.name.toLowerCase() === label.toLowerCase()))
        label = `${base} copy ${suffix++}`;
      create(label, view.filters);
      break;
    }
    case 'move': {
      const view = find(action.id);
      if (action.beforeId === action.id) break;
      if (action.beforeId !== null) find(action.beforeId);
      next.views = next.views.filter((view) => view.id !== action.id);
      const index =
        action.beforeId === null ? next.views.length : next.views.findIndex((view) => view.id === action.beforeId);
      next.views.splice(index, 0, view);
      break;
    }
    default:
      throw new Error('Unknown saved-view action.');
  }
  return next;
}
