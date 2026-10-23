import type { Root, Element, RootContent } from 'hast';

/** Keep author headings beneath the app's section without losing their hierarchy. */
export function scopeMarkdownHeadings({ startLevel }: { startLevel: number }) {
  return (tree: Root) => {
    const headings: Element[] = [];
    function collect(node: Root | RootContent) {
      if (node.type === 'element' && /^h[1-6]$/.test(node.tagName)) headings.push(node);
      if ('children' in node) node.children.forEach(collect);
    }
    collect(tree);
    const minimum = Math.min(...headings.map((node) => Number(node.tagName[1])));
    let previous = startLevel - 1;
    for (const node of headings) {
      const level = Math.min(6, previous + 1, startLevel + Number(node.tagName[1]) - minimum);
      node.tagName = `h${level}`;
      previous = level;
    }
  };
}
