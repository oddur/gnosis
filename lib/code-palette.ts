import { contrastRatio, mixColor } from './code-contrast';

/**
 * The code surface's own colours, from the syntax theme the diff renders with, for the parts of Changes that sit in
 * the code rather than around it. A hunk's header is code-tier: a surface lifted from the code's background toward its
 * text and tinted cool, so it separates from the code (and its green and red lines) by lightness and hue, edged with a
 * darker line where it meets the code, in the code's type, with kind words such as `fn` and `class` in the theme's
 * keyword colour. The file's header above it is one step further: file header, hunk header and code read as three steps.
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
  /** A hunk header's +N and −M counts: the code tier's green and red, raised to TEXT_CONTRAST on the header. */
  headerAdded: string;
  headerDeleted: string;
  /** The file header's surface, a step above the hunk header's (FILE_LIFT, FILE_TINT). */
  file: string;
  /** Text on the file header: the foreground, raised where it would not read (TEXT_CONTRAST). */
  fileText: string;
  /** Secondary text on the file header, such as folders and the status word. */
  fileMuted: string;
  /** Outlines of the file header's controls (buttons, the checkbox): 3:1 against it (CONTROL_CONTRAST). */
  fileControl: string;
  /** The +N and −M counts on the file header: the code tier's green and red, raised to TEXT_CONTRAST. */
  fileAdded: string;
  fileDeleted: string;
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
/** The code tier's change inks, as --code-added and --code-deleted in tokens.css. */
const CODE_ADDED = '#85cf99';
const CODE_DELETED = '#ff9ba5';
/** The file header's surface: a step further toward the text and the blue than the hunk header's. */
export const FILE_LIFT = 0.2;
export const FILE_TINT = 0.13;
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
    return {
      background,
      foreground,
      header: background,
      line: background,
      muted: foreground,
      keyword,
      headerAdded: CODE_ADDED,
      headerDeleted: CODE_DELETED,
      file: background,
      fileText: foreground,
      fileMuted: foreground,
      fileControl: foreground,
      fileAdded: CODE_ADDED,
      fileDeleted: CODE_DELETED,
    };
  const header = mixOklab(mixOklab(background, foreground, HEADER_LIFT), CODE_RING, HEADER_TINT);
  const file = mixOklab(mixOklab(background, foreground, FILE_LIFT), CODE_RING, FILE_TINT);
  const fileText = readable(foreground, file);
  return {
    background,
    foreground,
    header,
    line: mixOklab(background, '#000000', LINE_DARKEN),
    muted: mutedColor(header, foreground),
    keyword: keyword && HEX.test(keyword) ? readable(keyword, header) : keyword,
    headerAdded: readable(CODE_ADDED, header),
    headerDeleted: readable(CODE_DELETED, header),
    file,
    fileText,
    fileMuted: mutedColor(file, fileText),
    fileControl: controlColor(file, fileText),
    fileAdded: readable(CODE_ADDED, file),
    fileDeleted: readable(CODE_DELETED, file),
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

/** Controls' outlines keep this contrast with their surface: WCAG's 3:1 for non-text, with a margin. */
export const CONTROL_CONTRAST = 3.1;
/** The quietest mix of the text into the surface that still outlines a control (CONTROL_CONTRAST). */
function controlColor(surface: string, foreground: string): string {
  for (let step = 1; step <= 50; step++) {
    const candidate = mixColor(surface, foreground, step / 50);
    if (contrastRatio(candidate, surface) >= CONTROL_CONTRAST) return candidate;
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
    `--diff-code-added:${palette.headerAdded}`,
    `--diff-code-deleted:${palette.headerDeleted}`,
    `--diff-file-bg:${palette.file}`,
    `--diff-file-fg:${palette.fileText}`,
    `--diff-file-muted:${palette.fileMuted}`,
    `--diff-file-control:${palette.fileControl}`,
    `--diff-file-added:${palette.fileAdded}`,
    `--diff-file-deleted:${palette.fileDeleted}`,
  ];
  // Only the bars and the file headers take the properties: set on .changes-diff or the file's section, they would
  // restyle every line of the diff (#366).
  return `[data-code-theme="${name}"] :is(.diff-gap,.changes-file-header){${declarations.join(';')}}`;
}

/**
 * "You are here" (lib/diff-here.ts): the band under a line the reader was taken to is this saturated blue, laid over
 * the line's own surface (context, added or deleted) at HERE_SETTLED, blooming from HERE_PEAK as it arrives. A deep
 * blue changes the surface's hue more than its lightness, so the band shows on every theme while the line's text keeps
 * most of its contrast; the bar on the gutter's edge is the code tier's ring (--code-ring), solid.
 */
export const HERE_BAND = '#2f55d4';
export const HERE_SETTLED = 0.22;
export const HERE_PEAK = 0.38;
/** The ring the band's bar is drawn in, as --code-ring in tokens.css. */
export const HERE_BAR = CODE_RING;
