import { createContext, useContext } from 'react';
import type { WorkspaceTarget } from './workspace-tabs';
export const WorkspaceNavigation = createContext<{
  open: (target?: WorkspaceTarget, background?: boolean, title?: string) => void;
  /**
   * Opens a place the way a notification click does: the tab already showing the PR, else a new tab. The Overview's
   * rows use it (#390).
   */
  openTarget?: (target: import('./deep-link').DeepLinkTarget) => Promise<void>;
  /**
   * Activates another tab that shows the Overview, if there is one, and says whether it did. The sidebar's Overview
   * uses it, so a second Overview tab is only made on purpose (Cmd-click, middle-click, a new tab).
   */
  focusOverview?: () => boolean;
} | null>(null);
export const useWorkspaceNavigation = () => useContext(WorkspaceNavigation);
/** Dialogs protect a pending submission or edit from accidental tab shortcuts. */
export function hasVisibleModal() {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"], [role="alertdialog"]')].some(
    (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
  );
}
export function activeWorkspaceRoot(): ParentNode {
  return document.querySelector('[data-workspace-active="true"]') ?? document;
}

/** Popovers and menus own Escape and review-navigation keys, even when they are not modal. */
export function hasVisibleNavigationOverlay() {
  return [
    ...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [role="menu"], .workbench-help'),
  ].some((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
}
