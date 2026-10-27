import type { DiffHunk, FileMetadata } from './types';
import type { MarkdownReviewRequest } from './markdown-review';
import type { Root, RootContent } from 'hast';
import { prepareReviewHunk } from './review-diff';
import { buildMarkdownReview } from './markdown-review-engine';

export interface ExplanationMarkdownRequest {
  kind: 'explanation';
  hunks: DiffHunk[];
  fileStatus?: FileMetadata['status'];
  beforeSource: MarkdownReviewRequest['beforeSource'];
  afterSource: MarkdownReviewRequest['afterSource'];
}

/** Compare only saved topic sections. No moving-branch reads or invented lines between hunks. */
export async function buildExplanationMarkdown(request: ExplanationMarkdownRequest) {
  const groups: { before: Map<number, string>; after: Map<number, string> }[] = [];
  const end = (lines: Map<number, string>) => Math.max(0, ...lines.keys());
  const start = (lines: Map<number, string>) => Math.min(Infinity, ...lines.keys());
  for (const hunk of [...request.hunks].sort((a, b) => {
    const first = prepareReviewHunk(a, request.fileStatus)?.lines[0];
    const second = prepareReviewHunk(b, request.fileStatus)?.lines[0];
    return (
      (first?.headLineNumber ?? first?.baseLineNumber ?? 0) - (second?.headLineNumber ?? second?.baseLineNumber ?? 0)
    );
  })) {
    const prepared = prepareReviewHunk(hunk, request.fileStatus);
    if (!prepared) throw new Error('This saved section cannot be rendered. Use Source to review it.');
    const next = { before: new Map<number, string>(), after: new Map<number, string>() };
    for (const line of prepared.lines) {
      if (line.baseLineNumber !== null) next.before.set(line.baseLineNumber, line.text);
      if (line.headLineNumber !== null) next.after.set(line.headLineNumber, line.text);
    }
    const last = groups.at(-1);
    const adjacent =
      last &&
      (['before', 'after'] as const).every(
        (side) => !last[side].size || !next[side].size || start(next[side]) <= end(last[side]) + 1
      );
    if (last && adjacent) {
      for (const side of ['before', 'after'] as const)
        for (const [line, text] of next[side]) {
          if (last[side].has(line) && last[side].get(line) !== text)
            throw new Error('Saved sections disagree at this line. Use Source to review them.');
          last[side].set(line, text);
        }
    } else groups.push(next);
  }
  const blocks = [],
    clean: Root = { type: 'root', children: [] };
  let sourceOnly = true;
  const deleted = request.fileStatus === 'deleted';
  for (const [index, group] of groups.entries()) {
    const beforeStart = group.before.size ? start(group.before) : 1;
    const afterStart = group.after.size ? start(group.after) : 1;
    const content = (lines: Map<number, string>) =>
      lines.size
        ? [...lines]
            .sort(([a], [b]) => a - b)
            .map(([, value]) => value)
            .join('\n')
        : null;
    const section = await buildMarkdownReview({
      before: content(group.before),
      after: content(group.after),
      beforeSource: request.beforeSource,
      afterSource: request.afterSource,
    });
    const offset = (node: Root | RootContent) => {
      if (node.type === 'element') {
        const side = node.properties['data-md-side'];
        if (side === 'before' || side === 'after')
          for (const field of ['data-md-start', 'data-md-end']) {
            if (typeof node.properties[field] === 'number')
              node.properties[field] += (side === 'before' ? beforeStart : afterStart) - 1;
          }
      }
      if (node.type === 'element' || node.type === 'root') node.children.forEach(offset);
    };
    sourceOnly &&= section.sourceOnly;
    if (index) {
      const gap: Root = {
        type: 'root',
        children: [
          {
            type: 'element',
            tagName: 'p',
            properties: { className: ['markdown-review-notice'] },
            children: [{ type: 'text', value: 'Between saved sections' }],
          },
        ],
      };
      blocks.push({ id: `gap-${index}`, change: 'unchanged' as const, sourceGap: true, tree: gap });
      clean.children.push(...gap.children);
    }
    for (const block of section.blocks) {
      block.id = `section-${index}-${block.id}`;
      for (const side of ['before', 'after'] as const)
        if (block[side]) {
          block[side].start += (side === 'before' ? beforeStart : afterStart) - 1;
          block[side].end += (side === 'before' ? beforeStart : afterStart) - 1;
        }
      offset(block.tree);
      blocks.push(block);
    }
    offset(section.clean);
    clean.children.push(...section.clean.children);
  }
  return { blocks, clean, sourceOnly, deleted, excerpt: true };
}
