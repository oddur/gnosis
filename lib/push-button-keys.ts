import type { KeyboardEvent } from 'react';

/**
 * Keys on a button that pushes (#489): only a click, or Cmd+Enter (Ctrl+Enter off macOS) while it has focus. Enter or
 * Space on it does nothing, and the surrounding form or card never sees the key, so no plain key press can push.
 * Use it for both onKeyDown and onKeyUp: Space clicks on key up.
 */
export function pushButtonKey(event: KeyboardEvent<HTMLElement>, mac: boolean, press: () => void) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  event.stopPropagation();
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (event.type === 'keydown' && event.key === 'Enter' && mod && !event.repeat && !event.altKey && !event.shiftKey)
    press();
}
