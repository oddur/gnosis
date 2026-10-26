import { SearchableSelect } from './SearchableSelect';
import { normalizePrInactivityDays } from '../lib/pr-inactivity';
import { useId } from 'react';
import type { QueueItem } from '../lib/workbench';
import { RECENCY_DAYS, type QueueFilters } from '../lib/queue-filters';

export function QueueFilterPanel({
  filters,
  items,
  onChange,
  prInactivityDays,
  onManageInactivity,
}: {
  prInactivityDays?: number;
  onManageInactivity?: () => void;
  filters: QueueFilters;
  items: QueueItem[];
  onChange: (patch: Partial<QueueFilters>) => void;
}) {
  const id = useId();
  const days = normalizePrInactivityDays(prInactivityDays);
  const members = items.flatMap((i) => i.subject.members).filter((m) => filters.starredOnly || (m.state === 'open' && !m.merged));
  const authors = [
    ...new Set([...members.map((m) => m.author), ...(filters.author === 'all' ? [] : [filters.author])]),
  ].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  const labels = [
    ...new Set([...members.flatMap((m) => m.labels), ...(filters.label === 'all' ? [] : [filters.label])]),
  ].sort();
  const fields: { key: Exclude<keyof QueueFilters, 'starredOnly' | 'unreadOnly' | 'sort'>; label: string; options: [string, string][] }[] = [
    {
      key: 'status',
      label: 'PR status',
      options: [
        ['all', filters.starredOnly ? 'All starred PRs' : 'All open PRs'],
        ['ready', 'Open, not draft'],
        ['draft', 'Draft'],
      ],
    },
    { key: 'author', label: 'Author', options: [['all', 'Anyone'], ...authors.map((a) => [a, a] as [string, string])] },
    {
      key: 'createdWithin',
      label: 'PR created',
      options: RECENCY_DAYS.map((d) => [String(d), d ? `Last ${d} days` : 'Any time']),
    },
    {
      key: 'updatedWithin',
      label: 'PR last updated',
      options: RECENCY_DAYS.map((d) => [String(d), d ? `Last ${d} days` : 'Any time']),
    },
    {
      key: 'label',
      label: 'GitHub label',
      options: [['all', 'Any label'], ...labels.map((l) => [l, l] as [string, string])],
    },
    {
      key: 'kind',
      label: 'PRs or stacks',
      options: [
        ['all', 'PRs and stacks'],
        ['stack', 'Stacks only'],
        ['pr', 'Standalone PRs only'],
      ],
    },
    {
      key: 'explanation',
      label: 'AI explanation',
      options: [
        ['all', 'Any state'],
        ['none', 'Not generated'],
        ['ready', 'Up to date'],
        ['outdated', 'Needs regeneration'],
        ['generating', 'Generating'],
        ['failed', 'Generation failed'],
      ],
    },
  ];
  return (
    <section id="queue-filter-panel" className="queue-filter-panel" aria-label="Queue filters">
      {onManageInactivity && <div className="queue-filter-policy">
        <button type="button" className="queue-inactivity-link" onClick={onManageInactivity}
          title="Change the global inactivity limit. Saved-view filters narrow this scope.">
          {days ? `Active within ${days} days · starred PRs included` : 'No inactivity limit · change in Settings'}
        </button>
      </div>}
      <div className="queue-filter-policy queue-filter-scope">
        <label htmlFor={`${id}-involvement`}>
          Show
          <select
            id={`${id}-involvement`}
            className="workbench-select"
            value={filters.involvement}
            aria-describedby={`${id}-involvement-help`}
            onChange={(e) => onChange({ involvement: e.target.value as QueueFilters['involvement'] })}
          >
            <option value="all">All PRs in your queue</option>
            <option value="mine">Involving me</option>
          </select>
        </label>
        <p id={`${id}-involvement-help`}>
          {filters.involvement === 'mine'
            ? 'PRs you authored, are assigned to, or were asked to review.'
            : 'PRs involving you and from repositories added in Settings.'}
        </p>
      </div>
      <label className="queue-unread-filter">
        <input type="checkbox" checked={filters.unreadOnly} onChange={event => onChange({ unreadOnly: event.target.checked })} />
        Unread updates only
      </label>
      <div className="queue-filter-fields">
        {fields.map((field) => (
          <label key={field.key} htmlFor={`${id}-${field.key}`}>
            <span>{field.label}</span>
            {field.key === 'author' || field.key === 'label' ? (
              <SearchableSelect
                id={`${id}-${field.key}`}
                label={field.label}
                value={filters[field.key]}
                options={field.options.map(([value, label]) => ({ value, label }))}
                onValueChange={value => onChange({ [field.key]: value })}
              />
            ) : (
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
            )}
          </label>
        ))}
      </div>
      <div className="queue-filter-policy">
        <label htmlFor={`${id}-briefings`}>
          Automatically brief
          <select
            id={`${id}-briefings`}
            className="workbench-select"
            value={filters.briefingScope}
            aria-describedby={`${id}-briefings-help`}
            onChange={(e) => onChange({ briefingScope: e.target.value as QueueFilters['briefingScope'] })}
          >
            <option value="matches">Matching PRs and stacks only</option>
            <option value="all">Matches first, then the rest</option>
          </select>
        </label>
        <p id={`${id}-briefings-help`}>
          {filters.involvement === 'mine'
            ? 'Both options stay within PRs involving you.'
            : 'Applies when Automatic briefings is on.'}
        </p>
      </div>
      <p className="queue-filter-hint">One open PR must match all filters. Its whole stack stays visible.</p>
      <details className="queue-filter-help">
        <summary>How filters work</summary>
        <p>Use “PR created” to exclude old PRs, even if they were updated recently.</p>
        <p>“Up to date” means the AI explanation matches the latest loaded PR data.</p>
        <p>“Involving me” also reduces PR details fetched from GitHub. Related stack PRs stay included.</p>
        <p>
          Automatic briefings use your daily attempt limit. Changing filters lets the current briefing finish. Saved
          views share cached GitHub data.
        </p>
      </details>
    </section>
  );
}
