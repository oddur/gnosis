/** The state GitHub shows beside a PR name: open, draft, merged or closed. */
export type PrState = 'open' | 'draft' | 'merged' | 'closed';

/** Any copy of a PR that carries its lifecycle. Fields can be absent while the PR is still loading. */
export interface PrStateSource {
  state?: string | null;
  merged?: boolean | null;
  isDraft?: boolean | null;
  /** With `url` and `updatedAt`, a newer copy of the same PR shown elsewhere can update this one. */
  url?: string;
  updatedAt?: string;
}

export const PR_STATES: readonly PrState[] = ['open', 'draft', 'merged', 'closed'];

export const prStateLabels: Record<PrState, string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
};

/**
 * The state of a PR as GitHub shows it. Merged wins over closed (a merged PR is also closed), and draft only applies
 * to an open PR. Returns undefined when the copy does not say yet, so the caller can show a neutral PR icon
 * instead of guessing. Accepts REST (`open`/`closed` + `merged`) and GraphQL (`OPEN`/`MERGED`/`CLOSED`) states.
 */
export function prState(pr: PrStateSource | null | undefined): PrState | undefined {
  if (!pr) return undefined;
  const state = typeof pr.state === 'string' ? pr.state.toLowerCase() : undefined;
  if (pr.merged || state === 'merged') return 'merged';
  if (state === 'closed') return 'closed';
  if (state === 'open') return pr.isDraft ? 'draft' : 'open';
  if (state === 'draft') return 'draft';
  return undefined;
}

/**
 * The accessible name for a state icon. "PR state:" keeps "Open" from reading as an action when the icon sits inside
 * a link or button, such as "PR state: Open, Fix the parser".
 */
export const prStateName = (state: PrState | undefined) => (state ? `PR state: ${prStateLabels[state]}` : 'Pull request');

const time = (value: string | undefined) => (value && Date.parse(value)) || 0;

/**
 * The fresher of two copies of the same PR. A later `updatedAt` wins; on a tie, `own` wins, except that a merged or
 * closed copy beats an open one (GitHub cannot reopen a PR without updating it). A copy without a known state never
 * replaces one with a state.
 */
export function fresherPrCopy<T extends PrStateSource>(own: T | null | undefined, other: T | null | undefined): T | null | undefined {
  if (!other || !prState(other)) return own;
  if (!own || !prState(own)) return other;
  const order = time(other.updatedAt) - time(own.updatedAt);
  if (order) return order > 0 ? other : own;
  const ownOpen = prState(own) === 'open' || prState(own) === 'draft';
  const otherOpen = prState(other) === 'open' || prState(other) === 'draft';
  return ownOpen && !otherOpen ? other : own;
}
