import { registerCustomTheme, type HighlighterTypes } from '@pierre/diffs';
import { bundledThemes } from 'shiki/themes';
import { themes as highlightsThemes } from '@pierre/highlights/themes/loader';
import { readableHighlightsTheme } from './highlights-theme';
import { CODE_THEMES } from './constants';
import { readableCodeTheme } from './code-contrast';

// Trial switch is fixed for the renderer lifetime: Pierre permits one backend per thread.
export const DIFF_HIGHLIGHTER: HighlighterTypes =
  import.meta.env.VITE_GNOSIS_HIGHLIGHTER === 'highlights' ? 'highlights' : 'shiki-js';

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
