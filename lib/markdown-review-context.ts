import type { MarkdownLocation, MarkdownReviewBlock } from './markdown-review';

export type MarkdownContextItem =
  | { kind: 'block'; block: MarkdownReviewBlock }
  | { kind: 'gap'; blocks: MarkdownReviewBlock[] };

export function markdownBlockAt(blocks: MarkdownReviewBlock[], location?: MarkdownLocation) {
  return (
    location &&
    blocks.find((block) => {
      const range = block[location.side];
      return range && range.end >= location.start;
    })
  );
}

/** Keep structural blocks intact: a paragraph, list, table or code fence is one unit. */
export function markdownReviewContext(
  blocks: MarkdownReviewBlock[],
  pinned: ReadonlySet<string> = new Set(),
  expanded: ReadonlySet<string> = new Set()
): MarkdownContextItem[] {
  const visible = new Set<number>();
  const hasChanges = blocks.some((block) => block.change !== 'unchanged');
  blocks.forEach((block, index) => {
    // Source-only changes have no rendered hunk. Leave their document readable.
    if (!hasChanges || block.sourceGap || expanded.has(block.id)) visible.add(index);
    if (block.change !== 'unchanged' || pinned.has(block.id)) {
      for (let n = Math.max(0, index - 1); n <= Math.min(blocks.length - 1, index + 1); n++) visible.add(n);
    }
  });
  const headings: { level: number; index: number }[] = [];
  blocks.forEach((block, index) => {
    const element = block.tree.children.find((node) => node.type === 'element');
    const level = element?.type === 'element' && /^h[1-6]$/.test(element.tagName) ? Number(element.tagName[1]) : 0;
    if (level) {
      while (headings.length && headings[headings.length - 1].level >= level) headings.pop();
      headings.push({ level, index });
    }
    if (visible.has(index)) headings.forEach((heading) => visible.add(heading.index));
  });
  const items: MarkdownContextItem[] = [];
  blocks.forEach((block, index) => {
    if (visible.has(index)) items.push({ kind: 'block', block });
    else {
      const last = items.at(-1);
      if (last?.kind === 'gap') last.blocks.push(block);
      else items.push({ kind: 'gap', blocks: [block] });
    }
  });
  return items;
}
