/**
 * "You are here" (#417): the one signal Gnosis gives a place it took the reader to.
 *
 * - A pinned crumb's jump, or an outline symbol's, marks the whole section: every shown row of the definition, from its
 *   first line to its last, in both columns of a split diff, with the empty rows across from code only one side has,
 *   and the gap bars inside it. The signature blooms; the rest of the section takes a softer band (`markSection`).
 * - A review check in an Explanation topic marks its line (`markHere`).
 *
 * A marked row and its gutter cell take a band in a deep code-tier blue under their text, with a solid bar on the
 * gutter's edge, so the bar runs down the whole section. The signature's band pours out from the bar as it arrives,
 * blooms, settles to a softer tint and fades out over `HERE_MS`; the rest of the section blooms and fades with it, more
 * softly. Reduced motion shows the settled bands, still, for as long. Visual only: each band is a pseudo-element under
 * its row's text, so nothing moves, and marking writes attributes alone, with no layout read. When the diff renders
 * again while the band shows, and so writes its rows anew, the band moves to the rows in the same place.
 *
 * The rows live in Pierre's shadow roots, so the CSS is part of ChangesDiff's (`HERE_CSS`); gap bars use the same rules
 * in globals.css. Colours and their contrast are checked in tests/code-palette.test.ts (HERE_* in lib/code-palette.ts).
 */

/** How long the band shows, moving or still. */
export const HERE_MS = 2000;

const BAND = '47 85 212';
/** Keyframes for one part of a mark, in two copies (`-a`, `-b`) so marking again restarts them without a layout read. */
const keyframes = (name: string, peak: number, settled: number, extra: (stage: 'start' | 'pour' | 'hold' | 'end') => string) =>
  ['a', 'b']
    .map(
      (copy) => `@keyframes ${name}-${copy} {
  0% { background-color: rgb(${BAND} / ${peak}%); ${extra('start')} animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }
  14% { background-color: rgb(${BAND} / ${peak}%); ${extra('pour')} animation-timing-function: cubic-bezier(0.33, 0, 0.2, 1); }
  38% { background-color: rgb(${BAND} / ${settled}%); ${extra('hold')} }
  72% { background-color: rgb(${BAND} / ${settled}%); ${extra('hold')} animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1); }
  100% { background-color: rgb(${BAND} / 0%); ${extra('end')} }
}`
    )
    .join('\n');
const pour = (stage: string) => (stage === 'start' ? 'transform: scaleX(0);' : 'transform: scaleX(1);');
const bar = (stage: string) => (stage === 'end' ? 'box-shadow: inset 3px 0 0 rgb(155 184 255 / 0%);' : 'box-shadow: inset 3px 0 0 var(--code-ring, #9bb8ff);');
const none = () => '';

const ROWS = ':is([data-line], [data-content-buffer])';
const GUTTERS = ':is([data-column-number], [data-gutter-buffer])';

/**
 * The band's CSS, for a diff's shadow root. `data-here` is `a` or `b` (which copy of the keyframes runs);
 * `data-here-part=body` marks the rest of a section, more softly than its signature.
 */
export const HERE_CSS = `
${ROWS}[data-here], ${GUTTERS}[data-here] { isolation: isolate; }
${ROWS}[data-here]::after, ${GUTTERS}[data-here]::after {
  content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none;
  background-color: rgb(${BAND} / 0%); animation-duration: ${HERE_MS}ms; animation-fill-mode: forwards; animation-timing-function: linear;
}
[data-content-buffer][data-here] { position: relative; }
${ROWS}[data-here]::after { transform-origin: 0 50%; }
${ROWS}[data-here=a]::after { animation-name: gnosis-here-band-a; }
${ROWS}[data-here=b]::after { animation-name: gnosis-here-band-b; }
${ROWS}[data-here=a][data-here-part=body]::after { animation-name: gnosis-here-body-a; }
${ROWS}[data-here=b][data-here-part=body]::after { animation-name: gnosis-here-body-b; }
[data-column-number][data-here]:not([data-here-part=body]) { color: var(--code-ring, #9bb8ff); }
${GUTTERS}[data-here=a]::after { animation-name: gnosis-here-gutter-a; }
${GUTTERS}[data-here=b]::after { animation-name: gnosis-here-gutter-b; }
${GUTTERS}[data-here=a][data-here-part=body]::after { animation-name: gnosis-here-gutter-body-a; }
${GUTTERS}[data-here=b][data-here-part=body]::after { animation-name: gnosis-here-gutter-body-b; }
${keyframes('gnosis-here-band', 38, 22, pour)}
${keyframes('gnosis-here-body', 18, 12, none)}
${keyframes('gnosis-here-gutter', 38, 22, bar)}
${keyframes('gnosis-here-gutter-body', 18, 12, bar)}
@media (prefers-reduced-motion: reduce) {
  ${ROWS}[data-here]::after, ${GUTTERS}[data-here]::after { animation: none; transform: none; background-color: rgb(${BAND} / 22%); }
  /* The attribute twice outweighs the body's keyframes above, so the section's band stays still too. */
  ${ROWS}[data-here][data-here][data-here-part=body]::after, ${GUTTERS}[data-here][data-here][data-here-part=body]::after { animation: none; background-color: rgb(${BAND} / 12%); }
  ${GUTTERS}[data-here]::after { box-shadow: inset 3px 0 0 var(--code-ring, #9bb8ff); }
}`;

