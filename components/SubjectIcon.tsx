import { subjectIcons } from '../lib/interface-icons';
import type { PrStateSource } from '../lib/pr-state';
import { PrStateIcon } from './PrStateIcon';

/**
 * A stable identity cue. A PR shows its state (open, draft, merged, closed) like GitHub: pass `pr` with the copy
 * on hand, or `null` while it loads to keep the neutral PR icon in the same slot.
 */
export function SubjectIcon({
  kind,
  pr,
  decorative,
}: {
  kind: 'stack' | 'pr' | 'repository' | 'commit';
  pr?: PrStateSource | null;
  decorative?: boolean;
}) {
  if (kind === 'pr' && pr !== undefined) return <PrStateIcon pr={pr} size="1em" decorative={decorative} className="subject-icon" />;
  const Icon = subjectIcons[kind];
  return <Icon className="subject-icon" aria-hidden="true" />;
}
