import { CODE_FONTS } from './constants';

// Default faces ship locally. Fetch optional code families only when selected.
const optionalFontStyles: Record<string, string[]> = {
  'fira-code': ['https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600;700&display=swap'],
  hack: ['https://cdn.jsdelivr.net/npm/hack-font@3/build/web/hack.css'],
  'monaspace-neon': [
    'https://cdn.jsdelivr.net/npm/@fontsource/monaspace-neon@5/400.css',
    'https://cdn.jsdelivr.net/npm/@fontsource/monaspace-neon@5/700.css',
  ],
  iosevka: [
    'https://cdn.jsdelivr.net/npm/@fontsource/iosevka@5/400.css',
    'https://cdn.jsdelivr.net/npm/@fontsource/iosevka@5/700.css',
  ],
};

export function applyCodeFont(fontId: string) {
  const font = CODE_FONTS.find((f) => f.id === fontId);
  if (font) {
    for (const [index, href] of (optionalFontStyles[font.id] ?? []).entries()) {
      const id = `code-font-${font.id}-${index}`;
      if (document.getElementById(id)) continue;
      const link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      link.href = href;
      document.head.append(link);
    }
    document.documentElement.style.setProperty(
      '--font-mono',
      `${font.family}, 'JetBrains Mono', ui-monospace, monospace`
    );
  }
}
