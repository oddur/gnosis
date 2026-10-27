import type { BrowserWindow } from 'electron';
import type { HistoryDirection } from '../lib/navigation-history';

/** Route desktop navigation commands to the renderer's app history. */
export function attachWindowHistoryNavigation(window: BrowserWindow, navigate: (direction: HistoryDirection) => void) {
  window.on('app-command', (event, command) => {
    if (command !== 'browser-backward' && command !== 'browser-forward') return;
    event.preventDefault();
    navigate(command === 'browser-backward' ? -1 : 1);
  });
  // Logitech's macOS Back/Forward presets emit native swipe gestures, not
  // DOM mouse buttons. Electron and Chrome map left to Back, right to Forward.
  window.on('swipe', (event, direction) => {
    if (direction !== 'left' && direction !== 'right') return;
    event.preventDefault();
    navigate(direction === 'left' ? -1 : 1);
  });
}
