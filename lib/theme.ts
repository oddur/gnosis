// Theme controller. Decides whether to apply the .dark class to
// <html> based on a stored preference of 'light' | 'dark' | 'system'.
// 'system' follows the OS via prefers-color-scheme and updates live
// when the OS preference changes.
//
// The class itself is the only thing that toggles — every color
// in globals.css is keyed off `:root` (light) and `.dark` (dark).

export type ThemeChoice = 'light' | 'dark' | 'system';

const root = document.documentElement;

let mediaQuery: MediaQueryList | null = null;
let mediaListener: ((e: MediaQueryListEvent) => void) | null = null;
let currentChoice: ThemeChoice = 'dark';

function apply(isDark: boolean) {
  root.classList.toggle('dark', isDark);
}

function detachMediaListener() {
  if (mediaQuery && mediaListener) {
    mediaQuery.removeEventListener('change', mediaListener);
    mediaListener = null;
    mediaQuery = null;
  }
}

export function applyTheme(choice: ThemeChoice) {
  currentChoice = choice;
  detachMediaListener();

  if (choice === 'light') {
    apply(false);
    return;
  }
  if (choice === 'dark') {
    apply(true);
    return;
  }

  // system
  mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  apply(mediaQuery.matches);
  mediaListener = (e) => apply(e.matches);
  mediaQuery.addEventListener('change', mediaListener);
}

export function getCurrentTheme(): ThemeChoice {
  return currentChoice;
}
