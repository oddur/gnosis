import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { cn } from '@/lib/utils';

interface Props {
  children: string;
  className?: string;
}

// Editorial register for Markdown content. Headings get the
// brand serif. Inline code is warm-paper-tinted JetBrains Mono.
// Anchors use the dotted-claret editorial underline (NOT a blue
// web link). Blockquote uses a 1px gutter rule, never the banned
// >1px side-stripe. Lists are properly indented with comfortable
// gaps. All sized in em so the styles scale with parent font-size.
const components: Components = {
  h1: ({ children }) => (
    <h1 className="font-serif text-xl font-semibold mt-4 mb-2 text-foreground tracking-tight">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="font-serif text-lg font-semibold mt-3 mb-1.5 text-foreground tracking-tight">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="font-serif text-base font-semibold mt-2 mb-1 text-foreground">{children}</h3>
  ),
  p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="list-disc pl-5 mb-3 last:mb-0 space-y-1.5 marker:text-muted-foreground">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 mb-3 last:mb-0 space-y-1.5 marker:text-muted-foreground">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="border-l border-border pl-4 italic text-muted-foreground my-3 last:mb-0">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-foreground underline decoration-dotted decoration-[var(--ring)] underline-offset-[3px] hover:decoration-solid transition-[text-decoration-style]"
    >
      {children}
    </a>
  ),
  code: ({ className, children }) => {
    const isBlock = className?.startsWith('language-');
    if (isBlock) {
      return (
        <code
          className={`block bg-muted/50 rounded-md p-3 text-xs font-mono overflow-x-auto whitespace-pre mb-3 last:mb-0 ${className ?? ''}`}
        >
          {children}
        </code>
      );
    }
    return (
      <code className="font-mono text-[0.9em] font-medium bg-[oklch(0.55_0.012_65/8%)] dark:bg-[oklch(0.7_0.012_65/12%)] border border-[oklch(0.55_0.012_65/18%)] dark:border-[oklch(0.7_0.012_65/24%)] rounded-[3px] px-[0.35em] py-[0.05em] text-foreground">
        {children}
      </code>
    );
  },
  pre: ({ children }) => <>{children}</>,
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
};

export function Markdown({ children, className }: Props) {
  return (
    <div className={cn('select-text', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
