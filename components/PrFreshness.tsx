import { freshnessLabel } from '../lib/focus-refresh';
import { useStatusNow } from '../lib/status-clock';
import { LoadingIndicator } from './LoadingState';

/**
 * "Checked 2m ago": when Gnosis last read this PR from GitHub. While the copy saved last session is on screen and
 * main has not answered yet, the same slot says "Refreshing…" instead: one label, in one place, so nothing moves. Ages on the shared status clock, so only this label
 * renders again. The slot keeps its width before the first read, so nothing beside it moves.
 */
export function PrFreshness({
  checkedAt,
  className,
  queue = false,
  refreshing = false,
}: {
  checkedAt?: number;
  className: string;
  queue?: boolean;
  refreshing?: boolean;
}) {
  // The shared status clock renders this again every 30 s and on focus; the label reads the time itself.
  useStatusNow();
  const now = Date.now();
  if (refreshing)
    return (
      <span className={`${className} is-refreshing`} title="Showing what Gnosis saved last session while it reads GitHub again.">
        <LoadingIndicator announce={false}>Refreshing…</LoadingIndicator>
      </span>
    );
  // The empty slot keeps its width, so the label arriving never moves the row around it. In the queue toolbar a
  // narrower title column would wrap the description and shift the actions down (#341).
  if (checkedAt === undefined) return <span className={className} aria-hidden="true" />;
  const label = freshnessLabel(checkedAt, now);
  const at = new Date(checkedAt);
  const title = queue
    ? `Gnosis last checked GitHub for queue changes at ${at.toLocaleTimeString()}. It checks again every 2 minutes while this window is visible.`
    : `Gnosis last read this PR from GitHub at ${at.toLocaleTimeString()}. Switching to it or back to Gnosis reads it again.`;
  return (
    <span className={className} title={title}>
      <time dateTime={at.toISOString()}>{label}</time>
    </span>
  );
}

/** The stalest member's newest read: a stack is only as fresh as its least recently read PR. */
export function subjectCheckedAt(perMember: (number | undefined)[]): number | undefined {
  const known = perMember.filter((value): value is number => value !== undefined);
  return known.length ? Math.min(...known) : undefined;
}
