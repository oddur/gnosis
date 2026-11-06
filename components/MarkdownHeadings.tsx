import { createElement, type ComponentProps } from 'react';
import type { Components, ExtraProps } from 'react-markdown';
import { cn } from '../lib/utils';

function heading(tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6', level: number) {
  return function MarkdownHeading({ node, className, ...props }: ComponentProps<'h1'> & ExtraProps) {
    return createElement(tag, {
      ...props,
      className: cn('markdown-heading', className),
      // Semantic nesting can shift a PR description to h3–h6. Keep the source's visual hierarchy.
      'data-reading-level': node?.properties.dataReadingLevel ?? level,
    });
  };
}

export const markdownHeadings = {
  h1: heading('h1', 1),
  h2: heading('h2', 2),
  h3: heading('h3', 3),
  h4: heading('h4', 4),
  h5: heading('h5', 5),
  h6: heading('h6', 6),
} satisfies Components;
