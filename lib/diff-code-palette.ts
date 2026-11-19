import { getResolvedOrResolveTheme } from '@pierre/diffs';
import { DIFF_HIGHLIGHTER } from './diff-highlighter';
import { codePalette, codePaletteCSS, type PaletteTheme } from './code-palette';

const written = new Set<string>();
let sheet: HTMLStyleElement | undefined;

/**
 * Writes the code palette of `theme`, the diff's syntax theme, once per theme: one rule that only the gap bars match,
 * so it restyles nothing else, whenever it lands. Until it does, the bars use the fallbacks in globals.css.
 */
export function applyCodePalette(theme: string | undefined) {
  if (!theme || written.has(theme) || typeof document === 'undefined') return;
  written.add(theme);
  const write = (resolved: PaletteTheme) => {
    if (!sheet) {
      sheet = document.createElement('style');
      sheet.setAttribute('data-diff-code-palette', '');
    }
    if (!sheet.isConnected) document.head.append(sheet);
    sheet.append(codePaletteCSS(theme, codePalette(resolved)) + '\n');
  };
  try {
    const resolved = getResolvedOrResolveTheme(theme, DIFF_HIGHLIGHTER) as PaletteTheme | Promise<PaletteTheme>;
    if (resolved instanceof Promise) resolved.then(write, () => written.delete(theme));
    else write(resolved);
  } catch {
    written.delete(theme);
  }
}
