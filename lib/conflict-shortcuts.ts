import type { CompareWith } from './conflict-diff';

/** True on macOS, where Cmd is the push modifier; false in Node tests. */
export const mac = typeof window !== 'undefined' && window.electronAPI.platform === 'darwin';

/** The conflict workspace's keys: its keyboard help and the keyboard shortcut overlay list the same ones. */
export const CONFLICT_SHORTCUTS: { keys: string; label: string }[] = [
  { keys: 'j  k', label: 'Next / previous conflict' },
  { keys: 'a', label: 'Accept the proposal and go to the next conflict that needs you' },
  { keys: '1  2  3', label: 'Keep PR change / base change / both' },
  { keys: 'u', label: 'Undo: right after A, that accept; otherwise the choice on this conflict' },
  { keys: 'v', label: 'Compare with PR, base or both' },
  { keys: 'g', label: 'Show me every merged conflict' },
  { keys: 'm', label: 'Mark file reviewed and open the next file' },
  { keys: 'n  p', label: 'Next / previous file' },
  { keys: mac ? '⌘ ↵' : 'Ctrl ↵', label: 'Review and push… Opens the confirmation; never pushes' },
  { keys: 'Esc', label: 'Close the Conflicts view' },
];

/** Cmd+Enter on macOS, Ctrl+Enter elsewhere, and no other modifier: Review and push…, and a focused Push button. */
export const isReviewAndPushKey = (
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  onMac: boolean
) =>
  event.key === 'Enter' &&
  !event.altKey &&
  !event.shiftKey &&
  (onMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);

const SPOKEN: Record<string, string> = { '⌘': 'Command', '↵': 'Enter' };
/** A key as a screen reader should say it: ⌘ is Command, ↵ is Enter. */
export const spokenKey = (key: string) => SPOKEN[key] ?? key;
/** A legend's keys as words, for the glyphs' text alternative. */
export const spokenKeys = (keys: string) => keys.split(/\s+/).map(spokenKey).join(' ');
/** The keys hold a glyph a screen reader can't name. */
export const hasGlyph = (keys: string) => keys.split(/\s+/).some((key) => key in SPOKEN);

/**
 * Where Accept sends focus (#445 item 13): the next conflict after `from` that still needs you, wrapping round, never
 * `from` itself nor a conflict whose proposal you already accepted. Undefined when none is left: the next action has it.
 */
export function nextNeedingYou(
  pending: readonly number[],
  from: number,
  accepted: ReadonlySet<number>
): number | undefined {
  const left = pending.filter((index) => index !== from && !accepted.has(index));
  return left.find((index) => index > from) ?? left[0];
}

/** V's order: PR, then main, then both. Both is skipped while no conflict is left to compare side by side. */
export function nextCompare(current: CompareWith, bothDisabled: boolean): CompareWith {
  if (current === 'pr') return 'main';
  if (current === 'main' && !bothDisabled) return 'both';
  return 'pr';
}
