import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, PanelLeftClose, Search, X } from 'lucide-react';
import { checkGroupIcons } from '../lib/interface-icons';
import type { WorkflowRunInfo } from '../lib/workflow-graph';
import type { PrChecks } from '../lib/pr-checks';
import type { CiCheck } from '../lib/types';
import { checkCounts, checkGroup, checkLabel, checkSummary } from '../lib/pr-checks';
import { workflowJobCount } from '../lib/workflow-navigation';
import { attentionSourceSummary, workflowSidebarEntries, type ExternalCheckGroup } from '../lib/workflow-external';
import { Button } from './ui/button';

export function WorkflowSidebar({
  id,
  runs,
  external,
  selected,
  selectedExternal,
  pending,
  snapshot,
  counts,
  open,
  focusRequest,
  onSelect,
  onSelectExternal,
  onClose,
}: {
  id: string;
  runs: WorkflowRunInfo[];
  /** Checks the graph cannot draw, per provider; they count toward the Checks tab like any other. */
  external: ExternalCheckGroup[];
  selected?: number;
  selectedExternal?: string;
  pending?: number;
  snapshot?: PrChecks;
  counts: Record<string, number>;
  open: boolean;
  focusRequest: number;
  onSelect: (id: number) => void;
  onSelectExternal: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const previousFocusRequest = useRef(focusRequest);
  useEffect(() => {
    if (open && focusRequest !== previousFocusRequest.current) search.current?.focus();
    previousFocusRequest.current = focusRequest;
  }, [open, focusRequest]);
  const needle = query.trim().toLowerCase();
  const entries = workflowSidebarEntries(runs, external);
  const filtered = entries.filter((entry) =>
    (entry.kind === 'run'
      ? `${entry.run.name} ${entry.run.path} ${entry.run.event ?? ''}`
      : `${entry.name} ${entry.group.checks.map((c) => c.name).join(' ')}`
    )
      .toLowerCase()
      .includes(needle)
  );
  const totals = snapshot && checkCounts(snapshot.checks);
  const summaryGroup = totals?.attention
    ? 'attention'
    : totals?.running
      ? 'running'
      : totals?.passed
        ? 'passed'
        : 'skipped';
  const SummaryIcon = checkGroupIcons[summaryGroup];
  const attentionSource = totals?.attention ? attentionSourceSummary(external, totals.attention) : '';
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
          Workflows <span>{entries.length}</span>
        </h2>
        <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Hide workflows">
          <PanelLeftClose size={16} />
        </Button>
      </div>
      {snapshot && !!snapshot.checks.length && (
        <p className="workflow-sidebar-summary" role="status">
          <SummaryIcon size={14} className={`check-${summaryGroup}`} aria-hidden="true" />
          <span>
            <span className={`check-${summaryGroup}`}>{checkSummary(snapshot.checks)}</span>
            {attentionSource && <span className="workflow-sidebar-summary-detail">{attentionSource}</span>}
          </span>
        </p>
      )}
      <div className="workflow-sidebar-search">
        <Search size={14} aria-hidden="true" />
        <input
          ref={search}
          type="search"
          aria-label="Find workflow"
          placeholder="Find workflow or check…"
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
        {filtered.map((entry) => {
          if (entry.kind === 'external') {
            const group = entry.group;
            const Icon = checkGroupIcons[group.outcome];
            return (
              <button
                type="button"
                key={entry.id}
                className="workflow-run-option"
                data-external={group.source}
                aria-current={entry.id === selectedExternal ? 'true' : undefined}
                onClick={() => onSelectExternal(entry.id)}
                title={`${group.name}\n${group.source === 'external' ? 'Reported outside GitHub Actions' : 'Jobs from workflow runs that are not listed'}\n${group.label}`}
              >
                <Icon size={16} className={`check-${group.outcome}`} aria-hidden="true" />
                <span className="workflow-run-text">
                  <strong>{group.name}</strong>
                  <span className="workflow-run-event">
                    {group.source === 'external' ? 'External checks' : 'Not in a listed workflow'}
                  </span>
                  <span className="workflow-run-meta">
                    <span className={`check-${group.outcome}`}>{group.label}</span>
                    <span>
                      {group.checks.length} {group.checks.length === 1 ? 'check' : 'checks'}
                    </span>
                  </span>
                </span>
              </button>
            );
          }
          const run = entry.run;
          const state: CiCheck = {
            ...run,
            status: run.status === 'completed' ? 'completed' : run.status === 'in_progress' ? 'in_progress' : 'queued',
          };
          const group = checkGroup(state),
            label = checkLabel(state);
          const Icon = checkGroupIcons[group];
          const count = workflowJobCount(run, snapshot, counts[`${run.id}:${run.attempt}`] ?? run.jobCount);
          const duplicate = runs.some((other) => other.id !== run.id && other.name === run.name);
          return (
            <button
              type="button"
              key={run.id}
              className="workflow-run-option"
              aria-busy={run.id === pending || undefined}
              aria-current={run.id === selected && !selectedExternal ? 'true' : undefined}
              onClick={() => onSelect(run.id)}
              title={`${run.name}\n${run.path}${run.event ? ` · ${run.event}` : ''}\nAttempt ${run.attempt}`}
            >
              {run.id === pending ? (
                <LoaderCircle size={16} className="animate-spin" aria-label="Opening workflow" />
              ) : (
                <Icon size={16} className={`check-${group}`} aria-hidden="true" />
              )}
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
                  {!!run.supersededRuns && (
                    <span
                      className="workflow-run-superseded"
                      title={`${run.supersededRuns} earlier ${run.supersededRuns === 1 ? 'run' : 'runs'} of this workflow on this commit ${run.supersededRuns === 1 ? 'was' : 'were'} replaced by this run. Like on GitHub, their jobs do not count.`}
                    >
                      {run.supersededRuns} earlier {run.supersededRuns === 1 ? 'run' : 'runs'}
                    </span>
                  )}
                </span>
              </span>
            </button>
          );
        })}
        {!filtered.length && (
          <p className="workflow-sidebar-empty">
            {entries.length ? 'No matching workflows or checks.' : 'No workflows reported.'}
          </p>
        )}
      </nav>
    </aside>
  );
}
