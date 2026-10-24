import { Star } from 'lucide-react';
import type { ReviewMember } from '../lib/workbench';

export function PrStarButton({
  members,
  starredUrls,
  busy,
  onChange,
}: {
  members: ReviewMember[];
  starredUrls: ReadonlySet<string>;
  busy?: boolean;
  onChange: (members: ReviewMember[], starred: boolean) => void;
}) {
  const count = members.filter((member) => starredUrls.has(member.url)).length;
  const starred = count > 0;
  const label =
    members.length === 1
      ? `${starred ? 'Unstar' : 'Star'} PR #${members[0].number}`
      : starred
        ? 'Unstar PRs in this stack'
        : 'Star all PRs in this stack';
  return (
    <button
      type="button"
      className={`pr-star-button${starred ? ' is-starred' : ''}`}
      aria-label={label}
      aria-pressed={count === members.length ? true : starred ? 'mixed' : false}
      title={`${label}${members.length > 1 ? ` (${count} of ${members.length} starred)` : ''} · Saved on this computer`}
      disabled={busy}
      onClick={() => onChange(members, !starred)}
    >
      <Star size={16} fill={starred ? 'currentColor' : 'none'} aria-hidden="true" />
    </button>
  );
}
