import { CODE_FONTS } from './constants';

// Every code font ships with the app (src/fonts.css, src/code-fonts.css); nothing loads from a CDN. A bundled face
// downloads only when its family is first used, so choosing a font is all this needs to do.
export function applyCodeFont(fontId: string) {
  const font = CODE_FONTS.find((f) => f.id === fontId);
  if (font) {
    document.documentElement.style.setProperty(
      '--font-mono',
      `${font.family}, 'JetBrains Mono', ui-monospace, monospace`
    );
  }
}
