import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { cn } from '@/lib/utils';

interface Props {
  children: string;
  className?: string;
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
  ul: ({ children }) => (
    <ul className="list-disc pl-5 mb-3 last:mb-0 space-y-1.5 marker:text-muted-foreground">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-5 mb-3 last:mb-0 space-y-1.5 marker:text-muted-foreground">{children}</ol>
  ),
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
      <code className="font-mono text-[0.9em] font-medium bg-muted/50 border border-border/60 rounded-[3px] px-[0.35em] py-[0.05em] text-foreground">
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
