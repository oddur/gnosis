/**
 * Where the menu bar panel opens (#308 section 7.2). Pure, so the maths for several displays, the notch and
 * small screens is unit-tested.
 *
 * Use the `bounds` from the tray `click` event, not `tray.getBounds()`: with "Displays have separate Spaces"
 * every display has its own status item, and the event bounds are those of the item that was clicked. Main
 * picks the display with `screen.getDisplayMatching(bounds)` and passes its work area. The menu bar is taller
 * on a notched display; its work area starts below it, so `workArea.y` handles the notch.
 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const PANEL_WIDTH = 360;
export const PANEL_MAX_HEIGHT = 560;
/** Space between the panel and the screen edges. */
export const PANEL_MARGIN = 8;
/** Space between the menu bar and the panel. */
export const PANEL_GAP = 4;

/** The panel height for a measured content height: at most 560, and never taller than the work area allows. */
export function panelHeight(content: number, workArea: Rect): number {
  const cap = Math.min(PANEL_MAX_HEIGHT, workArea.height - 2 * PANEL_MARGIN);
  const value = Number.isFinite(content) ? Math.ceil(content) : cap;
  return Math.max(1, Math.min(cap, value));
}

/** Centred under the status item, clamped inside the work area of the display it is on. */
export function panelPosition(tray: Rect, workArea: Rect, size: { width: number; height: number } = { width: PANEL_WIDTH, height: PANEL_MAX_HEIGHT }): Rect {
  const width = Math.min(size.width, workArea.width - 2 * PANEL_MARGIN);
  const minX = workArea.x + PANEL_MARGIN;
  const maxX = workArea.x + workArea.width - PANEL_MARGIN - width;
  const centred = tray.x + tray.width / 2 - width / 2;
  const x = Math.round(Math.min(Math.max(centred, minX), maxX));
  const y = Math.round(Math.max(tray.y + tray.height, workArea.y) + PANEL_GAP);
  // Never below the bottom of the work area, such as above the Dock on a small display.
  const height = Math.max(1, Math.min(panelHeight(size.height, workArea), workArea.y + workArea.height - PANEL_MARGIN - y));
  return { x, y, width, height };
}
