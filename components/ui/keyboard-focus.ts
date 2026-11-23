/**
 * Radix opens a tooltip on any focus, including focus the app moves: a dialog or menu returning it, a closed tab
 * handing it on, or the window getting it back on activation. Only focus the keyboard moved opens one, that is focus
 * after Tab, Shift+Tab or an arrow-style key. A shortcut (Cmd+W, Cmd+1), Escape, Enter, a press or leaving the window
 * resets it. One set of window listeners serves every tooltip.
 */
const navigationKeys = new Set([
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);
let keyboardNavigation = false;
if (typeof window !== 'undefined') {
  window.addEventListener(
    'keydown',
    (event) => {
      keyboardNavigation = navigationKeys.has(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey;
    },
    { capture: true, passive: true }
  );
  window.addEventListener('pointerdown', () => (keyboardNavigation = false), { capture: true, passive: true });
  window.addEventListener('blur', () => (keyboardNavigation = false));
}

/** Whether focus arriving now was moved by the keyboard. */
export const focusFromKeyboard = () => keyboardNavigation;

/**
 * Moves focus to a tooltip's trigger and shows its tooltip, for an action that asks to show it, such as "All keys".
 * A trigger that already has focus gets it again, so its tooltip opens all the same.
 */
export function focusWithTooltip(element: HTMLElement | null | undefined) {
  if (!element) return;
  const previous = keyboardNavigation;
  keyboardNavigation = true;
  try {
    if (document.activeElement === element) element.blur();
    element.focus();
  } finally {
    keyboardNavigation = previous;
  }
}
