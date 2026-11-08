import { createContext, useContext } from 'react';
import type { WorkspaceTarget } from './workspace-tabs';
export const WorkspaceNavigation = createContext<{
  open: (target?: WorkspaceTarget, background?: boolean, title?: string) => void;
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
