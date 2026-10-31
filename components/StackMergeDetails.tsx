import { ExternalLink } from 'lucide-react';
import { checkLabel } from '../lib/pr-checks';
import { stackMemberStatus } from '../lib/stack-member-status';
import { openConflictWorkspace } from '../lib/open-conflict-workspace';
import type { ReviewMember } from '../lib/workbench';
import { PrActions } from './PrActions';
import { StackCheckRerun } from './StackCheckRerun';

/** Facts and remedies belong to the same PR; optional checks never join its blocker list. */
export function StackMemberDetails({
  member,
  facts,
  onChecks,
  onRefresh,
  refreshDisabled,
}: {
  member: ReviewMember;
  facts: ReturnType<typeof stackMemberStatus>;
  onChecks: () => void;
  onRefresh: () => void;
  refreshDisabled: boolean;
}) {
  const uncertain = facts.readiness.stale || !facts.policy || facts.readiness.label === 'Readiness unknown';
  const keys = new Set(facts.blockers.map((b) => b.key));
  const checkRow = (check: (typeof facts.attention)[number]) => (
    <li key={check.id}>
      <div>
        <strong>{check.name}</strong>
        <span>
          {checkLabel(check)} ·{' '}
          {facts.readiness.ready
            ? 'Does not block merging'
            : check.required === true
              ? 'Required to merge'
              : check.required === false
                ? 'Optional · Does not block merging'
                : 'Merge requirement unknown'}
        </span>
      </div>
      {!facts.finished && (
        <StackCheckRerun
          key={`${member.headSha}:${check.id}:${check.startedAt}:${check.completedAt}`}
          member={member}
          check={check}
          onChanged={onRefresh}
        />
      )}
    </li>
  );
  if (facts.readiness.ready && !facts.attention.length && !facts.branch.detail) return null;
  return (
    <div className="stack-member-resolution">
      {facts.blockers.length > 0 && (
        <ul className="stack-visible-blockers" aria-label={`Merge blockers for PR #${member.number}`}>
          {facts.blockers.map((blocker) => (
            <li key={blocker.key} data-blocker-key={blocker.key}>
              <span className="stack-blocker-reason">{blocker.text}</span>
              <div className="stack-inline-actions">
                {blocker.key === 'conflicts' && (
                  <button onClick={() => openConflictWorkspace(member.url)}>Resolve conflicts…</button>
                )}
                {['draft', 'update'].includes(blocker.key) && (
                  <PrActions
                    member={member}
                    onChanged={onRefresh}
                    trigger={(open, busy) =>
                      blocker.key === 'draft' ? (
                        <button disabled={busy} onClick={() => open('mark-ready')}>
                          Mark ready for review…
                        </button>
                      ) : (
                        <>
                          <button disabled={busy} onClick={() => open('update-merge')}>
                            Update with merge…
                          </button>
                          <button disabled={busy} onClick={() => open('update-rebase')}>
                            Update with rebase…
                          </button>
                        </>
                      )
                    }
                  />
                )}
                {blocker.key === 'checks' && <button onClick={onChecks}>Inspect required checks</button>}
                {blocker.key === 'review' && (
                  <a href={member.url} target="_blank" rel="noopener noreferrer">
                    View reviews on GitHub <ExternalLink size={12} />
                  </a>
                )}
                {blocker.key === 'rules' && (
                  <a href={member.url} target="_blank" rel="noopener noreferrer">
                    View requirements on GitHub <ExternalLink size={12} />
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {keys.has('checks') && (
        <p className="stack-required-check-names">
          {facts.required
            .slice(0, 2)
            .map((check) => `${check.name}: ${checkLabel(check).toLowerCase()}`)
            .join(' · ')}
          {facts.required.length > 2 && ` · ${facts.required.length - 2} more required checks`}
        </p>
      )}
      {facts.requiredRunning.length > 0 && (
        <p className="stack-inline-wait" data-blocker-key="waiting">
          Waiting for {facts.requiredRunning.length} required {facts.requiredRunning.length === 1 ? 'check' : 'checks'}.
          <button onClick={onChecks}>View progress</button>
        </p>
      )}
      {!!facts.policy?.queueState && !facts.finished && (
        <p className="stack-inline-wait" data-blocker-key="queue">
          Waiting in the GitHub merge queue.{' '}
          <a href={member.url} target="_blank" rel="noopener noreferrer">
            View queue on GitHub
          </a>
        </p>
      )}
      {uncertain && !facts.finished && (
        <p className="stack-inline-wait" data-blocker-key="refresh">
          {facts.readiness.stale ? 'Saved merge status needs refresh.' : 'Some merge requirements are not confirmed.'}
          <button disabled={refreshDisabled} onClick={onRefresh}>
            Refresh status
          </button>
        </p>
      )}
      {facts.checksUnconfirmed && (
        <p className="stack-inline-wait" data-blocker-key="check-status">
          Check requirements are not confirmed. <button onClick={onChecks}>Inspect checks</button>
        </p>
      )}
      <details className="stack-member-disclosure">
        <summary>
          View check details and merge requirements<span className="sr-only"> for PR #{member.number}</span>
        </summary>
        <div className="stack-member-evidence">
          {uncertain && !facts.finished && (
            <section>
              <h3>{facts.readiness.stale ? 'Status needs refresh' : 'Merge requirements unknown'}</h3>
              <p>
                {facts.readiness.stale
                  ? facts.readiness.details[0]
                  : 'GitHub has not confirmed all merge requirements for this revision.'}
              </p>
              <button disabled={refreshDisabled} onClick={onRefresh}>
                Refresh status
              </button>
            </section>
          )}
          {!facts.blockers.length && !uncertain && (
            <p>
              {facts.readiness.ready
                ? 'GitHub reports merge requirements satisfied for this revision.'
                : facts.readiness.details[0]}
            </p>
          )}
          {[
            { title: 'Required checks that did not pass', checks: facts.readiness.ready ? [] : facts.required },
            {
              title: facts.readiness.ready ? 'Checks that do not block merging' : 'Other check results',
              checks: facts.readiness.ready
                ? facts.attention
                : facts.attention.filter((check) => check.required !== true),
            },
          ]
            .filter((group) => group.checks.length)
            .map((group) => (
              <section
                key={group.title}
                className="stack-check-evidence"
                aria-label={`${group.title} for PR #${member.number}`}
              >
                <h3>{group.title}</h3>
                <ul>{group.checks.slice(0, 3).map(checkRow)}</ul>
                {group.checks.length > 3 && (
                  <details className="stack-more-checks">
                    <summary>Show {group.checks.length - 3} more check results</summary>
                    <ul>{group.checks.slice(3).map(checkRow)}</ul>
                  </details>
                )}
              </section>
            ))}
          {facts.branch.detail && (
            <p>
              {facts.branch.label} {facts.policy?.baseBranch || member.baseBranch} · {facts.branch.detail}.
            </p>
          )}
          <div className="stack-remedies">
            <button aria-label={`View checks for PR #${member.number}`} onClick={onChecks}>
              View all checks
            </button>
            <a href={member.url} target="_blank" rel="noopener noreferrer">
              View on GitHub <ExternalLink size={12} />
            </a>
          </div>
        </div>
      </details>
    </div>
  );
}
