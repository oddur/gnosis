import { registerCustomTheme, getHighlighterType } from '@pierre/diffs';
import { bundledThemes } from 'shiki/themes';
import { themes as highlightsThemes } from '@pierre/highlights/themes/loader';
import { readableHighlightsTheme } from './highlights-theme';
import { resolveDiffHighlighter } from './diff-highlighter-preference';
import type { Preferences } from './types';
import { CODE_THEMES } from './constants';
import { readableCodeTheme } from './code-contrast';

// Configure before mounting any diffs: Pierre permits one backend per thread.
export const DEFAULT_DIFF_HIGHLIGHTER = resolveDiffHighlighter(import.meta.env.VITE_GNOSIS_HIGHLIGHTER);
export let DIFF_HIGHLIGHTER = DEFAULT_DIFF_HIGHLIGHTER;

export function initializeDiffHighlighter(preferences?: Pick<Preferences, 'diffHighlighter'>) {
  const next = resolveDiffHighlighter(preferences?.diffHighlighter, DEFAULT_DIFF_HIGHLIGHTER);
  const active = getHighlighterType();
  if (active && active !== next) throw new Error('Restart Gnosis to change syntax highlighting.');
  DIFF_HIGHLIGHTER = next;
}

for (const { id } of CODE_THEMES) {
  registerCustomTheme(`gnosis-${id}`, async () => {
    const { default: theme } = await bundledThemes[id]();
    return readableCodeTheme(theme, `gnosis-${id}`);
  });
  registerCustomTheme(
    `gnosis-${id}`,
    async () => {
      const { default: theme } = await highlightsThemes[id]();
      return readableHighlightsTheme(theme, `gnosis-${id}`);
    },
    'zed'
  );
}
