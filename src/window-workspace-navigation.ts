import type { BrowserWindow } from 'electron';
import { workspaceShortcut } from '../lib/workspace-tabs';
/** Prevent native Close Window from consuming Cmd/Ctrl+W before the tab strip. */
export function attachWorkspaceShortcuts(window: BrowserWindow) {
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const action = workspaceShortcut({
      key: input.key,
      ctrlKey: input.control,
      metaKey: input.meta,
      altKey: input.alt,
      shiftKey: input.shift,
      isComposing: input.isComposing,
      repeat: input.isAutoRepeat,
    });
    if (action === undefined) return;
    event.preventDefault();
    window.webContents.send('workspace-shortcut', action);
  });
}
