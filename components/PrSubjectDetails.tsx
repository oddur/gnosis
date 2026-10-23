import { PrDetails } from './PrDetails';
import { memberReadiness } from './PrReadiness';
import type { ReviewSubject } from '../lib/workbench';
import type { PrStatus } from '../lib/types';

export function PrSubjectDetails({
  subject,
  activeUrl,
  onSelect,
  statuses = {},
  statusErrors = {},
  onRetryStatus,
  compactIdentity = false,
}: {
  subject: ReviewSubject;
  activeUrl: string;
  onSelect: (url: string) => void;
  statuses?: Partial<Record<string, PrStatus>>;
  statusErrors?: Record<string, string>;
  onRetryStatus?: () => void;
  compactIdentity?: boolean;
}) {
  const member = subject.members.find((m) => m.url === activeUrl) ?? subject.members[0];
  const stacked = subject.members.length > 1;
  const relationship = (url: string) => {
    const parents = subject.edges
      .filter((e) => e.child === url)
      .map((e) => subject.members.find((m) => m.url === e.parent)?.number);
    return parents.length
      ? `Builds on ${parents.map((n) => (n === undefined ? 'an earlier PR' : `#${n}`)).join(', ')}`
      : 'Base of stack';
  };
  return (
    <div className={`pr-subject-details ${stacked ? 'has-stack' : ''}`}>
      {stacked && (
        <>
          <nav className="pr-stack-nav" aria-label="PRs in this stack">
            <h2>PRs in this stack</h2>
            <p>Read from the base upward.</p>
            <ol>
              {subject.members.map((m, i) => (
                <li key={m.url}>
                  <button
                    aria-current={m.url === member.url ? 'true' : undefined}
                    aria-controls="pr-member-detail"
                    onClick={() => onSelect(m.url)}
                  >
                    <span className="pr-stack-number">{i + 1}</span>
                    <span>
                      <strong>
                        #{m.number} {m.title}
                      </strong>
                      <small>{relationship(m.url)}</small>
                      <small>{memberReadiness(m, statuses[m.url], statusErrors[m.url])}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          <label className="pr-stack-select">
            PR in stack
            <select value={member.url} onChange={(e) => onSelect(e.target.value)}>
              {subject.members.map((m, i) => (
                <option key={m.url} value={m.url}>
                  {i + 1} of {subject.members.length} · #{m.number} ·{' '}
                  {memberReadiness(m, statuses[m.url], statusErrors[m.url])} — {m.title}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <div
        id="pr-member-detail"
        className="pr-member-detail"
        role="region"
        aria-label={`Selected PR #${member.number}`}
      >
        {stacked && (
          <p className="pr-member-relationship">
            {relationship(member.url)} · {subject.members.findIndex((m) => m.url === member.url) + 1} of{' '}
            {subject.members.length} PRs
          </p>
        )}
        <PrDetails
          key={member.url}
          member={member}
          showTitle={stacked}
          showIdentity={stacked || !compactIdentity}
          status={statuses[member.url]}
          statusError={statusErrors[member.url]}
          onRetryStatus={onRetryStatus}
        />
      </div>
    </div>
  );
}
