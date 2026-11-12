import { markdownHeadings } from './MarkdownHeadings';
import { LoadingIndicator } from './LoadingState';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { Children, isValidElement, memo, useMemo, useState, type ComponentProps } from 'react';
import type { PluggableList } from 'unified';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { githubMarkdownUrl, sameMarkdownProps, type GitHubMarkdownSource } from '../lib/github-markdown';
import { isGitHubImageUrl } from '../lib/github-image';
import { cn } from '@/lib/utils';
import { nameMarkdownTasks } from '../lib/markdown-tasks';
import { scopeMarkdownHeadings } from '../lib/markdown-headings';
import { MermaidDiagram } from './MermaidDiagram';
import { D2Diagram } from './D2Diagram';
import { countRender } from '../lib/render-count';

interface Props {
  children: string;
  className?: string;
  githubSource?: GitHubMarkdownSource;
  headingLevel?: number;
}

export function MarkdownImage({
  src,
  alt,
  title,
  width,
  height,
  authenticate = false,
}: React.ComponentProps<'img'> & { authenticate?: boolean }) {
  const [failed, setFailed] = useState(false);
  const [authenticatedSrc, setAuthenticatedSrc] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const onError = () => {
    if (!attempted && authenticate && src && isGitHubImageUrl(src)) {
      setAttempted(true);
      setLoading(true);
      void window.electronAPI
        .loadPrImage(src)
        .then(setAuthenticatedSrc)
        .catch(() => setFailed(true))
        .finally(() => setLoading(false));
    } else setFailed(true);
  };
  if (failed || !src)
    return (
      <span className="markdown-image-fallback">
        {alt || 'Image'} — unavailable here. Open the PR on GitHub to view it.
      </span>
    );
  if (loading)
    return (
      <LoadingIndicator className="markdown-image-fallback">Loading {alt || 'image'}…</LoadingIndicator>
    );
  return (
    <img
      src={authenticatedSrc ?? src}
      alt={alt ?? ''}
      title={title}
      width={width}
      height={height}
      loading="lazy"
      decoding="async"
      className="markdown-image"
      onError={onError}
    />
  );
}

// Shared reading roles keep heading hierarchy consistent across Markdown surfaces.
// Code uses the selected monospace family; prose follows its reading container.
const components: Components = {
  ...markdownHeadings,
  p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
  ul: ({ children, className }) => (
    <ul className={cn('list-disc pl-5 mb-3 last:mb-0 space-y-1.5 marker:text-muted-foreground', className)}>
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-5 mb-3 last:mb-0 space-y-1.5 marker:text-muted-foreground">{children}</ol>
  ),
  li: ({ children }) => <li>{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="border-l border-border pl-4 text-foreground my-3 last:mb-0">{children}</blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target={href?.startsWith('#') ? undefined : '_blank'}
      rel="noopener noreferrer"
      className="text-foreground underline decoration-dotted decoration-[var(--ring)] underline-offset-[3px] hover:decoration-solid transition-[text-decoration-style]"
    >
      {children}
    </a>
  ),
  code: ({ className, children }) => (
    <code
      className={cn(
        'font-mono text-[0.9em] font-medium bg-muted/50 border border-border/60 rounded-[3px] px-[0.35em] py-[0.05em] text-foreground',
        className
      )}
    >
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="markdown-code-block" tabIndex={0} aria-label="Code block">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto my-3 last:mb-0" role="region" aria-label="Scrollable table" tabIndex={0}>
      <table className="min-w-full text-sm border-collapse">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border px-2 py-1 text-left font-medium bg-muted/30">{children}</th>
  ),
  td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
  hr: () => <hr className="border-border my-4" />,
  img: ({ src, ...props }) => <MarkdownImage key={src} src={src} {...props} />,
};

export function GitHubCodeBlock({ children, ...props }: ComponentProps<'pre'>) {
  const code = Children.toArray(children)[0];
  if (
    isValidElement<ComponentProps<'code'>>(code) &&
    code.props.className?.split(/\s+/).includes('language-d2') &&
    typeof code.props.children === 'string'
  ) {
    return <D2Diagram diagram={{ source: code.props.children.trimEnd() }} />;
  }

  if (
    isValidElement<ComponentProps<'code'>>(code) &&
    code.props.className?.split(/\s+/).includes('language-mermaid') &&
    typeof code.props.children === 'string'
  ) {
    return <MermaidDiagram chart={code.props.children.trimEnd()} />;
  }
  return (
    <pre {...props} tabIndex={0} aria-label="Code block">
      {children}
    </pre>
  );
}

// Stable component identities preserve authenticated image state across queue polls.
const githubComponents: Components = {
  ...components,
  img: ({ src, ...props }) => <MarkdownImage key={src} src={src} {...props} authenticate />,
  pre: GitHubCodeBlock,
  code: ({ children, className }) => <code className={className}>{children}</code>,
  table: ({ children }) => (
    <div className="pr-table-scroll" role="region" aria-label="Scrollable PR table" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
};

// Plugin lists are module constants, so react-markdown sees the same configuration on every render.
const REMARK: PluggableList = [remarkGfm];
const PLAIN: PluggableList = [nameMarkdownTasks];
const GITHUB: PluggableList = [rehypeRaw, rehypeSanitize, nameMarkdownTasks];
const githubWithHeadings = new Map<number, PluggableList>();
function githubPlugins(headingLevel?: number): PluggableList {
  if (!headingLevel) return GITHUB;
  let plugins = githubWithHeadings.get(headingLevel);
  if (!plugins) {
    plugins = [...GITHUB, [scopeMarkdownHeadings, { startLevel: headingLevel }]];
    githubWithHeadings.set(headingLevel, plugins);
  }
  return plugins;
}

/**
 * react-markdown parses its text on every render, so Markdown renders only when a prop changes. A
 * GitHub source compares by its fields, because callers often build a new one on each render.
 */
export const Markdown = memo(function Markdown({ children, className, githubSource, headingLevel }: Props) {
  countRender('Markdown');
  const repo = githubSource?.repo,
    ref = githubSource?.ref,
    path = githubSource?.path;
  const urlTransform = useMemo(
    () =>
      repo === undefined || ref === undefined
        ? undefined
        : (url: string, key: string) => githubMarkdownUrl(url, key === 'src', { repo, ref, path }),
    [repo, ref, path]
  );
  return (
    <div className={cn('markdown-body select-text', className)}>
      <ReactMarkdown
        remarkPlugins={REMARK}
        rehypePlugins={githubSource ? githubPlugins(headingLevel) : PLAIN}
        urlTransform={urlTransform}
        components={githubSource ? githubComponents : components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}, sameMarkdownProps);
