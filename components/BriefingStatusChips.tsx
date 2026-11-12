import { memo } from 'react';
import { Settings } from 'lucide-react';
import type { BriefingCounts, BriefingPause, QueueFilters } from '../lib/queue-filters';

// Status chips with live counts follow the Filter Table pattern from Beautiful UI
// (https://www.beautifului.dev/, MIT licensed). This implementation is written for Gnosis.

const PAUSES: Record<BriefingPause, string> = {
  limit: 'daily limit',
  filter: 'filters',
  manual: 'manual only',
  waiting: 'waiting',
};
const PAUSE_DETAILS: Record<BriefingPause, string> = {
  limit: 'the daily automatic limit was reached',
  filter: 'outside your briefing filters',
  manual: 'automatic briefings are off; generate them manually',
  waiting: 'waiting for other work or GitHub to allow more requests',
};
type Choice = QueueFilters['briefing'];
export interface BriefingBudgetSummary {
  /** Automatic briefings run for at least one repository. */
  automatic: boolean;
  remaining: number;
  limit?: number;
  scope: QueueFilters['briefingScope'];
}

function pauseSummary(pauses: BriefingCounts['pauses']) {
  const reasons = (Object.keys(PAUSES) as BriefingPause[]).filter((reason) => pauses[reason] > 0);
  return {
    label: reasons.length === 1 ? PAUSES[reasons[0]] : undefined,
    title: reasons.map((reason) => `${pauses[reason]} ${PAUSE_DETAILS[reason]}`).join('\n'),
  };
}

function Chips({ counts, value, budget, onChange, onSettings }: {
  counts: BriefingCounts;
  value: Choice;
  budget: BriefingBudgetSummary;
  onChange: (value: Choice) => void;
  onSettings: () => void;
}) {
  const pause = pauseSummary(counts.pauses);
  const chips: { value: Choice; label: string; count: number; title: string; reason?: string }[] = [
    { value: 'all', label: 'All', count: counts.all, title: 'All entries shown by your other filters' },
    { value: 'generating', label: 'Generating', count: counts.generating, title: 'Briefings being written now' },
    ...(counts.queued || value === 'queued'
      ? [{ value: 'queued' as const, label: 'Queued', count: counts.queued, title: 'Waiting for their turn to start' }]
      : []),
    { value: 'ready', label: 'Ready', count: counts.ready, title: 'Briefing ready to read' },
    {
      value: 'paused',
      label: 'Paused',
      count: counts.paused,
      reason: pause.label,
      title: counts.paused ? `Paused briefings:\n${pause.title}` : 'No paused briefings',
    },
    ...(counts.failed || value === 'failed'
      ? [{ value: 'failed' as const, label: 'Failed', count: counts.failed, title: 'Briefing failed. Retry it from the briefing or Activity.' }]
      : []),
  ];
  const budgetText = budget.automatic
    ? `${budget.remaining} automatic left · resets at midnight`
    : 'Automatic briefings off';
  const budgetTitle = budget.automatic
    ? [
        'Automatic briefings by default',
        budget.scope === 'matches' ? 'Matches only' : 'Matches first',
        `${budget.remaining}${budget.limit !== undefined ? ` of ${budget.limit}` : ''} automatic attempts left overall`,
        'Resets at midnight. Manual briefings do not count.',
      ].join(' · ')
    : 'Automatic briefings are off. Generate briefings from a queue entry, or turn them on in briefing settings.';
  return (
    <div className="briefing-chips">
      <div className="briefing-chips-group" role="group" aria-label="Filter by briefing status">
        <span className="briefing-chips-label" aria-hidden="true">Briefings</span>
        {chips.map((chip) => {
          const pressed = value === chip.value;
          return (
            <button
              key={chip.value}
              type="button"
              className="briefing-chip"
              data-state={chip.value}
              aria-pressed={pressed}
              title={chip.title}
              aria-label={`${chip.value === 'all' ? 'All briefings' : chip.label}: ${chip.count}${chip.reason ? `, ${chip.reason}` : ''}`}
              onClick={() => onChange(pressed || chip.value === 'all' ? 'all' : chip.value)}
            >
              {chip.value !== 'all' && <span className="briefing-chip-dot" aria-hidden="true" />}
              {chip.label}
              <span className="briefing-chip-count">{chip.count}</span>
              {chip.reason && <span className="briefing-chip-reason">· {chip.reason}</span>}
            </button>
          );
        })}
      </div>
      <span className="briefing-chips-budget" title={budgetTitle}>{budgetText}</span>
      <button type="button" className="briefing-chips-settings" aria-label="Briefing settings" title={`Briefing settings\n${budgetText}`} onClick={onSettings}>
        <Settings size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

const sameCounts = (a: BriefingCounts, b: BriefingCounts) =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

/** Counts arrive as a new object after any queue change; equal counts skip the render. */
export const BriefingStatusChips = memo(Chips, (a, b) =>
  a.value === b.value &&
  a.onChange === b.onChange &&
  a.onSettings === b.onSettings &&
  sameCounts(a.counts, b.counts) &&
  a.budget.automatic === b.budget.automatic &&
  a.budget.remaining === b.budget.remaining &&
  a.budget.limit === b.budget.limit &&
  a.budget.scope === b.budget.scope
);
