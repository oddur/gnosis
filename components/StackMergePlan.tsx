import { Button } from './ui/button';
import { SubjectIcon } from './SubjectIcon';
import { StackMarkReady } from './StackMarkReady';
import { Clock3, CircleAlert, CircleHelp, RefreshCw } from 'lucide-react';
import type { stackMergePlan } from '../lib/stack-merge-plan';
import type { ReviewMember } from '../lib/workbench';
import { QUEUE_SIGNALS_TTL } from '../lib/queue-signals';
import { timeAgo } from '../lib/utils';

type Plan = ReturnType<typeof stackMergePlan>;

export function StackMergePlan({
  plan,
  onOpen,
  account,
  onChanged,
  refreshing = false,
}: {
  plan: Plan;
  onOpen: (member: ReviewMember) => void;
  account: string | null;
  onChanged: () => void;
  refreshing?: boolean;
}) {
  if (!plan.entries.length || plan.ready) return null;
  const { status } = plan;
  const readyCount = status.entries.filter((entry) => entry.readiness.ready).length;
  const waitingCount = status.entries.filter((entry) => entry.category === 'waiting').length;
  const unknown = plan.groups.some((group) => ['refresh', 'check-status'].includes(group.key));
  const Icon = status.blocked ? CircleAlert : status.unconfirmed ? CircleHelp : Clock3;
  return (
    <section
      data-blocked={!!status.blocked || undefined}
      data-uncertain={(!status.blocked && !!status.unconfirmed) || undefined}
      className="stack-merge-plan"
      aria-label="Merge steps"
    >
      <header className="stack-plan-heading">
        <div>
          <h2>
            <Icon size={16} aria-hidden="true" />
            {status.blocked
              ? `${status.blocked} ${status.blocked === 1 ? 'PR blocks' : 'PRs block'} this stack`
              : status.unconfirmed
                ? 'Merge status not confirmed'
                : status.summary.label}
          </h2>
          <p className="stack-plan-summary">
            {readyCount} of {plan.entries.length} PRs confirmed ready
            {waitingCount > 0 && ` · ${waitingCount} waiting`}
            {status.unconfirmed > 0 && ` · ${status.unconfirmed} unconfirmed`}
          </p>
        </div>
        {unknown && (
          <Button size="sm" variant="outline" disabled={refreshing || !account} onClick={onChanged}>
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : undefined} aria-hidden="true" />
            {refreshing ? 'Refreshing status…' : 'Refresh merge status'}
          </Button>
        )}
      </header>
      {unknown && (
        <p className="stack-plan-guidance">
          {!account
            ? 'Connect GitHub to check merge status.'
            : refreshing
              ? 'Checking GitHub for conflicts, required checks, and approvals…'
              : 'Refresh status to check for conflicts, required checks, and approvals.'}
        </p>
      )}
      <ul>
        {plan.groups.map((group) => {
          const sharedDetail =
            group.key === 'refresh' && group.entries.every((entry) => entry.detail === group.entries[0].detail)
              ? group.entries[0].detail
              : undefined;
          return (
            <li key={group.key} data-step={group.key}>
              <span className="stack-plan-task" hidden={plan.groups.length === 1 && group.key === 'refresh'}>
                {['waiting', 'queue'].includes(group.key) && <Clock3 size={14} aria-hidden="true" />}
                {group.label}
              </span>
              <span className="stack-plan-prs">
                {sharedDetail && <span className="stack-plan-detail">{sharedDetail}</span>}
                {group.entries.map(({ member, detail }) => (
                  <span className="stack-plan-entry" key={member.url}>
                    <a
                      href={member.url}
                      onClick={(event) => {
                        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                        event.preventDefault();
                        onOpen(member);
                      }}
                      title={`Open PR #${member.number}: ${member.title}`}
                      aria-label={`Open PR #${member.number}: ${member.title}. ${group.label}`}
                    >
                      <SubjectIcon kind="pr" />
                      <span className="stack-plan-pr-number">#{member.number}</span>
                      <span>{member.title}</span>
                    </a>
                    {detail && !sharedDetail && <span className="stack-plan-detail">{detail}</span>}
                  </span>
                ))}
              </span>
              {group.key === 'draft' && (
                <StackMarkReady
                  key={account}
                  members={group.entries.map((entry) => entry.member)}
                  account={account}
                  onChanged={onChanged}
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function StackChecksFreshness({ plan, now, delayed }: { plan: Plan; now: number; delayed: boolean }) {
  if (!plan.entries.length) return null;
  return (
    <span className="merge-readiness-checked stack-checks-freshness">
      {plan.checksCheckedAt === undefined ? (
        `Check results loaded for ${plan.loadedChecks}/${plan.entries.length} PRs`
      ) : (
        <>
          Check results checked{' '}
          <time
            dateTime={new Date(plan.checksCheckedAt).toISOString()}
            title={new Date(plan.checksCheckedAt).toLocaleString()}
          >
            {timeAgo(new Date(plan.checksCheckedAt).toISOString())}
          </time>
        </>
      )}
      {delayed
        ? ' · Updates delayed'
        : plan.checksCheckedAt !== undefined && now - plan.checksCheckedAt >= QUEUE_SIGNALS_TTL
          ? ' · Refresh needed'
          : ''}
    </span>
  );
}
