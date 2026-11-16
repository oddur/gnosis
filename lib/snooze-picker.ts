/**
 * The one Snooze picker, opened from the row menu, `Z`, the PR header, the bulk menu and the command palette.
 * A small external store: any surface asks for it, and the host mounted once in the app shows it.
 */
import type { ReviewMember } from './workbench';

export type SnoozeTarget = Pick<ReviewMember, 'url' | 'number' | 'title' | 'author' | 'state' | 'merged' | 'requestedReviewers'>;
export interface SnoozePickerRequest {
  /** Each group is snoozed together and wakes together: one stack, or one PR. */
  groups: SnoozeTarget[][];
  /** Runs after the snooze is saved, with the snoozed URLs. The queue moves focus to the next row here. */
  onSnoozed?: (urls: string[]) => void;
}

let current: SnoozePickerRequest | null = null;
let account: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export const snoozePicker = {
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  current: () => current,
  account: () => account,
};
/** Open PRs only: a merged or closed PR has nothing to snooze. Returns false when nothing can be snoozed. */
export function openSnoozePicker(request: SnoozePickerRequest): boolean {
  const groups = request.groups.map((group) => group.filter((member) => member.state === 'open' && !member.merged)).filter((group) => group.length);
  if (!groups.length) return false;
  current = { ...request, groups };
  emit();
  return true;
}
export function closeSnoozePicker() {
  current = null;
  emit();
}
/** The signed-in GitHub login, so the picker knows which PRs are yours. */
export function setSnoozeAccount(login: string | null) {
  account = login;
}
export const canSnooze = (members: readonly Pick<ReviewMember, 'state' | 'merged' | 'url'>[]) =>
  members.some((member) => member.state === 'open' && !member.merged && member.url.startsWith('https://github.com/'));
