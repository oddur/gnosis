import { Popover } from 'radix-ui';
import { SlidersHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import type { WorkflowGrouping } from '../lib/workflow-graph';
import { Button } from './ui/button';
export function WorkflowViewMenu({
  grouping,
  onGrouping,
  showSkipped,
  onSkipped,
  showCompleted,
  onCompleted,
  grouped,
  children,
}: {
  grouping: WorkflowGrouping;
  onGrouping: (mode: WorkflowGrouping) => void;
  showSkipped: boolean;
  onSkipped: (value: boolean) => void;
  showCompleted: boolean;
  onCompleted: (value: boolean) => void;
  grouped: number;
  children?: ReactNode;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="outline" size="sm" aria-label="Graph view options">
          <SlidersHorizontal size={14} /> View
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="workflow-view-menu"
          sideOffset={6}
          align="end"
          collisionPadding={12}
          aria-label="Graph view options"
        >
          <fieldset className="workflow-visibility">
            <legend>Visible jobs</legend>
            <label>
              <input type="checkbox" checked={showSkipped} onChange={(e) => onSkipped(e.target.checked)} />
              Show skipped
            </label>
            <label>
              <input type="checkbox" checked={showCompleted} onChange={(e) => onCompleted(e.target.checked)} />
              Show passed and neutral
            </label>
            <p>Failed, cancelled, and active jobs stay visible. Hidden jobs retain a compact summary.</p>
          </fieldset>
          <fieldset className="workflow-grouping">
            <legend>Parallel jobs</legend>
            {(
              [
                ['adaptive', 'Adaptive', 'Group large sets of finished jobs only when the graph is crowded.'],
                ['compact', 'Compact', 'Group three or more finished jobs with the same dependencies.'],
                ['off', 'Off', 'Show parallel jobs separately.'],
              ] as const
            ).map(([value, label, description]) => (
              <label key={value}>
                <input
                  type="radio"
                  name="workflow-grouping"
                  value={value}
                  checked={grouping === value}
                  onChange={() => onGrouping(value)}
                />
                <span>
                  <strong>{label}</strong>
                  <small>{description}</small>
                </span>
              </label>
            ))}
            <p>Matrix and reusable-workflow groups expand separately in every mode.</p>
            <p role="status">
              {grouped
                ? `${grouped} finished jobs grouped in this view.`
                : 'No finished parallel jobs grouped in this view.'}
            </p>
          </fieldset>
          <details>
            <summary>Keyboard and graph help</summary>
            <p>
              Tab to a job, then press Enter to open it. Escape in details returns to the job. Groups expand with Enter.
              Show related jobs keeps its prerequisites and dependants.
            </p>
            <p>Arrows follow workflow prerequisites. Pan to explore, or use Fit entire workflow to see its shape.</p>
          </details>
          <div className="workflow-view-metadata">{children}</div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
