import { Children, isValidElement } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MarkdownImage } from './Markdown';
import { nameMarkdownTasks } from '../lib/markdown-tasks';

const commentComponents: Components = {
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

/** The same rendering policy for a draft preview and a saved GitHub comment. */
export function CommentMarkdown({ children }: { children: string }) {
  return (
    <div className="github-comment-body select-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[nameMarkdownTasks]}
        skipHtml
        components={commentComponents}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
