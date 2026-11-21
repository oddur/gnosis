import { Component, Suspense, type ComponentProps, type ComponentType, type ReactNode } from 'react';
import { lazyComponent } from '../lib/lazy-screen';
import type { Markdown as MarkdownComponent } from './Markdown';
import { cn } from '../lib/utils';

interface MarkdownProps {
  children: string;
  className?: string;
}

/** Shows the plain text when the renderer fails to load: Markdown is never worth losing the screen around it. */
class PlainOnError extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * A Markdown renderer loaded on first use. Until it loads, and if it fails to, the text shows as plain text in
 * `className` (with the caller's own class), so the screen keeps its content and never crashes on a failed import.
 */
export function lazyMarkdownComponent<P extends MarkdownProps>(
  loader: () => Promise<ComponentType<P>>,
  className: string
) {
  const Renderer = lazyComponent(loader);
  function LazyMarkdownRenderer(props: P) {
    const plain = <div className={cn(className, 'whitespace-pre-wrap', props.className)}>{props.children}</div>;
    return (
      <PlainOnError fallback={plain}>
        <Suspense fallback={plain}>
          <Renderer {...props} />
        </Suspense>
      </PlainOnError>
    );
  }
  return Object.assign(LazyMarkdownRenderer, { preload: Renderer.preload });
}

// The queue shows Markdown only in its detail pane, so the parser loads after first paint.
/** Markdown for screens in the startup bundle. Shows the raw text until the renderer has loaded. */
export const LazyMarkdown = lazyMarkdownComponent<ComponentProps<typeof MarkdownComponent>>(
  () => import('./Markdown').then((module) => module.Markdown),
  'markdown-body select-text'
);
export const preloadMarkdown = LazyMarkdown.preload;
