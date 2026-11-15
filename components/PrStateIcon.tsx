import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, type LucideIcon } from 'lucide-react';
import { prState, prStateName, type PrState, type PrStateSource } from '../lib/pr-state';
import { useFreshPrCopy } from '../lib/pr-state-store';

const icons: Record<PrState, LucideIcon> = {
  open: GitPullRequest,
  draft: GitPullRequestDraft,
  merged: GitMerge,
  closed: GitPullRequestClosed,
};

/**
 * GitHub's PR state icon: green open, gray draft, purple merged, red closed. An unknown state shows the neutral PR
 * icon in the same slot, so nothing shifts when the state loads. Pass a PR copy as `pr`, or its fields directly.
 * `decorative` hides it from assistive technology where the state is already written out beside it.
 */
export function PrStateIcon({
  pr,
  state,
  isDraft,
  merged,
  size = 16,
  decorative = false,
  className = '',
}: {
  pr?: PrStateSource | null;
  state?: PrState | 'open' | 'closed' | null;
  isDraft?: boolean | null;
  merged?: boolean | null;
  /** Pixels, or `'1em'` to follow the surrounding text like other entity heading icons. */
  size?: number | '1em';
  decorative?: boolean;
  className?: string;
}) {
  const fresh = useFreshPrCopy(pr);
  const kind = prState(pr === undefined ? { state, isDraft, merged } : fresh);
  const Icon = kind ? icons[kind] : GitPullRequest;
  const name = prStateName(kind);
  const px = size === '1em' ? undefined : size;
  return (
    <span
      className={`pr-state-icon is-${kind ?? 'unknown'} ${size === '1em' ? 'is-text-sized' : ''} ${className}`.trim()}
      data-pr-state={kind ?? 'unknown'}
      style={px ? { width: px, height: px } : undefined}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name })}
      title={kind ? name : undefined}
    >
      <Icon size={px ?? '1em'} aria-hidden="true" focusable="false" />
    </span>
  );
}
