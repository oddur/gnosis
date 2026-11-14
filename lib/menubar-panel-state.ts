/**
 * Show and hide decisions for the menu bar panel (#308 section 7.2). Pure, so the blur race is unit-tested.
 *
 * Clicking the status item while the panel is open first blurs the panel, which hides it, and then delivers the
 * click, which would open it again. The time of a blur hide is recorded, and a click within 250 ms is ignored.
 */
export const BLUR_GUARD_MS = 250;
export type PanelHideReason = 'blur' | 'escape' | 'click' | 'open' | 'display' | 'other';

export function createPanelVisibility(now: () => number = Date.now) {
  let visible = false;
  let blurHiddenAt = -Infinity;
  return {
    get visible() {
      return visible;
    },
    /** What a click on the status item does now. */
    click(): 'show' | 'hide' | 'ignore' {
      if (visible) return 'hide';
      return now() - blurHiddenAt < BLUR_GUARD_MS ? 'ignore' : 'show';
    },
    shown() {
      visible = true;
    },
    /** Returns false when the panel was already hidden. */
    hidden(reason: PanelHideReason): boolean {
      if (!visible) return false;
      visible = false;
      if (reason === 'blur') blurHiddenAt = now();
      return true;
    },
    /** A blur hides the panel, except while its DevTools are open. */
    hidesOnBlur: (devToolsOpen: boolean) => visible && !devToolsOpen,
  };
}
export type PanelVisibility = ReturnType<typeof createPanelVisibility>;