/**
 * The steady "here" (#445 item 10): the lines a conflict resolver wrote, which neither side had, keep a quiet mark for
 * as long as they show. It is the band's visual language held still: the section's settled tint (12%, as reduced motion
 * shows a marked section) under the line's text, and a thin solid `--code-ring` rail on the code's leading edge, so it
 * reads beside the green or red change bar rather than under it. No animation and no pseudo-element: both are
 * backgrounds of the row itself, over its change colour and under its text, so the transient band can still play on top.
 * ChangesDiff writes `data-written-line` after each render.
 */
const WRITTEN_LAYERS = `linear-gradient(to right, var(--code-ring, #9bb8ff) 0 2px, transparent 2px), linear-gradient(rgb(${BAND} / 12%), rgb(${BAND} / 12%))`;
export const WRITTEN_CSS = `
[data-line][data-written-line] { background-image: ${WRITTEN_LAYERS}; }`;

/**
 * The steady mark as a swatch for the card's legend ("1 line written by Gnosis"): the same rail and band, on the code
 * surface, so the legend looks as the marked rows do.
 */
export const WRITTEN_SWATCH = `${WRITTEN_LAYERS}, var(--diff-code-bg, #0d1117)`;

/** What a marked written line says to assistive technology, and in its line number's tooltip. */
export const WRITTEN_LINE_DESCRIPTION = 'Written by Gnosis. Neither side had this line.';
/**
 * Marks the new side's rows a conflict resolver wrote (#445 item 10, `data-written-line`), context or added, with their
 * gutter cells. Each marked row is described for assistive technology and its line number has the same tooltip.
 * Attributes change only where they differ, so a pass over a diff that is already marked writes nothing; a diff with
 * nothing to mark and nothing marked costs one query.
 */
export function markWritten(host: Element, lines: ReadonlySet<number>) {
  const root = host.shadowRoot;
  if (!root) return;
  if (!lines.size && !root.querySelector('[data-written-line]')) return;
  const gutters = new Map<string, Element>();
  for (const cell of root.querySelectorAll('[data-column-number]'))
    if (!cell.closest('[data-deletions]')) gutters.set(cell.getAttribute('data-line-index') ?? '', cell);
  const write = (element: Element | undefined, on: boolean, attribute: string) => {
    if (!element || element.hasAttribute('data-written-line') === on) return;
    element.toggleAttribute('data-written-line', on);
    if (on) element.setAttribute(attribute, WRITTEN_LINE_DESCRIPTION);
    else element.removeAttribute(attribute);
  };
  for (const row of root.querySelectorAll<HTMLElement>('[data-line]')) {
    if (row.closest('[data-deletions]')) continue;
    const on = row.dataset.lineType !== 'change-deletion' && lines.has(Number(row.dataset.line));
    write(row, on, 'aria-description');
    write(gutters.get(row.getAttribute('data-line-index') ?? ''), on, 'title');
  }
}
/** A row's line-number cell: the gutter cell with its line index, in the same column of a split diff. */
export function gutterOf(row: Element): Element | undefined {
  const index = row.getAttribute('data-line-index');
  if (index === null) return undefined;
  const column = row.closest('[data-deletions], [data-additions]') ?? row.closest('[data-code]') ?? row.parentElement;
  return column?.querySelector(`[data-column-number][data-line-index="${CSS.escape(index)}"]`) ?? undefined;
}

/** A marked element, and how to find the element that replaces it in its diff's shadow root. */
interface Marked extends HereTarget {
  root?: ShadowRoot;
  selector?: string;
}
let shown: { marked: Marked[]; timer: ReturnType<typeof setTimeout>; observer?: MutationObserver } | undefined;
let flip = false;

