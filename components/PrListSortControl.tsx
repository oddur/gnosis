import { ArrowDownWideNarrow, ArrowUpWideNarrow } from 'lucide-react';
import { Popover } from 'radix-ui';
import { SearchableSelect } from './SearchableSelect';
import { PR_SORT_LABELS, defaultSortDirection, reversibleSort, sortDirectionLabel, type PrListSort, type PrSortKey } from '../lib/pr-list-sort';

export function PrListSortControl({ value, onChange, savedReviews = false, disabled = false }: {
  value: PrListSort; onChange: (value: PrListSort) => void; savedReviews?: boolean; disabled?: boolean;
}) {
  return <Popover.Root>
    <Popover.Trigger asChild>
      <button className="queue-filter-toggle" disabled={disabled} aria-label={`Sort: ${PR_SORT_LABELS[value.key]}`}>
        <ArrowDownWideNarrow size={14} /> {PR_SORT_LABELS[value.key]}
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content className="queue-filter-popover" style={{ width: 290 }} align="end" sideOffset={8} collisionPadding={16} data-combobox-container="inside" aria-label="Sort PRs" onEscapeKeyDown={event => {
        if (event.target instanceof Element && event.target.closest('[data-slot="combobox-content"]')) event.preventDefault();
      }}>
        <div className="flex flex-col gap-3 p-4">
          <strong className="text-sm">Sort {savedReviews ? 'saved reviews' : 'PRs and stacks'}</strong>
          <SearchableSelect label="Sort by" id="pr-sort-key" value={value.key}
            options={Object.entries(PR_SORT_LABELS).filter(([key]) => savedReviews || key !== 'generated').map(([value, label]) => ({ value, label }))}
            onValueChange={key => onChange({ ...value, key: key as PrSortKey, direction: defaultSortDirection(key as PrSortKey) })} />
          {reversibleSort(value.key) && <button className="queue-filter-toggle" aria-label={`Sort direction: ${sortDirectionLabel(value)}`}
            onClick={() => onChange({ ...value, direction: value.direction === 'asc' ? 'desc' : 'asc' })}>
            {value.direction === 'asc' ? <ArrowUpWideNarrow size={14} /> : <ArrowDownWideNarrow size={14} />}
            {sortDirectionLabel(value)}
          </button>}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.starredFirst} onChange={event => onChange({ ...value, starredFirst: event.target.checked })} />Starred first</label>
          {value.key === 'status' && <p className="text-xs text-muted-foreground">Uses saved GitHub status. Unknown status appears last.</p>}
          {value.key === 'size' && <p className="text-xs text-muted-foreground">Added and removed lines. Stacks use the total across their PRs.</p>}
          <Popover.Close className="queue-filter-toggle self-end">Done</Popover.Close>
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
