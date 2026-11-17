/**
 * Where a notification click lands (#385 part 2). Each event opens the exact place to act:
 *
 * - checks failed: the Checks tab, which selects the first failing job (or the named check);
 * - a comment, reply, mention or change request: its thread in Feedback, selected and scrolled into view;
 * - review requested, or new commits since your review: Changes, at the first file not yet viewed (Gnosis has no
 *   "commits since your review" view yet);
 * - ready to merge: the PR with the merge action focused;
 * - snooze ended: the PR's Summary, which shows the "Back: …" reason;
 * - a digest or summary: the queue filtered to its PRs (`digestTarget` in notification-routing).
 *
 * Pure. Events that already carry a thread keep it.
 */
import { prRef, type DeepLinkTarget } from './deep-link';
import type { NotificationEvent } from './notification-events';

export function preciseTarget(event: Pick<NotificationEvent, 'type' | 'url' | 'target'>): DeepLinkTarget | undefined {
  const current = event.target;
  // Local results, such as an explanation, keep their own target.
  if (current && current.kind !== 'pr') return current;
  const ref = event.url ? prRef(event.url) : current?.pr;
  if (!ref) return current;
  const pr = { kind: 'pr' as const, pr: ref };
  switch (event.type) {
    case 'checks-failed':
      return { ...pr, tab: 'checks', ...(current?.check ? { check: current.check } : {}) };
    case 'changes-requested':
    case 'mention':
    case 'reply':
      return { ...pr, tab: 'feedback', ...(current?.threadId ? { threadId: current.threadId } : {}) };
    case 'review-requested':
    case 'team-review-requested':
    case 'rereview':
      return { ...pr, tab: 'changes', focus: 'unviewed-file' };
    case 'ready-to-merge':
      return { ...pr, focus: 'merge' };
    case 'approved':
    case 'snooze-ended':
      return pr;
    default:
      return current;
  }
}