/** Ends the band, wherever it shows. */
export function clearHere() {
  if (!shown) return;
  clearTimeout(shown.timer);
  shown.observer?.disconnect();
  for (const { element } of shown.marked) {
    element.removeAttribute('data-here');
    element.removeAttribute('data-here-part');
  }
  shown = undefined;
}

/** What a mark covers: elements, each the signature's (bloom) or the rest of a section's (`body`, softer). */
export interface HereTarget {
  element: Element;
  part?: 'body';
}

/** A code row or gutter cell by its column, line and visual row: the same place after the diff renders again. */
function placeOf(element: Element): string | undefined {
  const index = element.getAttribute('data-line-index');
  if (index === null) return undefined;
  const attribute = element.hasAttribute('data-line') ? 'data-line' : element.hasAttribute('data-column-number') ? 'data-column-number' : undefined;
  if (!attribute) return undefined;
  const column = element.closest('[data-deletions]') ? '[data-deletions] ' : element.closest('[data-additions]') ? '[data-additions] ' : '';
  return `${column}[${attribute}="${CSS.escape(element.getAttribute(attribute) ?? '')}"][data-line-index="${CSS.escape(index)}"]`;
}

function mark(targets: readonly HereTarget[]): Element[] {
  clearHere();
  const live = targets.filter((target) => target.element.isConnected);
  if (!live.length) return [];
  flip = !flip;
  const letter = flip ? 'a' : 'b';
  const apply = ({ element, part }: HereTarget) => {
    element.setAttribute('data-here', letter);
    if (part) element.setAttribute('data-here-part', part);
  };
  const marked: Marked[] = live.map((target) => {
    apply(target);
    const root = target.element.getRootNode();
    return root instanceof ShadowRoot ? { ...target, root, selector: placeOf(target.element) } : { ...target };
  });
  // Pierre writes a diff's rows anew each time the diff renders, which any render of the component around it does. A
  // render while the band shows would drop it with the old rows, so the band moves to the rows that replace them.
  const roots = new Set(marked.flatMap((entry) => (entry.root && entry.selector ? [entry.root] : [])));
  let observer: MutationObserver | undefined;
  if (roots.size) {
    observer = new MutationObserver(() => {
      for (const entry of marked) {
        if (entry.element.isConnected || !entry.root || !entry.selector) continue;
        const next = entry.root.querySelector(entry.selector);
        if (!next) continue;
        entry.element = next;
        apply(entry);
      }
    });
    for (const root of roots) observer.observe(root, { childList: true, subtree: true });
  }
  shown = { marked, timer: setTimeout(clearHere, HERE_MS), observer };
  return live.map((target) => target.element);
}

/**
 * Marks where the reader was taken: code rows (`[data-line]`, with their gutter cells) or a gap bar. One place shows
 * the band at a time; marking another ends the last. Returns the elements marked.
 */
export function markHere(targets: readonly Element[]): Element[] {
  return mark(
    targets.flatMap((target) => {
      if (!target.matches('[data-line]')) return [{ element: target }];
      const gutter = gutterOf(target);
      return gutter ? [{ element: target }, { element: gutter }] : [{ element: target }];
    })
  );
}

/** A definition on one side, in that side's numbers: its lines, and its signature's. */
export interface HereSection {
  side: 'before' | 'after';
  start: number;
  end: number;
  signatureEnd: number;
}

/** A row's number on `side`, or undefined for a row only the other side has. As ChangesDiff's lineElement reads rows. */
function sideNumber(row: HTMLElement, side: HereSection['side']): number | undefined {
  const type = row.dataset.lineType;
  if (type === (side === 'before' ? 'change-addition' : 'change-deletion')) return undefined;
  const own = type === 'change-addition' || type === 'change-deletion' || (side === 'before') === !!row.closest('[data-deletions]');
  const value = Number(own ? row.dataset.line : row.dataset.altLine);
  return value || undefined;
}
/** Where an element sits among the diff's visual rows: unified, its row; split, the row it shares across columns. */
const visualRow = (element: Element, split: boolean) => {
  const parts = (element.getAttribute('data-line-index') ?? '').split(',');
  return Number(split && parts.length > 1 ? parts[1] : parts[0]);
};
/** The visual rows an empty-row buffer spans: from the row before it in its column, or back from the row after. */
function bufferRows(buffer: Element, split: boolean): [number, number] | undefined {
  const size = Number(buffer.getAttribute('data-buffer-size')) || 1;
  for (let at = buffer.previousElementSibling; at; at = at.previousElementSibling)
    if (at.hasAttribute('data-line-index')) {
      const first = visualRow(at, split) + 1;
      return [first, first + size - 1];
    }
  for (let at = buffer.nextElementSibling; at; at = at.nextElementSibling)
    if (at.hasAttribute('data-line-index')) {
      const last = visualRow(at, split) - 1;
      return [last - size + 1, last];
    }
  return undefined;
}

