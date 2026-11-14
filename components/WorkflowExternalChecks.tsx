import { ExternalLink } from 'lucide-react';
import { checkGroupIcons } from '../lib/interface-icons';
import { checkDuration, checkGroup, checkLabel, type PrCheck } from '../lib/pr-checks';
import { checkLinkLabel, type ExternalCheckGroup } from '../lib/workflow-external';

/**
 * Checks without Actions dependency data, drawn as standalone job cards in the canvas.
 * Order matches List: failures first, then running, passed, and skipped.
 */
export function WorkflowExternalChecks({
  group,
  selectedId,
  onOpen,
}: {
  group: ExternalCheckGroup;
  selectedId?: string;
  onOpen: (check: PrCheck) => void;
}) {
  const Icon = checkGroupIcons[group.outcome];
  return (
    <section className="workflow-external" aria-labelledby="workflow-external-title">
      <header className="workflow-external-heading">
        <h2 id="workflow-external-title">
          <Icon size={16} className={`check-${group.outcome}`} aria-hidden="true" />
          {group.name}
        </h2>
        <p>
          <span className={`check-${group.outcome}`}>{group.label}</span> · {group.checks.length}{' '}
          {group.checks.length === 1 ? 'check' : 'checks'} ·{' '}
          {group.source === 'external'
            ? 'Reported outside GitHub Actions, so there are no dependency arrows.'
            : 'These jobs belong to workflow runs that GitHub did not list for this commit.'}
        </p>
      </header>
      <ul className="workflow-external-grid" aria-label={`${group.name} checks`}>
        {group.checks.map((check) => {
          const outcome = checkGroup(check),
            label = checkLabel(check);
          const State = checkGroupIcons[outcome];
          const duration = checkDuration(check);
          const link = check.url ? checkLinkLabel(check) : '';
          // The heading already names the provider; only say what differs per check.
          const context =
            check.description ?? (check.required === true ? 'Required' : check.required === false ? 'Optional' : '');
          return (
            <li key={check.id}>
              <div
                className="workflow-job workflow-external-check"
                data-outcome={outcome}
                data-selected={check.id === selectedId || undefined}
              >
                <button
                  type="button"
                  className="workflow-job-open"
                  onClick={() => onOpen(check)}
                  aria-label={`${check.name}: ${label}`}
                  title={check.name}
                >
                  <span className="workflow-job-name">{check.name}</span>
                  <span className={`workflow-job-state check-${outcome}`}>
                    <State size={15} aria-hidden="true" />
                    <span>{label}</span>
                    <span className="workflow-job-duration">{duration}</span>
                  </span>
                  {context && (
                    <span className="workflow-job-context" title={context}>
                      {context}
                    </span>
                  )}
                </button>
                {check.url && (
                  <a
                    className="workflow-external-link"
                    href={check.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={link}
                    aria-label={`${link}: ${check.name}`}
                  >
                    <ExternalLink size={14} aria-hidden="true" />
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
