import { useEffect, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, CircleMinus, Clock3, PanelLeftClose, Search, X } from 'lucide-react';
import type { WorkflowRunInfo } from '../lib/workflow-graph';
import type { PrChecks } from '../lib/pr-checks';
import type { CiCheck } from '../lib/types';
import { checkGroup, checkLabel } from '../lib/pr-checks';
import { workflowJobCount } from '../lib/workflow-navigation';
import { Button } from './ui/button';

export function WorkflowSidebar({
  id,
  runs,
  selected,
  snapshot,
  counts,
  open,
  focusRequest,
  onSelect,
  onClose,
}: {
  id: string;
  runs: WorkflowRunInfo[];
  selected?: number;
  snapshot?: PrChecks;
  counts: Record<string, number>;
  open: boolean;
  focusRequest: number;
  onSelect: (id: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const previousFocusRequest = useRef(focusRequest);
  useEffect(() => {
    if (open && focusRequest !== previousFocusRequest.current) search.current?.focus();
    previousFocusRequest.current = focusRequest;
  }, [open, focusRequest]);
  const ordered = [...runs].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.id - b.id);
  const filtered = ordered.filter((run) =>
    `${run.name} ${run.path} ${run.event ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())
  );
  return (
    <aside
      id={id}
      className="workflow-sidebar"
      hidden={!open}
      aria-label="Workflows"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="workflow-sidebar-heading">
        <h2>
          Workflows <span>{runs.length}</span>
        </h2>
        <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Hide workflows">
          <PanelLeftClose size={16} />
        </Button>
      </div>
      <div className="workflow-sidebar-search">
        <Search size={14} aria-hidden="true" />
        <input
          ref={search}
          type="search"
          aria-label="Find workflow"
          placeholder="Find workflow…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Clear workflow search"
            onClick={() => {
              setQuery('');
              search.current?.focus();
            }}
          >
            <X size={14} />
          </Button>
        )}
      </div>
      <nav
        aria-label="Workflow runs"
        onKeyDown={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.workflow-run-option')];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
          event.preventDefault();
          buttons[next]?.focus();
        }}
      >
        {filtered.map((run) => {
          const state: CiCheck = {
            ...run,
            status: run.status === 'completed' ? 'completed' : run.status === 'in_progress' ? 'in_progress' : 'queued',
          };
          const group = checkGroup(state),
            label = checkLabel(state);
          const Icon =
            group === 'attention'
              ? CircleAlert
              : group === 'passed'
                ? CircleCheck
                : group === 'running'
                  ? Clock3
                  : CircleMinus;
          const count = workflowJobCount(run, snapshot, counts[`${run.id}:${run.attempt}`] ?? run.jobCount);
          const duplicate = runs.some((other) => other.id !== run.id && other.name === run.name);
          return (
            <button
              type="button"
              key={run.id}
              className="workflow-run-option"
              aria-current={run.id === selected ? 'true' : undefined}
              onClick={() => onSelect(run.id)}
              title={`${run.name}\n${run.path}${run.event ? ` · ${run.event}` : ''}\nAttempt ${run.attempt}`}
            >
              <Icon size={16} className={`check-${group}`} aria-hidden="true" />
              <span className="workflow-run-text">
                <strong>{run.name}</strong>
                {duplicate && (
                  <span className="workflow-run-event">
                    {run.path.replace('.github/workflows/', '')}
                    {run.event ? ` · ${run.event.replaceAll('_', ' ')}` : ''}
                  </span>
                )}
                <span className="workflow-run-meta">
                  <span className={`check-${group}`}>{label}</span>
                  <span
                    title={
                      count
                        ? count.exact
                          ? 'Total jobs reported by GitHub for this attempt'
                          : 'Jobs reported so far; the total is not available yet'
                        : 'Job count is not available yet'
                    }
                  >
                    {count
                      ? `${count.count}${count.exact ? '' : '+'} ${count.count === 1 && count.exact ? 'job' : 'jobs'}`
                      : 'Jobs: —'}
                  </span>
                  {run.attempt > 1 && <span>Attempt {run.attempt}</span>}
                </span>
              </span>
            </button>
          );
        })}
        {!filtered.length && (
          <p className="workflow-sidebar-empty">{runs.length ? 'No matching workflows.' : 'No workflows reported.'}</p>
        )}
      </nav>
    </aside>
  );
}
