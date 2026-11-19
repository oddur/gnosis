/**
 * "You are here" (#417): the one signal Gnosis gives a line it took the reader to, after a pinned crumb's jump, an
 * outline symbol's jump, or a review check in an Explanation topic. The line's row and its gutter cell take a tinted
 * band in the code tier's blue with a solid bar on the gutter's edge: it blooms as it arrives, settles to a softer
 * tint, and fades out over `HERE_MS`. Reduced motion shows the settled band, still, for as long. Visual only: the
 * band is a pseudo-element under the row's text, so nothing moves and nothing is announced.
 *
 * The rows live in Pierre's shadow roots, so the CSS is part of ChangesDiff's (`HERE_CSS`); a gap bar standing in for a
 * hidden line uses the same rules in globals.css. Colours and their contrast are checked in tests/code-palette.test.ts
 * (HERE_BAND, HERE_SETTLED, HERE_PEAK in lib/code-palette.ts).
 */

/** How long the band shows, moving or still. */
export const HERE_MS = 2000;

/**
 * The band's CSS, for a diff's shadow root. Two names per keyframe set, so marking the same line again restarts its
 * bloom without a layout read: the attribute alternates between `a` and `b`.
 */
export const HERE_CSS = `
[data-line][data-here], [data-column-number][data-here] { isolation: isolate; }
[data-line][data-here]::after, [data-column-number][data-here]::after {
  content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none;
  background-color: rgb(47 85 212 / 0%); animation-duration: ${HERE_MS}ms; animation-fill-mode: forwards; animation-timing-function: linear;
}
[data-line][data-here]::after { transform-origin: 0 50%; }
[data-line][data-here=a]::after { animation-name: gnosis-here-band-a; }
[data-line][data-here=b]::after { animation-name: gnosis-here-band-b; }
[data-column-number][data-here] { color: var(--code-ring, #9bb8ff); }
[data-column-number][data-here=a]::after { animation-name: gnosis-here-gutter-a; }
[data-column-number][data-here=b]::after { animation-name: gnosis-here-gutter-b; }
${['a', 'b']
  .map(
    (name) => `@keyframes gnosis-here-band-${name} {
  0% { background-color: rgb(47 85 212 / 38%); transform: scaleX(0); animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }
  14% { background-color: rgb(47 85 212 / 38%); transform: scaleX(1); animation-timing-function: cubic-bezier(0.33, 0, 0.2, 1); }
  38% { background-color: rgb(47 85 212 / 22%); transform: scaleX(1); }
  72% { background-color: rgb(47 85 212 / 22%); transform: scaleX(1); animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1); }
  100% { background-color: rgb(47 85 212 / 0%); transform: scaleX(1); }
}
@keyframes gnosis-here-gutter-${name} {
  0% { background-color: rgb(47 85 212 / 38%); box-shadow: inset 3px 0 0 var(--code-ring, #9bb8ff); animation-timing-function: cubic-bezier(0.33, 0, 0.2, 1); }
  38% { background-color: rgb(47 85 212 / 22%); box-shadow: inset 3px 0 0 var(--code-ring, #9bb8ff); }
  72% { background-color: rgb(47 85 212 / 22%); box-shadow: inset 3px 0 0 var(--code-ring, #9bb8ff); animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1); }
  100% { background-color: rgb(47 85 212 / 0%); box-shadow: inset 3px 0 0 rgb(155 184 255 / 0%); }
}`
  )
  .join('\n')}
@media (prefers-reduced-motion: reduce) {
  [data-line][data-here]::after, [data-column-number][data-here]::after { animation: none; transform: none; background-color: rgb(47 85 212 / 22%); }
  [data-column-number][data-here]::after { box-shadow: inset 3px 0 0 var(--code-ring, #9bb8ff); }
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
  for (const element of shown.elements) element.removeAttribute('data-here');
  shown = undefined;
}

/**
 * Marks where the reader was taken: code rows (`[data-line]`, with their gutter cells) or a gap bar. One place shows
 * the band at a time; marking another ends the last. Returns the elements marked.
 */
export function markHere(targets: readonly Element[]): Element[] {
  clearHere();
  const elements = targets.flatMap((target) => {
    if (!target.isConnected) return [];
    if (!target.matches('[data-line]')) return [target];
    const gutter = gutterOf(target);
    return gutter ? [target, gutter] : [target];
  });
  if (!elements.length) return elements;
  flip = !flip;
  for (const element of elements) element.setAttribute('data-here', flip ? 'a' : 'b');
  shown = { elements, timer: setTimeout(clearHere, HERE_MS) };
  return elements;
}
