import { useEffect, useMemo, useState } from 'react';
import type { ComponentProps } from 'react';
import type { ReviewGuide } from '../lib/types';
import type { MarkdownLocation, MarkdownReview } from '../lib/markdown-review';
import type { ExplanationMarkdownRequest } from '../lib/explanation-markdown';
import { sourceForPath } from '../lib/workbench';
import { useMarkdownView } from '../lib/use-markdown-view';
import { MarkdownReviewPreview } from './MarkdownReviewPreview';
import type { ReviewDiff } from './ReviewDiff';
import { InlineCodeExplanation } from './InlineCodeExplanation';
import { CommentBubble } from './shared-diff-utils';

type Props = ComponentProps<typeof ReviewDiff> & {
  review?: ReviewGuide;
  onSource: (location?: MarkdownLocation) => void;
  onAsk?: (text: string) => void;
};

/** Uses archived topic hunks, so local, imported and stale explanations need no new GitHub reads. */
export function ExplanationMarkdownPreview({ review, onSource, onAsk, ...diff }: Props) {
  const [view, change] = useMarkdownView();
  const [result, setResult] = useState<{ request: ExplanationMarkdownRequest; value: MarkdownReview }>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const request = useMemo<ExplanationMarkdownRequest>(() => {
    const origin = review ? sourceForPath(review, diff.filePath) : undefined;
    const member = origin?.member;
    const fallback = review?.prUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\//)?.[1];
    const path = origin?.path ?? diff.filePath;
    const previous = review?.changedFiles?.find((f) => f.filename === diff.filePath)?.previousFilename;
    return {
      kind: 'explanation',
      hunks: diff.hunks.map((hunk) => ({ ...hunk, renderedHtml: '' })),
      fileStatus: diff.fileStatus,
      beforeSource: {
        repo: member?.baseRepo ?? review?.baseRepo ?? fallback ?? '',
        ref: member?.baseSha ?? review?.baseSha ?? '',
        path: previous ? sourceForPath(review, previous).path : path,
      },
      afterSource: {
        repo: member?.headRepo ?? review?.headRepo ?? member?.baseRepo ?? review?.baseRepo ?? fallback ?? '',
        ref: member?.headSha ?? review?.headSha ?? '',
        path,
      },
    };
  }, [review, diff.filePath, diff.hunks, diff.fileStatus]);
  useEffect(() => {
    let live = true;
    setError('');
    void window.electronAPI
      .renderMarkdownReview(request)
      .then((value) => {
        if (live) setResult({ request, value });
      })
      .catch((error: unknown) => {
        if (live) setError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      live = false;
    };
  }, [request, attempt]);
  const annotations: ComponentProps<typeof MarkdownReviewPreview>['annotations'] = [
    ...(diff.inlineExplanations ?? [])
      .filter((note) => note.filePath === diff.filePath)
      .map((note) => ({
        lineNumber: note.line,
        side: note.side === 'LEFT' ? ('deletions' as const) : ('additions' as const),
        content: <InlineCodeExplanation explanation={note} />,
      })),
    ...(diff.threads ?? []).flatMap((thread) =>
      thread.line === null
        ? []
        : [
            {
              lineNumber: thread.line,
              side: thread.diffSide === 'LEFT' ? ('deletions' as const) : ('additions' as const),
              content: diff.renderThread?.(thread),
            },
          ]
    ),
    ...(diff.pendingComments ?? [])
      .filter((c) => c.filePath === diff.filePath)
      .map((comment) => ({
        lineNumber: comment.line,
        side: comment.side === 'LEFT' ? ('deletions' as const) : ('additions' as const),
        content: diff.commentCallbacks ? (
          <CommentBubble
            comment={comment}
            onEdit={diff.commentCallbacks.onEditComment}
            onRemove={diff.commentCallbacks.onRemoveComment}
          />
        ) : (
          <p>{comment.body}</p>
        ),
      })),
  ];
  if (result?.request !== request)
    return (
      <div className="markdown-preview-status" role={error ? 'alert' : 'status'}>
        <span>{error || 'Preparing rendered view…'}</span>
        {error && <button onClick={() => setAttempt((value) => value + 1)}>Retry</button>}
        <button onClick={() => onSource()}>Use source</button>
      </div>
    );
  return (
    <MarkdownReviewPreview
      review={result.value}
      showChanges={view.changes}
      onChanges={(changes) => change({ changes })}
      onSource={onSource}
      onAsk={onAsk}
      canComment={!!diff.commentCallbacks}
      annotations={annotations}
    />
  );
}
