import type { KeyboardEvent } from 'react';
import { isReviewAndPushKey } from './conflict-shortcuts';

/**
 * Keys on a button that pushes (#489): only a click, or Cmd+Enter (Ctrl+Enter off macOS) while it has focus. Enter or
 * Space on it does nothing, and the surrounding form or card never sees the key, so no plain key press can push.
 * Use it for both onKeyDown and onKeyUp: Space clicks on key up.
 */
export function pushButtonKey(event: KeyboardEvent<HTMLElement>, mac: boolean, press: () => void) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  event.stopPropagation();
  if (event.type === 'keydown' && !event.repeat && isReviewAndPushKey(event, mac)) press();
}
