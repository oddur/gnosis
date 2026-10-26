import { useState } from 'react';
import { Popover } from 'radix-ui';
import { EntryActions } from './EntryActions';
import { Bookmark, GripVertical, X } from 'lucide-react';
import { viewIsModified, type QueueViewAction, type QueueViewsSnapshot, type SavedQueueView } from '../lib/saved-views';
import type { QueueFilters } from '../lib/queue-filters';

type Action = (action: QueueViewAction) => Promise<void>;
function ViewNameForm({
  initial = '',
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="view-name-form"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError('');
        void onSubmit(name)
          .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)))
          .finally(() => setBusy(false));
      }}
    >
      <label>
        View name
        <input
          autoFocus
          required
          maxLength={60}
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <div>
        <button type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Saving…' : submitLabel}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
export function SavedViewsNav({
  state,
  active,
  busy,
  onAction,
}: {
  state: QueueViewsSnapshot;
  active: boolean;
  busy: boolean;
  onAction: Action;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const act = (action: QueueViewAction) => {
    void onAction(action).catch(() => {});
  };
  return (
    <section className="saved-views-nav" aria-label="Saved views">
      <p className="workbench-nav-heading">Saved views</p>
      {!state.views.length && <p className="saved-views-empty">Choose “Save view…” to reuse your filters and sort order.</p>}
      {state.views.map((view, index) => (
        <Popover.Root
          key={view.id}
          open={renaming === view.id}
          onOpenChange={(open) => {
            if (!open) setRenaming(null);
          }}
        >
          <EntryActions
            label={`Manage ${view.name}`}
            buttonClassName="saved-view-menu-trigger"
            restoreFocus={renaming !== view.id}
            groups={[
              [
                { label: 'Rename', disabled: busy, run: () => setRenaming(view.id) },
                { label: 'Duplicate', disabled: busy, run: () => onAction({ type: 'duplicate', id: view.id }) },
                {
                  label: 'Move up',
                  disabled: busy || index === 0,
                  run: () => onAction({ type: 'move', id: view.id, beforeId: state.views[index - 1].id }),
                },
                {
                  label: 'Move down',
                  disabled: busy || index === state.views.length - 1,
                  run: () => onAction({ type: 'move', id: view.id, beforeId: state.views[index + 2]?.id ?? null }),
                },
              ],
              [
                {
                  label: 'Delete view',
                  destructive: true,
                  disabled: busy,
                  run: () => onAction({ type: 'delete', id: view.id }),
                },
              ],
            ]}
          >
            {(actions) => (
              <div
                className={`saved-view-row${dragging === view.id ? ' dragging' : ''}`}
                onDragOver={(event) => {
                  if (dragging && !busy) event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragging && !busy) act({ type: 'move', id: dragging, beforeId: view.id });
                  setDragging(null);
                }}
              >
                <button
                  className="saved-view-drag"
                  draggable={!busy}
                  aria-label={`Drag ${view.name} to reorder`}
                  title="Drag to reorder; the view menu also has Move up and Move down"
                  disabled={busy}
                  onDragStart={(event) => {
                    event.dataTransfer.setData('text/plain', view.id);
                    event.dataTransfer.effectAllowed = 'move';
                    setDragging(view.id);
                  }}
                  onDragEnd={() => setDragging(null)}
                >
                  <GripVertical size={12} />
                </button>
                <button
                  className={`saved-view-link${active && state.activeId === view.id ? ' active' : ''}`}
                  aria-current={active && state.activeId === view.id ? 'page' : undefined}
                  title={`${view.name} — ${state.counts[view.id] ?? 0} PRs and stacks matching the saved filters, using cached GitHub data`}
                  disabled={busy}
                  onClick={() => act({ type: 'activate', id: view.id })}
                >
                  <Bookmark size={15} />
                  <span className="saved-view-name">{view.name}</span>
                  <span className="saved-view-count">{state.counts[view.id] ?? 0}</span>
                </button>
                <Popover.Anchor asChild>
                  <span className="saved-view-actions">{actions}</span>
                </Popover.Anchor>
              </div>
            )}
          </EntryActions>
          <Popover.Portal>
            <Popover.Content
              className="save-view-popover"
              side="right"
              align="start"
              sideOffset={8}
              collisionPadding={16}
              aria-label="Rename saved view"
            >
              <div className="save-view-heading">
                <strong>Rename view</strong>
                <Popover.Close aria-label="Close rename view">
                  <X size={16} />
                </Popover.Close>
              </div>
              <ViewNameForm
                initial={view.name}
                submitLabel="Rename"
                onCancel={() => setRenaming(null)}
                onSubmit={async (name) => {
                  await onAction({ type: 'rename', id: view.id, name });
                  setRenaming(null);
                }}
              />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      ))}
      {dragging && (
        <div
          className="saved-view-drop-end"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            if (!busy) act({ type: 'move', id: dragging, beforeId: null });
            setDragging(null);
          }}
        >
          Move to end
        </div>
      )}
    </section>
  );
}
export function SaveViewControls({
  view,
  filters,
  busy,
  onAction,
}: {
  view?: SavedQueueView;
  filters: QueueFilters;
  busy: boolean;
  onAction: Action;
}) {
  const [open, setOpen] = useState(false);
  const modified = view && viewIsModified(view, filters);
  return (
    <div className="save-view-controls">
      {modified && (
        <>
          <span
            className="view-modified"
            role="status"
            title="The filters or sort order differ from the saved view. Save changes to update it, or restore the saved view."
          >
            {JSON.stringify(view.filters.sort) !== JSON.stringify(filters.sort) ? 'View changed' : 'Filters changed'}
          </span>
          <button
            disabled={busy}
            onClick={() => {
              void onAction({ type: 'update', id: view.id }).catch(() => {});
            }}
          >
            Save changes
          </button>
          <button
            disabled={busy}
            onClick={() => {
              void onAction({ type: 'reset', id: view.id }).catch(() => {});
            }}
          >
            Restore saved filters
          </button>
        </>
      )}
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button disabled={busy}>{view ? 'Save as new view…' : 'Save view…'}</button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className="save-view-popover"
            sideOffset={8}
            collisionPadding={16}
            align="start"
            aria-label="Save queue view"
          >
            <div className="save-view-heading">
              <strong>{view ? 'Save as new view' : 'Save view'}</strong>
              <Popover.Close aria-label="Close save view">
                <X size={16} />
              </Popover.Close>
            </div>
            <p className="queue-filter-hint">
              Saves filters and briefing scope on this computer. Uses the shared GitHub cache.
            </p>
            <ViewNameForm
              submitLabel="Save view"
              onCancel={() => setOpen(false)}
              onSubmit={async (name) => {
                await onAction({ type: 'create', name });
                setOpen(false);
              }}
            />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
