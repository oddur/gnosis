import { useEffect, useMemo } from 'react';
import { DEFAULT_DIFF_APPEARANCE, noiseFilterOf, toggledQuietChanges, type QuietToggles } from './review-diff';
import { noiseFilterOn } from './semantic-noise';
import { publishDiffAppearance, currentDiffAppearance } from './use-diff-appearance';
import { keepDiffLineInView } from './diff-layout';
import { useKeyboardShortcuts } from './use-keyboard-shortcuts';
import { activeWorkspaceRoot, hasVisibleModal } from './workspace-navigation';
import { useCommandCenter, type AppCommand } from './command-center';
import { workspaceSections } from './interface-icons';
import { toast } from '../components/ui/toast';

/**
 * Quiet changes (#396), across every diff: the toggles of Diff appearance, and `w`, which shows or hides them all
 * at once. `w` is free in every view's keymap today and in the one #406 proposes for diffs; it reads as "whitespace".
 */
export const QUIET_CHANGES_KEY = 'w';

/** What `w` turned off, so the next `w` brings back the reader's own choice rather than the defaults. */
let remembered: QuietToggles | undefined;

/**
 * Keeps the reader's line where it is while quiet changes collapse or open above it: the file diff that holds the top
 * of the view keeps its first visible line in place (lib/diff-layout.ts).
 */
export function anchorReader() {
  for (const scroller of activeWorkspaceRoot().querySelectorAll<HTMLElement>('.commit-diff-stream, [data-diff-scroller]')) {
    if (!scroller.checkVisibility()) continue;
    const top = scroller.getBoundingClientRect().top;
    const file = [...scroller.querySelectorAll<HTMLElement>('.changes-diff')].find((element) => {
      const box = element.getBoundingClientRect();
      return box.top < top && box.bottom > top;
    });
    if (file) keepDiffLineInView(file);
  }
}

/** Saves the toggles with the rest of Diff appearance, and shows them in every open diff at once. */
export function saveQuietChanges(next: QuietToggles) {
  const appearance = currentDiffAppearance();
  anchorReader();
  publishDiffAppearance({ ...appearance, ...next });
  void window.electronAPI
    .loadPreferences()
    .then((preferences) =>
      window.electronAPI.savePreferences({ ...preferences, diffAppearance: { ...DEFAULT_DIFF_APPEARANCE, ...preferences.diffAppearance, ...appearance, ...next } })
    )
    .catch(() => toast.add({ title: 'Could not save quiet changes', description: 'Open diffs use them until you close Gnosis.' }));
}

/** The diff view on screen in the active tab: views mark their root with `data-diff-layout`. */
const diffOnScreen = () =>
  [...activeWorkspaceRoot().querySelectorAll<HTMLElement>('[data-diff-layout]')].some((element) => element.checkVisibility());

function toggle() {
  const appearance = currentDiffAppearance();
  const next = toggledQuietChanges(appearance, remembered);
  const filter = noiseFilterOf(appearance);
  if (noiseFilterOn(filter))
    remembered = { hideWhitespace: filter.whitespace, hideFormatting: filter.formatting, hideComments: filter.comments, hideImports: filter.imports };
  saveQuietChanges(next);
  const on = noiseFilterOn(noiseFilterOf(next));
  toast.add({ title: on ? 'Quiet changes hidden' : 'Quiet changes shown', description: `Press ${QUIET_CHANGES_KEY} to ${on ? 'show' : 'hide'} them.` });
}

/** `w` wherever a diff is on screen, and the same in the command palette. */
export function useQuietChangesShortcut() {
  const center = useCommandCenter();
  const shortcuts = useMemo(
    () => ({
      [QUIET_CHANGES_KEY]: (event: KeyboardEvent) => {
        if (event.repeat || hasVisibleModal() || !diffOnScreen()) return false;
        toggle();
      },
    }),
    []
  );
  // Changes stops keys from bubbling out of its workspace, so listen before it.
  useKeyboardShortcuts(shortcuts, { capture: true });
  useEffect(
    () =>
      center?.register('quiet-changes', (): AppCommand[] =>
        diffOnScreen()
          ? [
              {
                id: 'quiet-changes:toggle',
                icon: workspaceSections.changes.icon,
                label: 'Show or hide quiet changes',
                hint: QUIET_CHANGES_KEY,
                group: 'Diff',
                keywords: 'whitespace formatting comments imports noise quiet hide filter',
                perform: toggle,
              },
            ]
          : []
      ),
    [center]
  );
}
