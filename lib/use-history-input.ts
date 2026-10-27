import { useEffect, useRef } from 'react';
import { historyKeyDirection, type HistoryDirection } from './navigation-history';

/** Extra mouse buttons on macOS; native app commands on Windows/Linux; driver keyboard mappings. */
export function useHistoryInput(navigate: (direction: HistoryDirection) => void) {
  const latest = useRef(navigate);
  latest.current = navigate;
  useEffect(() => {
    const move = (direction: HistoryDirection) => {
      // Do not leave a review submission or another modal with unsaved input.
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"], [role="menu"]')) return;
      latest.current(direction);
    };
    const mouse = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      event.stopPropagation();
      // Consume the entire gesture; navigate only on release, once.
      // Windows/Linux route these through app-command. Do not handle both paths.
      if (event.type === 'mouseup' && window.electronAPI.platform === 'darwin') move(event.button === 3 ? -1 : 1);
    };
    const key = (event: KeyboardEvent) => {
      const direction = historyKeyDirection(event, window.electronAPI.platform);
      if (!direction || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) move(direction);
    };
    for (const type of ['mousedown', 'mouseup', 'auxclick'] as const) window.addEventListener(type, mouse, true);
    window.addEventListener('keydown', key, true);
    const unsubscribe = window.electronAPI.onHistoryNavigate(move);
    return () => {
      for (const type of ['mousedown', 'mouseup', 'auxclick'] as const) window.removeEventListener(type, mouse, true);
      window.removeEventListener('keydown', key, true);
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, []);
}
