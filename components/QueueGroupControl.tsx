import { useId, useState } from 'react';
import { Rows3 } from 'lucide-react';
import { Popover } from 'radix-ui';
import { QUEUE_GROUP_BY, QUEUE_GROUP_BY_LABEL, type QueueGroupBy } from '../lib/queue-groups';

const HINT: Readonly<Record<QueueGroupBy, string>> = {
  none: 'One list, in sort order.',
  action: 'Answer, Review, Merge, Fix, Waiting on others, Parked, then Other, as on the Overview.',
  repository: 'Repositories in alphabetical order.',
};

/** "Group by" beside the sort control: None, Action or Repository. The sort applies within each group. */
export function QueueGroupControl({ value, onChange, disabled = false }: { value: QueueGroupBy; onChange: (value: QueueGroupBy) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const name = useId();
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className="queue-filter-toggle" disabled={disabled} aria-label={`Group by: ${QUEUE_GROUP_BY_LABEL[value]}`} data-queue-group-by={value}>
          <Rows3 size={14} aria-hidden="true" />
          {value === 'none' ? 'Group' : QUEUE_GROUP_BY_LABEL[value]}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="queue-filter-popover queue-group-popover" align="end" sideOffset={8} collisionPadding={16} aria-label="Group PRs">
          <fieldset className="queue-group-options">
            <legend>Group by</legend>
            {QUEUE_GROUP_BY.map((option) => (
              <label key={option} className="queue-group-option" data-checked={value === option ? '' : undefined}>
                <input
                  type="radio"
                  name={name}
                  value={option}
                  checked={value === option}
                  onChange={() => {
                    onChange(option);
                    setOpen(false);
                  }}
                />
                <span>
                  <span className="queue-group-option-label">{QUEUE_GROUP_BY_LABEL[option]}</span>
                  <span className="queue-group-option-hint">{HINT[option]}</span>
                </span>
              </label>
            ))}
          </fieldset>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
