import type { Root, RootContent } from 'hast';

/** Name read-only GitHub task boxes without flattening rich or nested Markdown. */
export function nameMarkdownTasks() {
  return (tree: Root) => {
    function text(node: RootContent): string {
      if (node.type === 'text') return node.value;
      if (node.type !== 'element' || ['ul', 'ol', 'input'].includes(node.tagName)) return '';
      if (node.tagName === 'img') return node.properties.alt ?? '';
      return node.children.map(text).join('');
    }
    function visit(node: Root | RootContent) {
      if (node.type === 'element' && node.tagName === 'li') {
        const name = node.children.map(text).join('').replace(/\s+/g, ' ').trim();
        const label = (child: RootContent) => {
          if (child.type !== 'element' || ['ul', 'ol'].includes(child.tagName)) return;
          if (child.tagName === 'input' && child.properties.type === 'checkbox') {
            child.properties.ariaLabel = name || 'Task';
          } else child.children.forEach(label);
        };
        node.children.forEach(label);
      }
      if ('children' in node) node.children.forEach(visit);
    }
    visit(tree);
  };
}
