export interface LabelRange {
  start: number;
  end: number;
}

/** Word/value insertions in the current label. Bound the comparison so unusual
 * generated labels cannot stall navigation on the renderer thread.
 */
export function changedLabelRanges(before: string, after: string): LabelRange[] {
  const tokenize = (value: string) => [...value.matchAll(/[\p{L}_][\p{L}\p{N}_]*|\p{N}+(?:[.,]\p{N}+)*|[^\s]/gu)];
  const old = tokenize(before);
  const next = tokenize(after);
  if (old.length > 256 || next.length > 256) {
    let start = 0;
    while (start < old.length && start < next.length && old[start][0] === next[start][0]) start++;
    let end = next.length;
    let oldEnd = old.length;
    while (end > start && oldEnd > start && next[end - 1][0] === old[oldEnd - 1][0]) {
      end--;
      oldEnd--;
    }
    return end > start ? [{ start: next[start].index, end: next[end - 1].index + next[end - 1][0].length }] : [];
  }
  const width = next.length + 1;
  const lengths = new Uint16Array((old.length + 1) * width);
  for (let i = old.length - 1; i >= 0; i--) {
    for (let j = next.length - 1; j >= 0; j--) {
      lengths[i * width + j] =
        old[i][0] === next[j][0]
          ? 1 + lengths[(i + 1) * width + j + 1]
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }
  const ranges: LabelRange[] = [];
  let i = 0;
  let j = 0;
  while (j < next.length) {
    if (i < old.length && old[i][0] === next[j][0]) {
      i++;
      j++;
    } else if (i < old.length && lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) i++;
    else {
      const token = next[j++];
      const range = { start: token.index, end: token.index + token[0].length };
      const previous = ranges.at(-1);
      if (previous && !after.slice(previous.end, range.start).trim()) previous.end = range.end;
      else ranges.push(range);
    }
  }
  return ranges;
}

/** Wrap only changed text; preserve the compiler's positions, font metrics,
 * and line breaks. Unsupported/path-rendered labels keep the entity outline.
 */
export function markChangedLabel(group: Element, label: string, ranges: LabelRange[]) {
  const doc = group.ownerDocument;
  let offset = 0;
  for (const text of group.querySelectorAll('text')) {
    if (text.closest('[data-d2-entity]') !== group) continue;
    const walker = doc.createTreeWalker(text, 4 /* SHOW_TEXT */);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    for (const node of nodes) {
      const value = node.data;
      const start = label.indexOf(value.replace(/\u00a0/g, ' '), offset);
      if (start < 0 || !value) continue;
      offset = start + value.length;
      const overlaps = ranges.flatMap((range) => {
        const a = Math.max(start, range.start) - start;
        const b = Math.min(offset, range.end) - start;
        return b > a ? [{ start: a, end: b }] : [];
      });
      if (!overlaps.length) continue;
      const fragment = doc.createDocumentFragment();
      let cursor = 0;
      for (const range of overlaps) {
        fragment.append(doc.createTextNode(value.slice(cursor, range.start)));
        const span = doc.createElementNS('http://www.w3.org/2000/svg', 'tspan');
        span.setAttribute('data-d2-updated', '');
        span.textContent = value.slice(range.start, range.end);
        fragment.append(span);
        cursor = range.end;
      }
      fragment.append(doc.createTextNode(value.slice(cursor)));
      node.replaceWith(fragment);
    }
  }
}
