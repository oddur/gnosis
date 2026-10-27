import GithubSlugger from 'github-slugger';
import { createHash } from 'node:crypto';
import { highlightMarkdownCode, isDiagramCode, codeLanguage } from './markdown-code';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { diffArrays, diffWordsWithSpace, diffLines } from 'diff';
import type { Root, RootContent, Element } from 'hast';
import { githubMarkdownUrl } from './github-markdown';
import type { MarkdownReview, MarkdownReviewBlock, MarkdownReviewRequest, MarkdownSide } from './markdown-review';

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize);
const root = (children: RootContent[]): Root => ({ type: 'root', children });
const structural = new Set(['ul', 'ol', 'table', 'thead', 'tbody', 'tr', 'blockquote']);
const atomic = new Set(['pre', 'img', 'hr', 'input']);
const text = (value: string): RootContent => ({ type: 'text', value });
const element = (tagName: string, children: RootContent[], properties: Element['properties'] = {}): Element => ({
  type: 'element',
  tagName,
  properties,
  children: children as Element['children'],
});

/** Parse and compare only in the backend worker. Never evaluate document HTML or MDX. */
export async function buildMarkdownReview(request: MarkdownReviewRequest): Promise<MarkdownReview> {
  if (
    [request.before, request.after].some(
      (value) => value !== null && (typeof value !== 'string' || value.length > 500_000)
    )
  )
    throw new Error('This document is too large for rendered comparison. Use Source to review it.');
  const parse = async (value: string | null) => {
    const tree = await processor.run(processor.parse(value ?? ''));
    // Whitespace between block elements is layout, not editorial content.
    const compact = (node: Root | RootContent) => {
      if (node.type !== 'element' && node.type !== 'root') return;
      if (node.type === 'root' || structural.has(node.tagName))
        node.children = node.children.filter(
          (child) => child.type !== 'text' || child.value.trim()
        ) as typeof node.children;
      node.children.forEach(compact);
    };
    compact(tree);
    const slugger = new GithubSlugger();
    let count = 0;
    const headingText = (n: RootContent): string =>
      n.type === 'text' ? n.value : n.type === 'element' ? n.children.map(headingText).join('') : '';
    const anchors = (n: Root | RootContent) => {
      if (++count > 12_000)
        throw new Error('This document is too complex for rendered comparison. Use Source to review it.');
      if (n.type === 'element' && /^h[1-6]$/.test(n.tagName) && !n.properties.id)
        n.properties.id = slugger.slug(headingText(n));
      if (n.type === 'root' || n.type === 'element') n.children.forEach(anchors);
    };
    anchors(tree);
    return tree;
  };
  const before = await parse(request.before),
    after = await parse(request.after);
  const signatures = new WeakMap<object, string>();
  const signature = (node: RootContent, preserve = false): string => {
    const cached = !preserve && signatures.get(node);
    if (cached) return cached;
    const value =
      node.type === 'element'
        ? JSON.stringify([
            node.tagName,
            node.properties,
            node.children.map((child) => signature(child, preserve || node.tagName === 'pre')),
          ])
        : node.type === 'text'
          ? preserve
            ? node.value
            : node.value.replace(/\s+/g, ' ')
          : node.type;
    if (!preserve) signatures.set(node, value);
    return value;
  };
  const equal = (a: RootContent, b: RootContent) => signature(a) === signature(b);
  const location = (node: RootContent, side: MarkdownSide) =>
    node.position ? { side, start: node.position.start.line, end: node.position.end.line } : undefined;
  const prepare = (node: RootContent, side: MarkdownSide): RootContent => {
    const copy = structuredClone(node);
    const source = side === 'before' ? request.beforeSource : request.afterSource;
    const prefix = 'md-' + createHash('sha256').update(JSON.stringify(source)).digest('hex').slice(0, 12) + '-';
    const visit = (n: RootContent) => {
      if (n.type !== 'element') return;
      if (typeof n.properties.href === 'string')
        n.properties.href = githubMarkdownUrl(n.properties.href, false, source);
      if (typeof n.properties.src === 'string') n.properties.src = githubMarkdownUrl(n.properties.src, true, source);
      if (typeof n.properties.id === 'string') n.properties.id = prefix + n.properties.id.replace(/^user-content-/, '');
      if (typeof n.properties.href === 'string' && n.properties.href.startsWith('#'))
        n.properties.href = '#' + prefix + n.properties.href.slice(1).replace(/^user-content-/, '');
      else if (n.tagName === 'a') {
        n.properties.target = '_blank';
        n.properties.rel = ['noopener', 'noreferrer'];
      }
      if (n.position)
        Object.assign(n.properties, {
          'data-md-side': side,
          'data-md-start': n.position.start.line,
          'data-md-end': n.position.end.line,
        });
      n.children.forEach(visit);
    };
    visit(copy);
    return copy;
  };
  const mark = (node: RootContent, change: 'added' | 'removed', side: MarkdownSide): RootContent => {
    const copy = prepare(node, side);
    if (copy.type === 'element') {
      copy.properties['data-md-change'] = change;
      return copy;
    }
    return element(change === 'added' ? 'ins' : 'del', [copy], { 'data-md-change': change });
  };
  const sequence = (oldNodes: RootContent[], newNodes: RootContent[]): RootContent[] => {
    const parts = diffArrays(oldNodes, newNodes, { comparator: equal, timeout: 150, maxEditLength: 1500 });
    if (!parts)
      return [...oldNodes.map((n) => mark(n, 'removed', 'before')), ...newNodes.map((n) => mark(n, 'added', 'after'))];
    const result: RootContent[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.removed && parts[i + 1]?.added) {
        const additions = parts[++i].value;
        const count = Math.max(part.value.length, additions.length);
        for (let j = 0; j < count; j++) {
          const a = part.value.at(j),
            b = additions.at(j);
          result.push(
            ...(a && b ? compare(a, b) : a ? [mark(a, 'removed', 'before')] : b ? [mark(b, 'added', 'after')] : [])
          );
        }
      } else
        result.push(
          ...part.value.map((n) =>
            part.removed ? mark(n, 'removed', 'before') : part.added ? mark(n, 'added', 'after') : prepare(n, 'after')
          )
        );
    }
    return result;
  };
  const compare = (a: RootContent, b: RootContent): RootContent[] => {
    if (equal(a, b)) return [prepare(b, 'after')];
    if (a.type === 'text' && b.type === 'text') {
      const changes = diffWordsWithSpace(a.value.replace(/\s+/g, ' '), b.value.replace(/\s+/g, ' '), {
        timeout: 100,
        maxEditLength: 2000,
      });
      return changes
        ? changes.map((c) =>
            c.added || c.removed
              ? element(c.added ? 'ins' : 'del', [text(c.value)], { 'data-md-change': c.added ? 'added' : 'removed' })
              : text(c.value)
          )
        : [mark(a, 'removed', 'before'), mark(b, 'added', 'after')];
    }
    if (
      a.type === 'element' &&
      b.type === 'element' &&
      a.tagName === 'pre' &&
      b.tagName === 'pre' &&
      !isDiagramCode(a) &&
      !isDiagramCode(b) &&
      codeLanguage(a) === codeLanguage(b)
    ) {
      const content = (n: RootContent): string =>
        n.type === 'text' ? n.value : n.type === 'element' ? n.children.map(content).join('') : '';
      const differences = diffLines(content(a), content(b), { timeout: 100, maxEditLength: 2000 });
      if (differences) {
        const copy = prepare(b, 'after') as Element;
        const code = copy.children.find((n) => n.type === 'element' && n.tagName === 'code');
        if (code?.type === 'element') {
          code.children = differences.flatMap((part) =>
            part.value
              .replace(/\n$/, '')
              .split('\n')
              .map((value) =>
                element('span', [text(value)], {
                  'data-code-line': true,
                  ...(part.added || part.removed ? { 'data-md-change': part.added ? 'added' : 'removed' } : {}),
                })
              )
          );
          return [copy];
        }
      }
    }
    if (
      a.type === 'element' &&
      b.type === 'element' &&
      a.tagName === b.tagName &&
      !atomic.has(b.tagName) &&
      JSON.stringify(a.properties) === JSON.stringify(b.properties)
    ) {
      const copy = prepare(b, 'after') as Element;
      copy.children = sequence(a.children, b.children) as Element['children'];
      return [copy];
    }
    // Surface invisible destination changes as well as changed link text.
    if (
      a.type === 'element' &&
      b.type === 'element' &&
      a.tagName === 'a' &&
      b.tagName === 'a' &&
      a.properties.href !== b.properties.href
    ) {
      return [
        mark(a, 'removed', 'before'),
        text(' '),
        mark(b, 'added', 'after'),
        element(
          'span',
          [
            text(' (link: '),
            element('del', [text(a.properties.href ?? '')]),
            text(' → '),
            element('ins', [text(b.properties.href ?? '')]),
            text(')'),
          ],
          { className: ['md-link-change'] }
        ),
      ];
    }
    return [mark(a, 'removed', 'before'), mark(b, 'added', 'after')];
  };
  const parts = diffArrays(before.children, after.children, {
    comparator: equal,
    timeout: 250,
    maxEditLength: 2000,
  }) ?? [
    { removed: true, added: false, value: before.children },
    { removed: false, added: true, value: after.children },
  ];
  const removed = parts.filter((p) => p.removed).flatMap((p) => p.value);
  const added = parts.filter((p) => p.added).flatMap((p) => p.value);
  const counts = (nodes: RootContent[]) => {
    const values = new Map<string, number>();
    for (const node of nodes) {
      const key = signature(node);
      values.set(key, (values.get(key) ?? 0) + 1);
    }
    return values;
  };
  const oldCounts = counts(removed),
    newCounts = counts(added);
  const moved = new Map(
    removed
      .filter((n) => oldCounts.get(signature(n)) === 1 && newCounts.get(signature(n)) === 1)
      .map((n) => [signature(n), n])
  );
  const blocks: MarkdownReviewBlock[] = [];
  const block = (a: RootContent | undefined, b: RootContent | undefined, change: MarkdownReviewBlock['change']) => {
    blocks.push({
      id: `block-${blocks.length}`,
      change,
      before: a && location(a, 'before'),
      after: b && location(b, 'after'),
      tree: root(a && b ? compare(a, b) : b ? [prepare(b, 'after')] : a ? [prepare(a, 'before')] : []),
    });
  };
  let oldIndex = 0,
    newIndex = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.added && !part.removed) {
      for (let n = 0; n < part.value.length; n++)
        block(before.children[oldIndex++], after.children[newIndex++], 'unchanged');
    } else if (part.removed) {
      oldIndex += part.value.length;
      const additions = parts[i + 1]?.added ? parts[++i].value : [];
      newIndex += additions.length;
      const oldNodes = part.value.filter((n) => !moved.has(signature(n)));
      let old = 0;
      for (const b of additions) {
        const movedFrom = moved.get(signature(b));
        if (movedFrom) {
          block(movedFrom, b, 'moved');
          continue;
        }
        const a = oldNodes.at(old++);
        if (
          a &&
          a.type === 'element' &&
          b.type === 'element' &&
          a.tagName === b.tagName &&
          (!atomic.has(a.tagName) ||
            (a.tagName === 'pre' && !isDiagramCode(a) && !isDiagramCode(b) && codeLanguage(a) === codeLanguage(b)))
        )
          block(a, b, 'changed');
        else {
          if (a) block(a, undefined, 'removed');
          block(undefined, b, 'added');
        }
      }
      for (const a of oldNodes.slice(old)) block(a, undefined, 'removed');
    } else {
      newIndex += part.value.length;
      for (const b of part.value)
        block(
          moved.has(signature(b)) ? moved.get(signature(b)) : undefined,
          b,
          moved.has(signature(b)) ? 'moved' : 'added'
        );
    }
  }
  const clean = root(after.children.map((n) => prepare(n, 'after')));
  for (const tree of [clean, ...blocks.map((block) => block.tree)]) await highlightMarkdownCode(tree);
  return {
    blocks,
    clean,
    deleted: request.after === null,
    sourceOnly: request.before !== request.after && blocks.every((b) => b.change === 'unchanged'),
  };
}
