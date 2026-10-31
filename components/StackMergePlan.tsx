import { StackMarkReady } from './StackMarkReady';
import { Clock3 } from 'lucide-react';
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
}: {
  plan: Plan;
  onOpen: (member: ReviewMember) => void;
  account: string | null;
  onChanged: () => void;
}) {
  if (!plan.entries.length || plan.ready) return null;
  return (
    <section className="stack-merge-plan" aria-label="Merge steps">
      <h2>To merge this stack</h2>
      <ul>
        {plan.groups.map((group) => (
          <li key={group.key} data-step={group.key}>
            <span>
              {['waiting', 'queue'].includes(group.key) && <Clock3 size={14} aria-hidden="true" />}
              {group.label}
            </span>
            <span className="stack-plan-prs">
              {group.entries.map(({ member }) => (
                <a
                  href={member.url}
                  key={member.url}
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    onOpen(member);
                  }}
                  title={`Open PR #${member.number}: ${member.title}`}
                  aria-label={`Open PR #${member.number}: ${group.label}`}
                >
                  #{member.number}
                </a>
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
        ))}
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
