import type { ThemeRegistration } from 'shiki';

function rgb(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}
function hex(values: number[]): string {
  return '#' + values.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}
export function mixColor(base: string, tint: string, amount: number): string {
  const b = rgb(base);
  return hex(rgb(tint).map((v, i) => b[i] + (v - b[i]) * amount));
}
export function contrastRatio(a: string, b: string): number {
  const luminance = (color: string) => rgb(color).map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function diffSurfaces(background: string) {
  return {
    context: background,
    addition: mixColor(background, '#5ecc71', 0.10),
    deletion: mixColor(background, '#ff6762', 0.10),
    additionEmphasis: mixColor(background, '#5ecc71', 0.20),
    deletionEmphasis: mixColor(background, '#ff6762', 0.20),
  };
}
/** Preserve syntax hues, raising only colors that fail against our diff surfaces. */
export function readableCodeTheme(theme: ThemeRegistration, name = theme.name): ThemeRegistration {
  const background = theme.colors?.['editor.background'] ?? theme.bg ?? '#1e1e1e';
  const surfaces = Object.values(diffSurfaces(background));
  const readable = (color: string | undefined) => {
    if (!color || !/^#[\da-f]{6}([\da-f]{2})?$/i.test(color)) return color;
    // Some themes use translucent comments and punctuation. Flatten their
    // effective color before adjusting; otherwise alpha defeats the contrast floor.
    if (color.length === 9) color = mixColor(background, color.slice(0, 7), parseInt(color.slice(7), 16) / 255);
    for (let step = 0; step <= 100; step++) {
      const candidate = mixColor(color, '#ffffff', step / 100);
      if (surfaces.every((surface) => contrastRatio(candidate, surface) >= 4.8)) return candidate;
    }
    return '#ffffff';
  };
  return {
    ...theme, name,
    fg: readable(theme.fg),
    colors: {
      ...theme.colors,
      'editor.foreground': readable(theme.colors?.['editor.foreground'] ?? theme.fg) ?? '#ffffff',
      'gitDecoration.addedResourceForeground': readable(theme.colors?.['gitDecoration.addedResourceForeground'] ?? theme.colors?.['terminal.ansiGreen'] ?? '#5ecc71') ?? '#5ecc71',
      'gitDecoration.deletedResourceForeground': readable(theme.colors?.['gitDecoration.deletedResourceForeground'] ?? theme.colors?.['terminal.ansiRed'] ?? '#ff6762') ?? '#ff6762',
    },
    tokenColors: theme.tokenColors?.map((token) => ({
      ...token, settings: { ...token.settings, foreground: readable(token.settings.foreground) },
    })),
  };
}
