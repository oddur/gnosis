/**
 * The conflict workspace's keys: its keyboard help and the keyboard shortcut overlay list the same ones. The Keep
 * labels name the base branch as the buttons do ("Keep main's change"); the overlay, with no PR open, says "the base
 * branch".
 */
export const conflictShortcuts = (base?: string): { keys: string; label: string }[] => [
  { keys: 'j  k', label: 'Next / previous conflict' },
  { keys: '1  2  3', label: `Keep PR change / ${base ? `${base}’s` : 'base branch’s'} change / both` },
  { keys: 'm', label: 'Mark file reviewed and open the next file' },
  { keys: 'n  p', label: 'Next / previous file' },
];
export const CONFLICT_SHORTCUTS = conflictShortcuts();
