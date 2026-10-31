import { useEffect, useRef } from 'react';

/** The app settings shortcut also works while typing, without leaving the current page. */
export function useSettingsShortcut(open: () => void, enabled = true) {
  const action = useRef(open);
  action.current = open;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.key !== ',' ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey
      )
        return;
      event.preventDefault();
      action.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
