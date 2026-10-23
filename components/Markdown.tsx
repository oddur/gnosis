import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { Children, isValidElement, useState, type ComponentProps } from 'react';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { githubMarkdownUrl, type GitHubMarkdownSource } from '../lib/github-markdown';
import { isGitHubImageUrl } from '../lib/github-image';
import { cn } from '@/lib/utils';
import { scopeMarkdownHeadings } from '../lib/markdown-headings';
import { MermaidDiagram } from './MermaidDiagram';

interface Props {
  children: string;
  className?: string;
  githubSource?: GitHubMarkdownSource;
  headingLevel?: number;
}

function MarkdownImage({
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
      <span className="markdown-image-fallback" role="status">
        Loading {alt || 'image'}…
      </span>
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

// Relative heading sizes keep generated Markdown subordinate to the page/topic title.
// Code uses the selected monospace family; prose follows its reading container.
const components: Components = {
  h1: ({ children }) => (
    <h1 className="font-sans text-[1.2em] font-semibold leading-snug mt-5 mb-2 text-foreground tracking-tight text-balance">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="font-sans text-[1.1em] font-semibold leading-snug mt-4 mb-1.5 text-foreground tracking-tight text-balance">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="font-sans text-[1em] font-semibold leading-normal mt-3 mb-1 text-foreground text-balance">
      {children}
    </h3>
  ),
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
  pre: ({ children }) => <pre className="markdown-code-block">{children}</pre>,
  h4: ({ children }) => <h4 className="markdown-subheading">{children}</h4>,
  h5: ({ children }) => <h5 className="markdown-subheading">{children}</h5>,
  h6: ({ children }) => <h6 className="markdown-subheading">{children}</h6>,
  table: ({ children }) => (
    <div className="overflow-x-auto my-3 last:mb-0">
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

function GitHubCodeBlock({ children }: ComponentProps<'pre'>) {
  const code = Children.toArray(children)[0];
  if (
    isValidElement<ComponentProps<'code'>>(code) &&
    code.props.className?.split(/\s+/).includes('language-mermaid') &&
    typeof code.props.children === 'string'
  ) {
    return <MermaidDiagram chart={code.props.children.trimEnd()} />;
  }
  return <pre>{children}</pre>;
}

// Stable component identities preserve authenticated image state across queue polls.
const githubComponents: Components = {
  ...components,
  img: ({ src, ...props }) => <MarkdownImage key={src} src={src} {...props} authenticate />,
  pre: GitHubCodeBlock,
  code: ({ children, className }) => <code className={className}>{children}</code>,
  h4: ({ children }) => <h4 className="pr-author-heading">{children}</h4>,
  h5: ({ children }) => <h5 className="pr-author-heading">{children}</h5>,
  h6: ({ children }) => <h6 className="pr-author-heading">{children}</h6>,
  table: ({ children }) => (
    <div className="pr-table-scroll" role="region" aria-label="Scrollable PR table" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
};

export function Markdown({ children, className, githubSource, headingLevel }: Props) {
  return (
    <div className={cn('markdown-body select-text', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={
          githubSource
            ? [
                rehypeRaw,
                rehypeSanitize,
                ...(headingLevel
                  ? [
                      [scopeMarkdownHeadings, { startLevel: headingLevel }] as [
                        typeof scopeMarkdownHeadings,
                        { startLevel: number },
                      ],
                    ]
                  : []),
              ]
            : []
        }
        urlTransform={githubSource ? (url, key) => githubMarkdownUrl(url, key === 'src', githubSource) : undefined}
        components={githubSource ? githubComponents : components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