/**
 * The targets of a section mark in one rendered diff (`host`, a Pierre container): every visual row from the
 * section's first shown row to its last, in both columns of a split diff, with their gutter cells and the empty-row
 * buffers between them, so the band reads as one block across the view. Rows of the signature bloom; the rest are the
 * section's body. One query of the diff's rows, and attribute reads alone.
 */
export function sectionTargets(host: Element, section: HereSection, rows = Infinity): HereTarget[] {
  return sectionRows(host, section, rows).targets;
}
/** The targets, and how many visual rows of the section they cover. */
function sectionRows(host: Element, section: HereSection, rows: number): { targets: HereTarget[]; covered: number } {
  const none = { targets: [], covered: 0 };
  const root = host.shadowRoot;
  if (!root || rows <= 0) return none;
  const split = !!root.querySelector('[data-deletions]');
  let first = Infinity,
    last = -Infinity;
  const signature = new Set<number>();
  for (const row of root.querySelectorAll<HTMLElement>('[data-line]')) {
    const line = sideNumber(row, section.side);
    if (line === undefined || line < section.start || line > section.end) continue;
    const at = visualRow(row, split);
    first = Math.min(first, at);
    last = Math.max(last, at);
    if (line <= section.signatureEnd) signature.add(at);
  }
  if (first > last) return none;
  // Rows past `rows` from the section's first are out of view for as long as the mark lasts.
  last = Math.min(last, first + rows - 1);
  const targets: HereTarget[] = [];
  for (const element of root.querySelectorAll('[data-line-index]')) {
    if (!element.matches('[data-line], [data-column-number]')) continue;
    const at = visualRow(element, split);
    if (at >= first && at <= last) targets.push(signature.has(at) ? { element } : { element, part: 'body' });
  }
  for (const buffer of root.querySelectorAll('[data-content-buffer], [data-gutter-buffer]')) {
    if (buffer.getAttribute('data-gutter-buffer') === 'annotation') continue;
    const rows = bufferRows(buffer, split);
    if (rows && rows[1] >= first && rows[0] <= last)
      targets.push(rows[0] <= Math.max(...signature, -Infinity) && rows[1] >= Math.min(...signature, Infinity) ? { element: buffer } : { element: buffer, part: 'body' });
  }
  return { targets, covered: last - first + 1 };
}

/** Marks a whole section: its rows in every rendered diff under `hosts`, and `bars` (gap bars inside it) as its body. */
/**
 * Each marked row and gutter cell starts an animated pseudo-element, and on a slow machine their first style pass costs
 * about 0.15 ms each: a 150-row section's 300 cost a 50 ms task on a 4x throttled CPU. So a mark covers the section's
 * rows from its first down to `rows` of them, enough to fill the view twice over while it lasts; a longer section's
 * rest, out of view, is left unmarked.
 */
export function markSection(hosts: Iterable<Element>, section: HereSection, bars: readonly Element[] = [], rows = Infinity): Element[] {
  const targets: HereTarget[] = [];
  let left = rows;
  for (const host of hosts) {
    const found = sectionRows(host, section, left);
    targets.push(...found.targets);
    left -= found.covered;
  }
  for (const element of bars) targets.push({ element, part: 'body' });
  return mark(targets);
}

/**
 * Opens the quiet change (#396) that holds a line, so a jump can land on it: a hunk collapsed to a bar, or a file
 * collapsed to one. `side` is the line's side; `scope` is the file's diff, or what holds it. Whether it opened one:
 * the caller looks for the line again once the diff has rendered.
 */
export function openQuietLine(scope: ParentNode, line: number, side: 'before' | 'after' = 'after'): boolean {
  for (const bar of scope.querySelectorAll<HTMLElement>('[data-noise-file], [data-noise-bar]')) {
    const range = bar.dataset[side === 'before' ? 'noiseBefore' : 'noiseAfter'];
    if (range !== undefined) {
      const [from, to] = range.split('-').map(Number);
      if (line < from || line > to) continue;
    }
    const show = bar.querySelector<HTMLButtonElement>('[data-noise-show]');
    if (!show) continue;
    show.click();
    return true;
  }
  return false;
}
