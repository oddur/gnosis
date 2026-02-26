import { useState, useMemo } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import { parseDiffLines, buildSplitRows, type DiffLineInfo, type SplitRow } from '@/lib/diff-lines';
import type { DiffHunk, PendingReviewComment } from '@/lib/types';
import { FilePathLink } from '@/components/FilePathLink';
import {
  type CommentCallbacks,
  parseShikiLines,
  extractShikiStyles,
  InlineCommentForm,
  CommentBubble,
} from '@/components/shared-diff-utils';

interface SplitDiffHunkGroupProps {
  filePath: string;
  hunks: DiffHunk[];
  pendingComments?: PendingReviewComment[];
  slideIndex?: number;
  commentCallbacks?: CommentCallbacks;
  gitFileUrlBase?: string | null;
}

function SplitDiffCell({
  info,
  html,
  cellClass,
  isInteractive,
  onClickLine,
}: {
  info: DiffLineInfo | null;
  html: string | null;
  cellClass: string;
  isInteractive: boolean;
  onClickLine: (info: DiffLineInfo) => void;
}) {
  const lineNum =
    info?.type === 'context' ? info.lineNumber : info?.type === 'remove' ? info.baseLineNumber : info?.headLineNumber;

  return (
    <>
      {isInteractive && (
        <span
          className={`split-diff-comment-icon ${cellClass}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: info ? 'pointer' : 'default',
          }}
          onClick={() => info && onClickLine(info)}
        >
          {info && (
            <MessageSquarePlus
              style={{ width: '0.75rem', height: '0.75rem', color: '#58a6ff', opacity: 0 }}
              className="split-icon-hover"
            />
          )}
        </span>
      )}
      <span
        className={`split-diff-line-num ${cellClass}`}
        style={{
          textAlign: 'right',
          paddingRight: '0.5ch',
          color: 'rgba(255,255,255,0.3)',
          userSelect: 'none',
          fontSize: '0.75rem',
          cursor: isInteractive && info ? 'pointer' : 'default',
        }}
        onClick={() => isInteractive && info && onClickLine(info)}
      >
        {lineNum ?? ''}
      </span>
      <span
        className={`split-diff-code select-text ${cellClass}`}
        style={{ paddingLeft: '0.5ch', paddingRight: '1ch', whiteSpace: 'pre' }}
      >
        {html ? <span dangerouslySetInnerHTML={{ __html: html }} /> : null}
      </span>
    </>
  );
}

function SplitHunk({
  hunk,
  filePath,
  pendingComments,
  slideIndex,
  commentCallbacks,
}: {
  hunk: DiffHunk;
  filePath: string;
  pendingComments: PendingReviewComment[];
  slideIndex: number;
  commentCallbacks?: CommentCallbacks;
}) {
  const [activeFormKey, setActiveFormKey] = useState<string | null>(null);

  const lineInfos = useMemo(() => parseDiffLines(hunk.hunkHeader, hunk.content), [hunk.hunkHeader, hunk.content]);
  const lineHtmls = useMemo(() => parseShikiLines(hunk.renderedHtml), [hunk.renderedHtml]);
  const shikiStyles = useMemo(() => extractShikiStyles(hunk.renderedHtml), [hunk.renderedHtml]);

  const splitRows = useMemo(() => {
    if (!lineHtmls || lineInfos.length === 0 || lineHtmls.length < lineInfos.length) return null;
    return buildSplitRows(lineInfos, lineHtmls);
  }, [lineInfos, lineHtmls]);

  if (!splitRows) {
    return <div className="select-text" dangerouslySetInnerHTML={{ __html: hunk.renderedHtml }} />;
  }

  const isInteractive = !!commentCallbacks;

  function handleAddComment(info: DiffLineInfo) {
    setActiveFormKey(`${info.lineNumber}:${info.side}`);
  }

  function handleSubmitComment(body: string, info: DiffLineInfo) {
    commentCallbacks?.onAddComment({
      filePath,
      line: info.lineNumber,
      side: info.side,
      body,
      hunkHeader: hunk.hunkHeader,
      codeSnippet: info.text,
      slideIndex,
    });
    setActiveFormKey(null);
  }

  const gridTemplateColumns = isInteractive ? '1.25rem 3.5ch 1fr 1px 1.25rem 3.5ch 1fr' : '3.5ch 1fr 1px 3.5ch 1fr';
  const gridColumnCount = isInteractive ? 7 : 5;

  return (
    <div
      className={shikiStyles.preClass}
      style={{
        ...shikiStyles.preStyle,
        overflow: 'auto',
        fontFamily: 'var(--font-mono)',
        fontSize: '0.8125rem',
        lineHeight: '1.5',
      }}
    >
      <div
        className="split-diff-grid"
        style={{ display: 'grid', gridTemplateColumns, minWidth: '100%', width: 'max-content' }}
      >
        {splitRows.map((row, rowIdx) => {
          const leftInfo = row.left?.info ?? null;
          const rightInfo = row.right?.info ?? null;

          const leftCellClass =
            leftInfo?.type === 'remove' ? 'split-diff-cell-remove' : !row.left ? 'split-diff-cell-empty' : '';
          const rightCellClass =
            rightInfo?.type === 'add' ? 'split-diff-cell-add' : !row.right ? 'split-diff-cell-empty' : '';

          const leftFormKey = leftInfo ? `${leftInfo.lineNumber}:${leftInfo.side}` : null;
          const rightFormKey = rightInfo ? `${rightInfo.lineNumber}:${rightInfo.side}` : null;
          const showLeftForm = isInteractive && activeFormKey === leftFormKey;
          const showRightForm = isInteractive && activeFormKey === rightFormKey;

          const leftComments =
            isInteractive && leftInfo
              ? pendingComments.filter(
                  (c) => c.line === leftInfo.lineNumber && c.side === leftInfo.side && c.filePath === filePath
                )
              : [];
          const rightComments =
            isInteractive && rightInfo
              ? pendingComments.filter(
                  (c) => c.line === rightInfo.lineNumber && c.side === rightInfo.side && c.filePath === filePath
                )
              : [];

          const fullSpan = { gridColumn: `1 / ${gridColumnCount + 1}` };

          return (
            <SplitDiffRowFragment
              key={rowIdx}
              row={row}
              leftCellClass={leftCellClass}
              rightCellClass={rightCellClass}
              isInteractive={isInteractive}
              onClickLine={handleAddComment}
              showLeftForm={showLeftForm}
              showRightForm={showRightForm}
              leftInfo={leftInfo}
              rightInfo={rightInfo}
              leftComments={leftComments}
              rightComments={rightComments}
              fullSpan={fullSpan}
              onSubmitComment={handleSubmitComment}
              onCancelForm={() => setActiveFormKey(null)}
              commentCallbacks={commentCallbacks}
            />
          );
        })}
      </div>
    </div>
  );
}

function SplitDiffRowFragment({
  row,
  leftCellClass,
  rightCellClass,
  isInteractive,
  onClickLine,
  showLeftForm,
  showRightForm,
  leftInfo,
  rightInfo,
  leftComments,
  rightComments,
  fullSpan,
  onSubmitComment,
  onCancelForm,
  commentCallbacks,
}: {
  row: SplitRow;
  leftCellClass: string;
  rightCellClass: string;
  isInteractive: boolean;
  onClickLine: (info: DiffLineInfo) => void;
  showLeftForm: boolean | string | null;
  showRightForm: boolean | string | null;
  leftInfo: DiffLineInfo | null;
  rightInfo: DiffLineInfo | null;
  leftComments: PendingReviewComment[];
  rightComments: PendingReviewComment[];
  fullSpan: React.CSSProperties;
  onSubmitComment: (body: string, info: DiffLineInfo) => void;
  onCancelForm: () => void;
  commentCallbacks?: CommentCallbacks;
}) {
  return (
    <>
      <SplitDiffCell
        info={row.left?.info ?? null}
        html={row.left?.html ?? null}
        cellClass={leftCellClass}
        isInteractive={isInteractive}
        onClickLine={onClickLine}
      />

      <span className="split-diff-separator" />

      <SplitDiffCell
        info={row.right?.info ?? null}
        html={row.right?.html ?? null}
        cellClass={rightCellClass}
        isInteractive={isInteractive}
        onClickLine={onClickLine}
      />

      {showLeftForm && leftInfo && (
        <div style={fullSpan}>
          <InlineCommentForm onSubmit={(body) => onSubmitComment(body, leftInfo)} onCancel={onCancelForm} />
        </div>
      )}
      {commentCallbacks &&
        leftComments.map((c) => (
          <div key={c.id} style={fullSpan}>
            <CommentBubble
              comment={c}
              onRemove={commentCallbacks.onRemoveComment}
              onEdit={commentCallbacks.onEditComment}
            />
          </div>
        ))}
      {showRightForm && rightInfo && (
        <div style={fullSpan}>
          <InlineCommentForm onSubmit={(body) => onSubmitComment(body, rightInfo)} onCancel={onCancelForm} />
        </div>
      )}
      {commentCallbacks &&
        rightComments.map((c) => (
          <div key={c.id} style={fullSpan}>
            <CommentBubble
              comment={c}
              onRemove={commentCallbacks.onRemoveComment}
              onEdit={commentCallbacks.onEditComment}
            />
          </div>
        ))}
    </>
  );
}

export function SplitDiffHunkGroup({
  filePath,
  hunks,
  pendingComments = [],
  slideIndex = 0,
  commentCallbacks,
  gitFileUrlBase,
}: SplitDiffHunkGroupProps) {
  const fileCommentCount = pendingComments.filter((c) => c.filePath === filePath).length;

  return (
    <div className="rounded-md border overflow-x-auto">
      <div className="bg-muted/50 px-3 py-2 font-mono text-xs text-muted-foreground border-b truncate flex items-center justify-between">
        <FilePathLink filePath={filePath} gitFileUrlBase={gitFileUrlBase} />
        {commentCallbacks && fileCommentCount > 0 && (
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
          <SplitHunk
            hunk={hunk}
            filePath={filePath}
            pendingComments={pendingComments}
            slideIndex={slideIndex}
            commentCallbacks={commentCallbacks}
          />
        </div>
      ))}
    </div>
  );
}
