import { Suspense, type ComponentProps } from 'react';
import { lazyComponent } from '../lib/lazy-screen';
import type { Markdown as MarkdownComponent } from './Markdown';
import { cn } from '../lib/utils';

// The queue shows Markdown only in its detail pane, so the parser loads after first paint.
const Markdown = lazyComponent(() => import('./Markdown').then((module) => module.Markdown));
export const preloadMarkdown = Markdown.preload;

/** Markdown for screens in the startup bundle. Shows the raw text until the renderer has loaded. */
export function LazyMarkdown(props: ComponentProps<typeof MarkdownComponent>) {
  return (
    <Suspense fallback={<div className={cn('markdown-body select-text whitespace-pre-wrap', props.className)}>{props.children}</div>}>
      <Markdown {...props} />
    </Suspense>
  );
}
