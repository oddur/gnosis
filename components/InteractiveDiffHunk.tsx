import { useState, useMemo } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import { parseDiffLines, type DiffLineInfo } from '@/lib/diff-lines';
import type { DiffHunk, PendingReviewComment } from '@/lib/types';
import { FilePathLink } from '@/components/FilePathLink';
import {
  type CommentCallbacks,
  parseShikiLines,
  extractShikiStyles,
  InlineCommentForm,
  CommentBubble,
} from '@/components/shared-diff-utils';

interface InteractiveDiffHunkGroupProps extends CommentCallbacks {
  filePath: string;
  hunks: DiffHunk[];
  pendingComments: PendingReviewComment[];
  slideIndex: number;
  gitFileUrlBase?: string | null;
}

interface ParsedLine {
  info: DiffLineInfo;
  html: string;
}

function InteractiveHunk({
  hunk,
  filePath,
  pendingComments,
  slideIndex,
  onAddComment,
  onRemoveComment,
  onEditComment,
}: {
  hunk: DiffHunk;
  filePath: string;
  pendingComments: PendingReviewComment[];
  slideIndex: number;
} & CommentCallbacks) {
  const [activeFormLine, setActiveFormLine] = useState<number | null>(null);

  const lineInfos = useMemo(() => parseDiffLines(hunk.hunkHeader, hunk.content), [hunk.hunkHeader, hunk.content]);

  const lineHtmls = useMemo(() => parseShikiLines(hunk.renderedHtml), [hunk.renderedHtml]);
  const shikiStyles = useMemo(() => extractShikiStyles(hunk.renderedHtml), [hunk.renderedHtml]);

  // Fall back to non-interactive rendering if we can't align parsed lines with HTML.
  // Allow lineHtmls to have trailing extra elements (Shiki may add a trailing empty line span).
  if (!lineHtmls || lineInfos.length === 0 || lineHtmls.length < lineInfos.length) {
    if (lineHtmls && lineInfos.length > 0) {
      console.warn(
        `[InteractiveDiffHunk] Line count mismatch for ${filePath}: ` +
          `parsed=${lineInfos.length} html=${lineHtmls.length}, falling back to non-interactive`
      );
    }
    return <div dangerouslySetInnerHTML={{ __html: hunk.renderedHtml }} />;
  }

  const lines: ParsedLine[] = lineInfos.map((info, i) => ({
    info,
    html: lineHtmls[i],
  }));

  function handleAddComment(lineInfo: DiffLineInfo) {
    setActiveFormLine(lineInfo.lineNumber);
  }

  function handleSubmitComment(body: string, lineInfo: DiffLineInfo) {
    onAddComment({
      filePath,
      line: lineInfo.lineNumber,
      side: lineInfo.side,
      body,
      hunkHeader: hunk.hunkHeader,
      codeSnippet: lineInfo.text,
      slideIndex,
    });
    setActiveFormLine(null);
  }

  const hasDiff = lineInfos.some((l) => l.type !== 'context');

  return (
    <pre className={shikiStyles.preClass} style={shikiStyles.preStyle}>
      <code style={{ display: 'block', fontSize: 0, minWidth: '100%', width: 'max-content' }}>
        {lines.map((line, idx) => {
          const lineComments = pendingComments.filter(
            (c) => c.line === line.info.lineNumber && c.filePath === filePath
          );
          const isFormActive = activeFormLine === line.info.lineNumber;

          const diffClass = line.info.type === 'add' ? 'diff add' : line.info.type === 'remove' ? 'diff remove' : '';

          return (
            <span key={idx}>
              <span
                className={`line ${diffClass} interactive-line`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  fontSize: '0.8125rem',
                  lineHeight: '1.5',
                  paddingRight: '1.25rem',
                }}
              >
                {/* Line number gutter */}
                <span
                  className="line-number-gutter"
                  style={{
                    display: 'inline-block',
                    width: '3.5ch',
                    textAlign: 'right',
                    paddingRight: '0.5ch',
                    color: 'rgba(255,255,255,0.3)',
                    userSelect: 'none',
                    flexShrink: 0,
                    cursor: 'pointer',
                    fontSize: '0.75rem',
                  }}
                  onClick={() => handleAddComment(line.info)}
                  title={`Comment on line ${line.info.lineNumber}`}
                >
                  {line.info.lineNumber}
                </span>

                {/* Add comment icon (visible on hover via CSS) */}
                <span
                  className="add-comment-icon"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    width: '1.25rem',
                    flexShrink: 0,
                    opacity: 0,
                    cursor: 'pointer',
                  }}
                  onClick={() => handleAddComment(line.info)}
                >
                  <MessageSquarePlus style={{ width: '0.75rem', height: '0.75rem', color: '#58a6ff' }} />
                </span>

                {/* Diff gutter character */}
                {hasDiff && (
                  <span
                    style={{
                      display: 'inline-block',
                      width: '1ch',
                      marginRight: '1ch',
                      userSelect: 'none',
                      flexShrink: 0,
                      color:
                        line.info.type === 'add' ? '#3fb950' : line.info.type === 'remove' ? '#f85149' : 'transparent',
                    }}
                  >
                    {line.info.type === 'add' ? '+' : line.info.type === 'remove' ? '-' : ' '}
                  </span>
                )}

                {/* Code content */}
                <span dangerouslySetInnerHTML={{ __html: line.html }} style={{ flex: 1, minWidth: 0 }} />
              </span>

              {/* Comment form */}
              {isFormActive && (
                <InlineCommentForm
                  onSubmit={(body) => handleSubmitComment(body, line.info)}
                  onCancel={() => setActiveFormLine(null)}
                />
              )}

              {/* Pending comments for this line */}
              {lineComments.map((c) => (
                <CommentBubble key={c.id} comment={c} onRemove={onRemoveComment} onEdit={onEditComment} />
              ))}
            </span>
          );
        })}
      </code>
    </pre>
  );
}

export function InteractiveDiffHunkGroup({
  filePath,
  hunks,
  pendingComments,
  slideIndex,
  onAddComment,
  onRemoveComment,
  onEditComment,
  gitFileUrlBase,
}: InteractiveDiffHunkGroupProps) {
  // Count comments for this file
  const fileCommentCount = pendingComments.filter((c) => c.filePath === filePath).length;

  return (
    <div className="rounded-md border overflow-x-auto">
      <div className="bg-muted/50 px-3 py-2 font-mono text-xs text-muted-foreground border-b truncate flex items-center justify-between">
        <FilePathLink filePath={filePath} gitFileUrlBase={gitFileUrlBase} />
        {fileCommentCount > 0 && (
          <span className="ml-2 inline-flex items-center gap-1 text-blue-400">
            <MessageSquarePlus className="h-3 w-3" />
            {fileCommentCount}
          </span>
        )}
      </div>
      {hunks.map((hunk, i) => (
        <div key={i}>
          {i > 0 && <div className="border-t border-dashed border-muted" />}
          {hunk.hunkHeader && (
            <div className="bg-muted/30 px-3 py-1 font-mono text-xs text-muted-foreground border-b">
              {hunk.hunkHeader}
            </div>
          )}
          <InteractiveHunk
            hunk={hunk}
            filePath={filePath}
            pendingComments={pendingComments}
            slideIndex={slideIndex}
            onAddComment={onAddComment}
            onRemoveComment={onRemoveComment}
            onEditComment={onEditComment}
          />
        </div>
      ))}
    </div>
  );
}
