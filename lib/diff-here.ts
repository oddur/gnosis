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
 * its row's text, so nothing moves, and marking writes attributes alone, with no layout read.
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

/** A row's line-number cell: the gutter cell with its line index, in the same column of a split diff. */
export function gutterOf(row: Element): Element | undefined {
  const index = row.getAttribute('data-line-index');
  if (index === null) return undefined;
  const column = row.closest('[data-deletions], [data-additions]') ?? row.closest('[data-code]') ?? row.parentElement;
  return column?.querySelector(`[data-column-number][data-line-index="${CSS.escape(index)}"]`) ?? undefined;
}

let shown: { elements: Element[]; timer: ReturnType<typeof setTimeout> } | undefined;
let flip = false;

/** Ends the band, wherever it shows. */
export function clearHere() {
  if (!shown) return;
  clearTimeout(shown.timer);
  for (const element of shown.elements) {
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
function mark(targets: readonly HereTarget[]): Element[] {
  clearHere();
  const live = targets.filter((target) => target.element.isConnected);
  if (!live.length) return [];
  flip = !flip;
  for (const { element, part } of live) {
    element.setAttribute('data-here', flip ? 'a' : 'b');
    if (part) element.setAttribute('data-here-part', part);
  }
  const elements = live.map((target) => target.element);
  shown = { elements, timer: setTimeout(clearHere, HERE_MS) };
  return elements;
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
export function sectionTargets(host: Element, section: HereSection): HereTarget[] {
  const root = host.shadowRoot;
  if (!root) return [];
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
  if (first > last) return [];
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
  return targets;
}

/** Marks a whole section: its rows in every rendered diff under `hosts`, and `bars` (gap bars inside it) as its body. */
export function markSection(hosts: Iterable<Element>, section: HereSection, bars: readonly Element[] = []): Element[] {
  const targets: HereTarget[] = [];
  for (const host of hosts) targets.push(...sectionTargets(host, section));
  for (const element of bars) targets.push({ element, part: 'body' });
  return mark(targets);
}
