/**
 * The menu bar panel window (#308 section 7.2): a frameless macOS `panel` with popover vibrancy, positioned under
 * the clicked status item. Created hidden and never destroyed while the tray exists, so a click only positions
 * and shows it.
 *
 * Security: its own sandboxed preload (`window.gnosisMenubar`), no navigation, no new windows, no webviews. Every
 * `menubar:*` handler checks that the sender is this panel's main frame. The renderer sends row ids only.
 */
import { BrowserWindow, ipcMain, screen, type IpcMainEvent, type IpcMainInvokeEvent, type Rectangle } from 'electron';
import { createPanelVisibility, type PanelHideReason } from '../lib/menubar-panel-state';
import { panelPosition, PANEL_MAX_HEIGHT, PANEL_WIDTH } from '../lib/menubar-position';
import type { MenubarState } from '../lib/menubar-state';

export interface MenubarPanelDeps {
  preload: string;
  /** Loads the panel page: the dev server or the packaged file. */
  load: (win: BrowserWindow) => Promise<void>;
  /** The last state built, for `menubar:get`. */
  state: () => MenubarState | undefined;
  /** A row was chosen: resolve the id against the last state and open its target. */
  open: (id: string) => void;
  openApp: () => void;
  openSettings: () => void;
  /** ↻ or ⌘R: an interactive refresh. */
  refresh: () => Promise<void>;
  /** The panel was shown or hidden: rebuild the state, read status on open, wake sync. */
  visibilityChanged: (visible: boolean) => void;
  /** A new panel window, so main can leave it out of the app's windows. */
  created: (win: BrowserWindow) => void;
  devTools: boolean;
}

export function createMenubarPanel(deps: MenubarPanelDeps) {
  let win: BrowserWindow | undefined;
  let anchor: Rectangle | undefined;
  let contentHeight = PANEL_MAX_HEIGHT;
  const visibility = createPanelVisibility();
  const painted = new WeakSet<BrowserWindow>();
  const live = () => (win && !win.isDestroyed() ? win : undefined);
  const own = (event: IpcMainEvent | IpcMainInvokeEvent) => {
    const panel = live();
    return !!panel && event.sender === panel.webContents && event.senderFrame === event.sender.mainFrame;
  };
  const displayChanged = () => hide('display');

  function create(): BrowserWindow {
    const mac = process.platform === 'darwin';
    const panel = new BrowserWindow({
      width: PANEL_WIDTH,
      height: 420,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: true,
      roundedCorners: true,
      // Verified in Electron 41 (#308 spike): `panel` takes key focus without bringing the main window forward,
      // `popover` vibrancy draws the system material, and a frameless window keeps the native corners and shadow.
      ...(mac ? { type: 'panel', vibrancy: 'popover' as const, visualEffectState: 'active' as const, hiddenInMissionControl: true } : {}),
      backgroundColor: '#00000000',
      webPreferences: {
        preload: deps.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        backgroundThrottling: false,
        devTools: deps.devTools,
        spellcheck: false,
      },
    });
    deps.created(panel);
    panel.once('ready-to-show', () => painted.add(panel));
    if (mac) panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    const contents = panel.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
    panel.on('blur', () => {
      if (visibility.hidesOnBlur(contents.isDevToolsOpened())) hide('blur');
    });
    panel.on('closed', () => {
      screen.removeListener('display-metrics-changed', displayChanged);
      screen.removeListener('display-removed', displayChanged);
      if (win === panel) win = undefined;
      if (visibility.hidden('other')) deps.visibilityChanged(false);
    });
    screen.on('display-metrics-changed', displayChanged);
    screen.on('display-removed', displayChanged);
    void deps.load(panel).catch((error: unknown) => console.error('[menubar] Panel failed to load:', error));
    return panel;
  }

  function ensure(): BrowserWindow {
    return live() ?? (win = create());
  }

  function place() {
    const panel = live();
    if (!panel || !anchor) return;
    const display = screen.getDisplayMatching(anchor);
    panel.setBounds(panelPosition(anchor, display.workArea, { width: PANEL_WIDTH, height: contentHeight }));
  }

  function reveal(panel: BrowserWindow) {
    place();
    panel.show();
    panel.focus();
    panel.webContents.send('menubar:shown');
  }
  function show(bounds: Rectangle) {
    const panel = ensure();
    anchor = bounds;
    visibility.shown();
    deps.visibilityChanged(true);
    // A window created by this click shows after its first paint, never as an empty frame.
    if (painted.has(panel)) reveal(panel);
    else
      panel.once('ready-to-show', () => {
        if (visibility.visible && live() === panel) reveal(panel);
      });
  }

  function hide(reason: PanelHideReason) {
    const panel = live();
    if (!panel || !visibility.hidden(reason)) return;
    panel.hide();
    deps.visibilityChanged(false);
  }

  ipcMain.handle('menubar:get', (event) => (own(event) ? (deps.state() ?? null) : null));
  ipcMain.handle('menubar:refresh', async (event) => {
    if (own(event)) await deps.refresh();
  });
  ipcMain.on('menubar:open', (event, id: unknown) => {
    if (!own(event) || typeof id !== 'string' || id.length > 2048) return;
    hide('open');
    deps.open(id);
  });
  ipcMain.on('menubar:open-app', (event) => {
    if (!own(event)) return;
    hide('open');
    deps.openApp();
  });
  ipcMain.on('menubar:open-settings', (event) => {
    if (!own(event)) return;
    hide('open');
    deps.openSettings();
  });
  ipcMain.on('menubar:close', (event) => {
    if (own(event)) hide('escape');
  });
  ipcMain.on('menubar:resize', (event, height: unknown) => {
    if (!own(event) || typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return;
    contentHeight = Math.min(height, PANEL_MAX_HEIGHT);
    if (visibility.visible) place();
  });

  return {
    /** Creates the hidden window if it does not exist yet. */
    ensure,
    /** A left click on the status item, with the bounds of the item that was clicked. */
    toggle(bounds: Rectangle) {
      const action = visibility.click();
      if (action === 'show') show(bounds);
      else if (action === 'hide') hide('click');
    },
    hide: () => hide('other'),
    /** Sends a new state to the panel; it also reads `menubar:get` when it loads. */
    push(state: MenubarState) {
      const panel = live();
      if (panel && !panel.webContents.isLoading()) panel.webContents.send('menubar:state', state);
    },
    visible: () => visibility.visible,
    window: live,
    /** Turning the menu bar icon off destroys the panel; turning it on creates it again. */
    destroy() {
      live()?.destroy();
    },
  };
}
export type MenubarPanel = ReturnType<typeof createMenubarPanel>;
