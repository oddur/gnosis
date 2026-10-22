import { useId } from 'react';
import type { QueueItem } from '../lib/workbench';
import { RECENCY_DAYS, type QueueFilters } from '../lib/queue-filters';

export function QueueFilterPanel({
  filters,
  items,
  onChange,
}: {
  filters: QueueFilters;
  items: QueueItem[];
  onChange: (patch: Partial<QueueFilters>) => void;
}) {
  const id = useId();
  const members = items.flatMap((i) => i.subject.members).filter((m) => m.state === 'open' && !m.merged);
  const authors = [
    ...new Set([...members.map((m) => m.author), ...(filters.author === 'all' ? [] : [filters.author])]),
  ].sort();
  const labels = [
    ...new Set([...members.flatMap((m) => m.labels), ...(filters.label === 'all' ? [] : [filters.label])]),
  ].sort();
  const fields: { key: keyof QueueFilters; label: string; options: [string, string][] }[] = [
    {
      key: 'status',
      label: 'PR status',
      options: [
        ['all', 'All open PRs'],
        ['ready', 'Ready for review'],
        ['draft', 'Draft'],
      ],
    },
    { key: 'author', label: 'Author', options: [['all', 'Anyone'], ...authors.map((a) => [a, a] as [string, string])] },
    {
      key: 'createdWithin',
      label: 'Created',
      options: RECENCY_DAYS.map((d) => [String(d), d ? `Last ${d} days` : 'Any time']),
    },
    {
      key: 'updatedWithin',
      label: 'Last updated',
      options: RECENCY_DAYS.map((d) => [String(d), d ? `Last ${d} days` : 'Any time']),
    },
    {
      key: 'label',
      label: 'GitHub label',
      options: [['all', 'Any label'], ...labels.map((l) => [l, l] as [string, string])],
    },
    {
      key: 'kind',
      label: 'Grouping',
      options: [
        ['all', 'Stacks and standalone PRs'],
        ['stack', 'Stacks only'],
        ['pr', 'Standalone PRs only'],
      ],
    },
    {
      key: 'explanation',
      label: 'Guided explanation',
      options: [
        ['all', 'Any state'],
        ['none', 'Not generated'],
        ['ready', 'Ready'],
        ['outdated', 'Outdated'],
        ['generating', 'Generating'],
        ['failed', 'Generation failed'],
      ],
    },
  ];
  return (
    <section id="queue-filter-panel" className="queue-filter-panel" aria-label="Queue filters">
      <div className="queue-filter-fields">
        {fields.map((field) => (
          <label key={field.key} htmlFor={`${id}-${field.key}`}>
            <span>{field.label}</span>
            <select
              id={`${id}-${field.key}`}
              className="workbench-select"
              value={filters[field.key]}
              onChange={(e) =>
                onChange({
                  [field.key]:
                    field.key === 'createdWithin' || field.key === 'updatedWithin'
                      ? Number(e.target.value)
                      : e.target.value,
                })
              }
            >
              {field.options.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className="queue-filter-policy">
        <label htmlFor={`${id}-briefings`}>
          Automatic briefings
          <select
            id={`${id}-briefings`}
            className="workbench-select"
            value={filters.briefingScope}
            onChange={(e) => onChange({ briefingScope: e.target.value as QueueFilters['briefingScope'] })}
          >
            <option value="matches">Only matching changes</option>
            <option value="all">Matching changes first, then the rest</option>
          </select>
        </label>
        <p>A briefing already running will finish. Your daily allowance still applies.</p>
      </div>
      <p className="queue-filter-hint">
        Filters match open PRs. A matching PR keeps its whole stack visible, including merged parents. “Created” hides
        old PRs even if they were updated recently.
      </p>
    </section>
  );
}
