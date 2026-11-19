import { markdownHeadings } from './MarkdownHeadings';
import { Children, isValidElement, memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { MarkdownImage } from './Markdown';
import { nameMarkdownTasks } from '../lib/markdown-tasks';
import { countRender } from '../lib/render-count';

const REMARK = [remarkGfm];
// GitHub renders the HTML comments carry, such as a bot's <details> disclosure, and drops what is unsafe. The same
// policy as PR descriptions (Markdown.tsx): raw HTML, then GitHub's sanitize schema. HTML comments are dropped.
const REHYPE = [rehypeRaw, rehypeSanitize, nameMarkdownTasks];

const commentComponents: Components = {
  ...markdownHeadings,
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        if (href && /^https?:\/\//.test(href)) void window.electronAPI.openExternal(href);
      }}
    >
      {children}
    </a>
  ),
  img: ({ src, ...props }) => <MarkdownImage key={src} src={src} {...props} authenticate />,
  pre: ({ children }) => {
    const suggestion = Children.toArray(children).some(
      (child) => isValidElement<{ className?: string }>(child) && child.props.className === 'language-suggestion'
    );
    return suggestion ? (
      <div className="comment-suggestion">
        <span>Suggested change</span>
        <pre>{children}</pre>
      </div>
    ) : (
      <pre>{children}</pre>
    );
  },
};

/**
 * The same rendering policy for a draft preview and a saved GitHub comment. react-markdown parses on
 * every render, so the comment renders only when its text changes.
 */
export const CommentMarkdown = memo(function CommentMarkdown({ children }: { children: string }) {
  countRender('CommentMarkdown');
  return (
    <div className="github-comment-body select-text">
      <ReactMarkdown
        remarkPlugins={REMARK}
        rehypePlugins={REHYPE}
        components={commentComponents}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
