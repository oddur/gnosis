import { RepositoryPicker } from './RepositoryPicker';
import { QueueLabelFilter } from './QueueLabelFilter';
import { Fragment } from 'react';
import { SearchableSelect } from './SearchableSelect';
import { normalizePrInactivityDays } from '../lib/pr-inactivity';
import { useId } from 'react';
import type { QueueItem } from '../lib/workbench';
import { RECENCY_DAYS, type QueueFilters } from '../lib/queue-filters';

export function QueueFilterPanel({
  filters,
  items,
  setup = false,
  onChange,
  prInactivityDays,
  onManageInactivity,
  hasRepositoryOverrides = false,
}: {
  hasRepositoryOverrides?: boolean;
  setup?: boolean;
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
  const fields: { key: Exclude<keyof QueueFilters, 'starredOnly' | 'sort' | 'labels' | 'targetBranch' | 'repos'>; label: string; options: [string, string][] }[] = [
    { key: 'readStatus', label: 'Read status', options: [['all', 'Any read status'], ['unread', 'Unread'], ['read', 'Read']] },
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
          title="Change global defaults and repository overrides. Saved-view filters narrow this scope.">
          {hasRepositoryOverrides ? 'Repository inactivity settings apply · starred PRs included' : days ? `Active within ${days} days · starred PRs included` : 'No inactivity limit · change in Settings'}
        </button>
      </div>}
      {!setup && <div className="queue-filter-policy queue-filter-scope">
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
            <option value="review">Needs my review</option>
            <option value="authored">Authored by me</option>
          </select>
        </label>
        <p id={`${id}-involvement-help`}>
          {filters.involvement === 'review' ? 'PRs assigned to you or requesting your review.' : filters.involvement === 'authored' ? 'PRs you authored.' : filters.involvement === 'mine'
            ? 'PRs you authored, are assigned to, or were asked to review.'
            : 'PRs involving you and from repositories added in Settings.'}
        </p>
      </div>
      }
      {!setup && <RepositoryPicker value={filters.repos ?? (filters.repo === 'all' ? [] : [filters.repo])} options={[...new Set(members.map(member => member.repo))]} onChange={repos => onChange({ repo: 'all', repos })} />}
      <div className="queue-filter-fields">
        {fields.filter(field => !setup || ['readStatus', 'status', 'author'].includes(field.key)).map((field) => (
          <Fragment key={field.key}><label htmlFor={`${id}-${field.key}`}>
            <span>{field.label}</span>
            {field.key === 'author' ? (
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
          {field.key === 'author' && <label htmlFor={`${id}-targetBranch`} className="queue-target-branch">
            <span>Target branch</span>
            <input
              id={`${id}-targetBranch`}
              className="workbench-select"
              type="text"
              value={filters.targetBranch}
              maxLength={300}
              placeholder="Any branch"
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
              aria-describedby={`${id}-targetBranch-help`}
              onChange={event => onChange({ targetBranch: event.target.value })}
            />
            <span id={`${id}-targetBranch-help`}>e.g. <code>release/*</code> · <code>*</code> matches any text</span>
          </label>}
          {field.key === 'readStatus' && <QueueLabelFilter value={filters.labels}
            members={filters.repo === 'all' ? members : members.filter(member => member.repo === filters.repo)}
            onChange={labels => onChange({ labels })} />}
          </Fragment>
        ))}
      </div>
      {!setup && <div className="queue-filter-policy">
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
          {filters.involvement === 'review' ? 'PRs assigned to you or requesting your review.' : filters.involvement === 'authored' ? 'PRs you authored.' : filters.involvement === 'mine'
            ? 'Both options stay within PRs involving you.'
            : 'Applies when Automatic briefings is on.'}
        </p>
      </div>
      }
      <p className="queue-filter-hint">One open PR must match all filters. Its whole stack stays visible.</p>
      <details className="queue-filter-help">
        <summary>How filters work</summary>
        <p>Unread means new activity since you last opened the PR, or a PR you marked as unread.</p>
        <p>Target branch matches the whole name, including case. Use * for any text (including /), or ? for one character. Leave it blank for any branch.</p>
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
