import { useEffect, useMemo } from 'react';
import { DIFF_LAYOUT_KEYS, diffLayoutShortcutMap, nextDiffLayout, type DiffLayoutView } from './diff-layout';
import { DIFF_LAYOUT_EVENT } from './use-diff-layout';
import { useKeyboardShortcuts } from './use-keyboard-shortcuts';
import { activeWorkspaceRoot, hasVisibleModal } from './workspace-navigation';
import { useCommandCenter, type AppCommand } from './command-center';
import { workspaceSections } from './interface-icons';

/** The diff view on screen in the active tab, if any. Views mark their root with `data-diff-layout`. */
function visibleView(): DiffLayoutView | undefined {
  const element = [...activeWorkspaceRoot().querySelectorAll<HTMLElement>('[data-diff-layout]')].find((element) =>
    element.checkVisibility()
  );
  if (!element) return undefined;
  return {
    layout: element.dataset.diffLayout === 'split' ? 'split' : 'unified',
    choose: (layout) => element.dispatchEvent(new CustomEvent(DIFF_LAYOUT_EVENT, { detail: layout })),
  };
}

/** Our dialogs are Radix dialogs, which do not set aria-modal, so also look for their content. Focus normally
 * sits inside an open dialog, which already blocks shortcuts; this covers focus left on the page behind it. */
function modalOpen() {
  return (
    hasVisibleModal() ||
    [...document.querySelectorAll<HTMLElement>('[data-slot="dialog-content"]')].some((element) =>
      element.checkVisibility()
    )
  );
}

/** `d`, `u` and `s` wherever a diff is on screen, and matching commands in the command palette. */
export function useDiffLayoutShortcuts() {
  const center = useCommandCenter();
  const shortcuts = useMemo(() => diffLayoutShortcutMap(visibleView, modalOpen), []);
  // Changes stops keys from bubbling out of its workspace, so listen before it.
  useKeyboardShortcuts(shortcuts, { capture: true });
  useEffect(
    () =>
      center?.register('diff-layout', (): AppCommand[] => {
        const view = visibleView();
        if (!view) return [];
        const command = (key: string, label: string, keywords: string): AppCommand => ({
          id: `diff-layout:${key}`,
          icon: workspaceSections.changes.icon,
          label,
          hint: key,
          group: 'Diff',
          keywords,
          perform: () => {
            const layout = nextDiffLayout(key, view.layout);
            if (layout) view.choose(layout);
          },
        });
        return [
          command(
            DIFF_LAYOUT_KEYS.toggle,
            'Switch between split and unified diff',
            'toggle diff layout split unified side by side inline'
          ),
          command(DIFF_LAYOUT_KEYS.unified, 'Switch to unified diff', 'diff layout combine inline'),
          command(DIFF_LAYOUT_KEYS.split, 'Switch to split diff', 'diff layout side by side'),
        ];
      }),
    [center]
  );
}
