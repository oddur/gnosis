import { BrowserWindow, ipcMain, type BrowserWindowConstructorOptions } from 'electron';

/** Height of the renderer's single title bar row (`--app-titlebar-height` in workspace-tabs.css). */
export const TITLEBAR_HEIGHT = 38;

// The row paints --sidebar; window controls use --foreground. Values match the workbench block in globals.css.
const OVERLAY = {
  light: { color: '#f4f5f8', symbolColor: '#242a35' },
  dark: { color: '#1c2028', symbolColor: '#e3e7ef' },
};

/** The overlay stops above the row's 1px bottom border so the divider stays continuous under the window controls. */
const overlay = (dark: boolean) => ({ ...OVERLAY[dark ? 'dark' : 'light'], height: TITLEBAR_HEIGHT - 1 });

/** Window options that move the native title bar into the renderer's tab row. */
export function windowChromeOptions(dark: boolean): BrowserWindowConstructorOptions {
  if (process.platform === 'darwin') {
    // Traffic lights centred in the row above its 1px border.
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 12 } };
  }
  return { titleBarStyle: 'hidden', titleBarOverlay: overlay(dark) };
}

/** Tell the renderer when macOS hides the traffic lights, so the row can reclaim their space. */
export function attachWindowChrome(window: BrowserWindow) {
  const send = () => {
    if (!window.isDestroyed()) window.webContents.send('window-full-screen', window.isFullScreen());
  };
  window.on('enter-full-screen', send);
  window.on('leave-full-screen', send);
}

export function registerWindowChromeIpc() {
  ipcMain.handle('window-full-screen', (event) => BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false);
  // Windows and Linux draw their caption buttons over the row; keep them in the renderer's theme.
  ipcMain.on('window-chrome-theme', (event, dark: unknown) => {
    if (process.platform === 'darwin' || typeof dark !== 'boolean') return;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return;
    try {
      window.setTitleBarOverlay(overlay(dark));
    } catch {
      // A window created without an overlay (for example a test window) has nothing to update.
    }
  });
}
