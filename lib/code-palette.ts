import { contrastRatio, mixColor } from './code-contrast';

/**
 * The code surface's own colours, from the syntax theme the diff renders with, for the parts of Changes that sit in
 * the code rather than around it. A hunk's header is code-tier: a surface lifted from the code's background toward its
 * text and tinted cool, so it separates from the code (and its green and red lines) by lightness and hue, edged with a
 * darker line where it meets the code, in the code's type, with kind words such as `fn` and `class` in the theme's
 * keyword colour.
 */
export interface CodePalette {
  background: string;
  foreground: string;
  /** The header's surface (HEADER_LIFT, HEADER_TINT). The code's background when the theme's colours are not hex. */
  header: string;
  /** The line under the header, darker than the code. */
  line: string;
  /** Secondary text on the header, such as separators and line ranges: as quiet as stays readable (TEXT_CONTRAST). */
  muted: string;
  /** The colour the theme gives the `keyword` scope, raised to TEXT_CONTRAST on the header; undefined without one. */
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

/** The header's surface: the code's background this far toward its text, in OKLab… */
export const HEADER_LIFT = 0.12;
/** …then this far toward the code focus ring's blue (--code-ring in tokens.css), to part from the code by hue too. */
export const HEADER_TINT = 0.08;
const CODE_RING = '#9bb8ff';
/** The line under the header: the code's background this far toward black. */
const LINE_DARKEN = 0.45;
/** Text on the header keeps this contrast: WCAG's 4.5:1, with a margin for rounding. */
export const TEXT_CONTRAST = 4.6;

const HEX = /^#[\da-f]{6}$/i;

export function codePalette(theme: PaletteTheme): CodePalette {
  const background = theme.bg;
  const foreground = theme.fg;
  const keyword = keywordColor(theme);
  if (!HEX.test(background) || !HEX.test(foreground))
    return { background, foreground, header: background, line: background, muted: foreground, keyword };
  const header = mixOklab(mixOklab(background, foreground, HEADER_LIFT), CODE_RING, HEADER_TINT);
  return {
    background,
    foreground,
    header,
    line: mixOklab(background, '#000000', LINE_DARKEN),
    muted: mutedColor(header, foreground),
    keyword: keyword && HEX.test(keyword) ? readable(keyword, header) : keyword,
  };
}

/** The foreground mixed up to 40% toward the surface: less where the theme's own contrast is low. */
function mutedColor(surface: string, foreground: string): string {
  for (let step = 20; step > 0; step--) {
    const candidate = mixColor(foreground, surface, step / 50);
    if (contrastRatio(candidate, surface) >= TEXT_CONTRAST) return candidate;
  }
  return foreground;
}

/** `color`, raised toward white until it reads on `surface`; the code's surfaces are dark. */
function readable(color: string, surface: string): string {
  for (let step = 0; step <= 50; step++) {
    const candidate = mixColor(color, '#ffffff', step / 50);
    if (contrastRatio(candidate, surface) >= TEXT_CONTRAST) return candidate;
  }
  return '#ffffff';
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

// ── OKLab ──
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
export function toOklab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
function fromOklab([L, a, b]: number[]): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return '#' + rgb.map((c) => Math.round(Math.min(1, Math.max(0, fromLinear(c))) * 255).toString(16).padStart(2, '0')).join('');
}
/** `from` moved `amount` of the way to `to` in OKLab, as CSS `color-mix(in oklab, …)` does. */
export function mixOklab(from: string, to: string, amount: number): string {
  const a = toOklab(from),
    b = toOklab(to);
  return fromOklab(a.map((v, i) => v + (b[i] - v) * amount));
}

/** The palette as custom properties for the code-tier parts of a diff of `theme`. */
export function codePaletteCSS(theme: string, palette: CodePalette): string {
  const name = theme.replace(/["\\]/g, '\\$&');
  const declarations = [
    `--diff-code-bg:${palette.background}`,
    `--diff-code-fg:${palette.foreground}`,
    `--diff-code-header:${palette.header}`,
    `--diff-code-line:${palette.line}`,
    `--diff-code-muted:${palette.muted}`,
    ...(palette.keyword ? [`--diff-keyword:${palette.keyword}`] : []),
  ];
  // Only the bars take the properties: set on .changes-diff, they would restyle every line of the diff (#366).
  return `.changes-diff[data-code-theme="${name}"] .diff-gap{${declarations.join(';')}}`;
}
