/**
 * "The app's windows": every window except auxiliary ones, such as the menu bar panel (#308).
 *
 * `BrowserWindow.getAllWindows()` includes the hidden panel. Code that means "the main window" (`[0]`), "create
 * one if none is open" (`length === 0`) or "every renderer that shows the app" (broadcasts) asks this helper
 * instead. No Electron import, so it is unit-tested; main passes `BrowserWindow.getAllWindows`.
 */
export interface AppWindowLike {
  isDestroyed(): boolean;
  isFocused(): boolean;
  once(event: 'closed', listener: () => void): unknown;
}

export function createAppWindows<W extends AppWindowLike>(all: () => readonly W[]) {
  const auxiliary = new WeakSet<W>();
  const list = (): W[] => all().filter((win) => !auxiliary.has(win) && !win.isDestroyed());
  return {
    /** The windows that show the app, oldest first. `list()[0]` is the main window. */
    list,
    /** Marks a window as not part of the app, such as the menu bar panel. */
    exclude(win: W) {
      auxiliary.add(win);
    },
    isAuxiliary: (win: W) => auxiliary.has(win),
    /** The focused app window. An auxiliary window with focus is not the app. */
    focused: (): W | undefined => list().find((win) => win.isFocused()),
    /**
     * Electron's `window-all-closed` waits for every window, the hidden panel included. Calls `onLast` when the
     * last app window closes while an auxiliary window still exists, so quitting on close keeps working.
     */
    watchClose(win: W, onLast: () => void) {
      win.once('closed', () => {
        if (list().length === 0 && all().some((other) => other !== win && !other.isDestroyed())) onLast();
      });
    },
  };
}
export type AppWindows<W extends AppWindowLike> = ReturnType<typeof createAppWindows<W>>;
