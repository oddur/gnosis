import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import type { Root, Element, RootContent } from 'hast';
import { nameMarkdownTasks } from '../lib/markdown-tasks';

void test('names rich, nested and loose Markdown tasks independently', async () => {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(nameMarkdownTasks);
  const tree = await processor.run(processor.parse('- [x] Ship **queue** `limits`\n  - [ ] Check [retry](https://example.com)\n\n- [ ] ![Diagram](https://example.com/image.png) checked'));
  const inputs: Element[] = [];
  const collect = (node: Root | RootContent) => {
    if (node.type === 'element' && node.tagName === 'input') inputs.push(node);
    if ('children' in node) node.children.forEach(collect);
  };
  collect(tree);
  assert.deepEqual(inputs.map((node) => node.properties.ariaLabel), ['Ship queue limits', 'Check retry', 'Diagram checked']);
  assert.deepEqual(inputs.map((node) => node.properties.checked), [true, false, false]);
  assert.ok(inputs.every((node) => node.properties.disabled));
});
