/**
 * One text node per line of code instead of one per syntax token (#366).
 *
 * Pierre renders each token of a line as a span around a text node, about 18 for a typical line of TypeScript.
 * Chromium gives every text node a static text and an inline text box in the accessibility tree, so a 200-row slice
 * of a large file was about 9,000 accessibility nodes, and Chromium built all of them again each time the slice
 * scrolled into view. Here a line whose tokens only set a color becomes one span around one text node, and the
 * colors become a gradient clipped to the text: each token's color from its first to its last column. The text,
 * find in page, selection and copy are unchanged, and a screen reader reads the line as one piece of text.
 *
 * Columns are only exact for unwrapped lines of printable ASCII in a monospace font, so wrapped diffs, lines with
 * tabs or other characters, and tokens styled with anything but a color (inline change marks, italic, bold) keep
 * Pierre's spans. So do lines longer than MAX_COLUMNS: Chromium places each span's text on its own subpixel grid,
 * so glyphs in one text node drift from where Pierre's spans put them, by up to 0.3 px at column 160 and 0.5 px
 * from column 274 at the app's code fonts and 90-110% zoom. lib/diff-token-flatten.ts makes the change to the lines Pierre is about to write, so it adds no DOM
 * work.
 */

/** Set on a diff's options to render its lines this way. */
export const FLAT_TOKENS = 'gnosisFlatTokens';

/** Styles for the flattened lines, for the diff's own stylesheet. Selected text shows in the plain text color. */
export const FLAT_TOKEN_CSS = `[data-tokens] {
  color: transparent;
  -webkit-background-clip: text;
  background-clip: text;
}
[data-tokens]::selection { color: var(--diffs-fg); }`;

export type Hast = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: Hast[]; value?: string };

const COLOR = /^color:\s*(#[0-9a-f]{3,8}|[a-z-]+\([^;()]*\)|[a-z]+)\s*;?$/i;
const PRINTABLE = /^[\x20-\x7e]*$/;
/** Longer lines keep their spans; see above. */
export const MAX_COLUMNS = 200;
/** Pierre's token styles, most of them repeated on every line. */
const colors = new Map<string, string | null>();
function colorOf(style: string) {
  let color = colors.get(style);
  if (color === undefined) colors.set(style, (color = COLOR.exec(style)?.[1] ?? null));
  return color;
}

/** Replaces a line's token spans with one span colored by a gradient, when its tokens only set colors. */
export function flattenLine(line: Hast) {
  const children = line.children;
  if (line.type !== 'element' || line.properties?.['data-line'] == null || !children || children.length < 2) return;
  let text = '';
  const stops: [string, number, number][] = [];
  for (const child of children) {
    let color = 'var(--diffs-fg)';
    let value: string;
    if (child.type === 'text') value = child.value ?? '';
    else {
      const content = child.children;
      if (child.type !== 'element' || child.tagName !== 'span' || content?.length !== 1 || content[0].type !== 'text') return;
      const { style, ...rest } = child.properties ?? {};
      for (const key in rest) if (rest[key] != null) return;
      if (style != null) {
        const found = typeof style === 'string' ? colorOf(style) : null;
        if (!found) return;
        color = found;
      }
      value = content[0].value ?? '';
    }
    // A final newline takes no column.
    const columns = value.endsWith('\n') ? value.slice(0, -1) : value;
    if (!PRINTABLE.test(columns)) return;
    const last = stops.at(-1);
    if (last?.[0] === color) last[2] += columns.length;
    else if (columns) stops.push([color, text.length, text.length + columns.length]);
    text += value;
  }
  if (stops.length < 2 || stops[stops.length - 1][2] > MAX_COLUMNS) return;
  const gradient = stops.map(([color, from, to]) => `${color} ${from}ch ${to}ch`).join(',');
  line.children = [
    {
      type: 'element',
      tagName: 'span',
      properties: { 'data-tokens': '', style: `background-image:linear-gradient(90deg,${gradient})` },
      children: [{ type: 'text', value: text }],
    },
  ];
}
