import { contrastRatio, mixColor } from './code-contrast';

/**
 * The code surface's own colours, from the syntax theme the diff renders with, for the parts of Changes that sit in
 * the code rather than around it: a hunk's header is code-tier, on the code's background, with kind words such as
 * `fn` and `class` in the theme's keyword colour.
 */
export interface CodePalette {
  background: string;
  foreground: string;
  /** Secondary text, such as separators and line ranges: as quiet as stays readable (MUTED_CONTRAST). */
  muted: string;
  /** The colour the theme gives the `keyword` scope; undefined when it gives none. */
  keyword?: string;
}

/** A resolved theme as Pierre holds it: TextMate settings for Shiki, a Zed style for Highlights. */
export interface PaletteTheme {
  bg: string;
  fg: string;
  textmate?: { settings?: readonly TextMateRule[]; tokenColors?: readonly TextMateRule[] };
  zed?: { style?: { syntax?: Record<string, string | { color?: string | null } | undefined> } };
}
interface TextMateRule {
  scope?: string | readonly string[];
  settings?: { foreground?: string };
}

/** Scopes asked for in order: the bare keyword scope, then what TextMate grammars call `function` and `class`. */
const KEYWORD_SCOPES = ['keyword', 'keyword.control', 'storage.type', 'storage'];

/**
 * Muted text keeps this contrast with the background: above WCAG's 4.5:1, so it still passes on a header raised a step
 * toward the foreground.
 */
export const MUTED_CONTRAST = 5;

export function codePalette(theme: PaletteTheme): CodePalette {
  return {
    background: theme.bg,
    foreground: theme.fg,
    muted: mutedColor(theme.bg, theme.fg),
    keyword: keywordColor(theme),
  };
}

/** The foreground mixed up to 40% toward the background: less where the theme's own contrast is low. */
function mutedColor(background: string, foreground: string): string {
  const hex = /^#[\da-f]{6}$/i;
  if (!hex.test(background) || !hex.test(foreground)) return foreground;
  for (let step = 20; step > 0; step--) {
    const candidate = mixColor(foreground, background, step / 50);
    if (contrastRatio(candidate, background) >= MUTED_CONTRAST) return candidate;
  }
  return foreground;
}

function keywordColor(theme: PaletteTheme): string | undefined {
  const syntax = theme.zed?.style?.syntax;
  if (syntax) {
    for (const scope of KEYWORD_SCOPES) {
      const value = syntax[scope];
      const color = typeof value === 'string' ? value : value?.color;
      if (color) return color;
    }
  }
  const rules = theme.textmate?.settings ?? theme.textmate?.tokenColors ?? [];
  for (const scope of KEYWORD_SCOPES) {
    // A rule for `keyword` styles `keyword` exactly; a rule for `keyword.control` does not.
    for (const rule of rules) {
      const scopes = typeof rule.scope === 'string' ? rule.scope.split(',') : (rule.scope ?? []);
      if (rule.settings?.foreground && scopes.some((s) => s.trim() === scope)) return rule.settings.foreground;
    }
  }
  return undefined;
}

/** The palette as custom properties for the code-tier parts of a diff of `theme`. */
export function codePaletteCSS(theme: string, palette: CodePalette): string {
  const name = theme.replace(/["\\]/g, '\\$&');
  const declarations = [
    `--diff-code-bg:${palette.background}`,
    `--diff-code-fg:${palette.foreground}`,
    `--diff-code-muted:${palette.muted}`,
    ...(palette.keyword ? [`--diff-keyword:${palette.keyword}`] : []),
  ];
  // Only the bars take the properties: set on .changes-diff, they would restyle every line of the diff (#366).
  return `.changes-diff[data-code-theme="${name}"] .diff-gap{${declarations.join(';')}}`;
}
