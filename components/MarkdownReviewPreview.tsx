import { memo, useMemo, useRef, useState, type ReactNode, type ComponentProps, type ReactElement } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import type { Root } from 'hast';
import { ArrowDown, ArrowUp, ArrowRightLeft, Minus, Plus, Code2, MessageSquare, UnfoldVertical } from 'lucide-react';
import type { MarkdownLocation, MarkdownReview } from '../lib/markdown-review';
import { markdownBlockAt, markdownReviewContext } from '../lib/markdown-review-context';
import { MarkdownImage, GitHubCodeBlock } from './Markdown';
import { Button } from './ui/button';

function PreviewImage(props: ComponentProps<'img'> & { 'data-md-change'?: string }) {
  const change = props['data-md-change'];
  return (
    <span className={change ? 'markdown-media-change' : undefined} data-md-change={change}>
      {change && <span className="markdown-media-label">{change === 'removed' ? 'Before' : 'After'}</span>}
      <MarkdownImage {...props} authenticate />
    </span>
  );
}
function PreviewCode(props: ComponentProps<'pre'> & { 'data-md-change'?: string }) {
  return (
    <div data-md-change={props['data-md-change']}>
      <GitHubCodeBlock {...props} />
    </div>
  );
}
const Tree = memo(function Tree({ tree }: { tree: Root }) {
  return useMemo(
    () =>
      toJsxRuntime(tree, {
        Fragment,
        jsx,
        jsxs,
        components: {
          img: PreviewImage,
          pre: PreviewCode,
        },
        // This multi-framework library still declares global JSX; these factories return React elements.
      }) as ReactElement,
    [tree]
  );
});
type Annotation = { lineNumber: number; side?: 'additions' | 'deletions'; content: ReactNode };
export function MarkdownReviewPreview({
  review,
  showChanges,
  onChanges,
  onSource,
  onAsk,
  annotations,
  canComment,
  revealLocation,
}: {
  review: MarkdownReview;
  showChanges: boolean;
  onChanges: (value: boolean) => void;
  onSource: (location?: MarkdownLocation) => void;
  onAsk?: (text: string) => void;
  annotations: Annotation[];
  canComment: boolean;
  revealLocation?: MarkdownLocation;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<{ text: string; location?: MarkdownLocation }>();
  const [changeIndex, setChangeIndex] = useState(-1);
  const [draftNotice, setDraftNotice] = useState('');
  const [revealed] = useState(() => {
    if (!revealLocation) return [];
    const first = markdownBlockAt(review.blocks, revealLocation);
    return review.blocks
      .filter((block) => {
        const range = block[revealLocation.side];
        return block === first || (range && range.start <= revealLocation.end && range.end >= revealLocation.start);
      })
      .map((block) => block.id);
  });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const wholeFile =
    review.blocks.length && review.blocks.every((b) => b.change === 'added')
      ? 'added'
      : review.deleted
        ? 'removed'
        : undefined;
  const changes = review.blocks.filter((b) => b.change !== 'unchanged');
  const assignments = new Map<string, Annotation[]>();
  const unmatched: Annotation[] = [];
  for (const annotation of annotations) {
    const side = annotation.side === 'deletions' ? 'before' : 'after';
    const block = review.blocks.find(
      (b) => b[side] && annotation.lineNumber >= b[side].start && annotation.lineNumber <= b[side].end
    );
    if (block && showChanges) assignments.set(block.id, [...(assignments.get(block.id) ?? []), annotation]);
    else unmatched.push(annotation);
  }
  const pinned = new Set(assignments.keys());
  revealed.forEach((id) => pinned.add(id));
  const context = markdownReviewContext(review.blocks, pinned, expanded);
  function expand(ids: string[]) {
    setExpanded((previous) => new Set([...previous, ...ids]));
    requestAnimationFrame(() => {
      const first = ref.current?.querySelector<HTMLElement>(`[data-md-block="${ids[0]}"]`);
      first?.focus({ preventScroll: true });
      first?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    });
  }
  function navigate(delta: number) {
    const next = Math.max(0, Math.min(changes.length - 1, changeIndex + delta));
    setChangeIndex(next);
    const target = ref.current?.querySelector<HTMLElement>(`[data-md-block="${changes[next]?.id}"]`);
    target?.scrollIntoView({ block: 'center', behavior: 'instant' });
    target?.focus({ preventScroll: true });
  }
  function readSelection() {
    const selection = window.getSelection();
    if (
      !selection ||
      selection.isCollapsed ||
      !ref.current?.contains(selection.anchorNode) ||
      !ref.current.contains(selection.focusNode)
    ) {
      setSelected(undefined);
      return;
    }
    const range = selection.getRangeAt(0);
    const anchor = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    const block = anchor?.closest<HTMLElement>('[data-md-block]');
    const data = review.blocks.find((b) => b.id === block?.dataset.mdBlock);
    const source = anchor?.closest<HTMLElement>('[data-md-start]');
    const location = source
      ? {
          side: source.dataset.mdSide === 'before' ? ('before' as const) : ('after' as const),
          start: Number(source.dataset.mdStart),
          end: Number(source.dataset.mdEnd),
        }
      : (data?.after ?? data?.before);
    setSelected({ text: selection.toString(), location });
  }
  return (
    <div ref={ref} className="markdown-review" onMouseUp={readSelection} onKeyUp={readSelection}>
      <div className="markdown-review-toolbar">
        <label>
          <input
            type="checkbox"
            checked={showChanges}
            onChange={(e) => {
              const draft = ref.current?.querySelector('textarea');
              if (draft) {
                draft.focus();
                setDraftNotice('Finish or cancel your comment before changing the preview.');
                return;
              }
              setDraftNotice('');
              onChanges(e.target.checked);
              setSelected(undefined);
            }}
          />{' '}
          Show changes
        </label>
        {showChanges && (
          <div className="markdown-review-navigation">
            <span aria-live="polite">
              {changeIndex >= 0 ? `${changeIndex + 1} of ` : ''}
              {changes.length} {changes.length === 1 ? 'change' : 'changes'}
            </span>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Previous Markdown change"
              disabled={!changes.length || changeIndex <= 0}
              onClick={() => navigate(-1)}
            >
              <ArrowUp size={14} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Next Markdown change"
              disabled={!changes.length || changeIndex >= changes.length - 1}
              onClick={() => navigate(1)}
            >
              <ArrowDown size={14} />
            </Button>
          </div>
        )}
        {!showChanges && (
          <span className="markdown-review-mode">
            {review.excerpt ? 'Topic excerpts' : review.deleted ? 'Deleted document' : 'Final document'}
          </span>
        )}
        {selected && (
          <div className="markdown-selection-actions" onPointerDown={(event) => event.preventDefault()}>
            {onAsk && (
              <Button variant="outline" size="sm" onClick={() => onAsk(selected.text)}>
                <MessageSquare size={14} /> Ask about this
              </Button>
            )}
            {canComment && (
              <Button variant="outline" size="sm" onClick={() => onSource(selected.location)}>
                <Code2 size={14} /> Comment in source
              </Button>
            )}
          </div>
        )}
      </div>
      {draftNotice && (
        <p className="markdown-review-notice" role="status">
          {draftNotice}
        </p>
      )}
      {review.excerpt && <p className="markdown-review-notice">Saved sections from this topic.</p>}
      {review.sourceOnly && showChanges && (
        <p className="markdown-review-notice">
          Source changed; the rendered content is unchanged. <button onClick={() => onSource()}>Inspect source</button>
        </p>
      )}
      {!showChanges ? (
        <div className="markdown-review-document">
          {review.deleted ? (
            <p>This file was deleted. Turn on Show changes to review the removed document.</p>
          ) : (
            <Tree tree={review.clean} />
          )}
        </div>
      ) : (
        <div className="markdown-review-document" data-document-change={wholeFile}>
          {!review.blocks.length && <p>This Markdown file is empty.</p>}
          {context.map((item) => {
            if (item.kind === 'gap') {
              const ids = item.blocks.map((block) => block.id);
              const description = `${ids.length} unchanged ${ids.length === 1 ? 'block' : 'blocks'}`;
              return (
                <div key={`gap-${ids[0]}`} className="markdown-context-gap">
                  <Button
                    variant="ghost"
                    size="sm"
                    title={description}
                    aria-label={`Show more context: ${description}`}
                    onClick={() => expand(ids.slice(0, 3))}
                  >
                    <UnfoldVertical size={14} /> Show more
                  </Button>
                  {ids.length > 3 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Show all ${description}`}
                      onClick={() => expand(ids)}
                    >
                      Show all
                    </Button>
                  )}
                </div>
              );
            }
            const block = item.block;
            return (
              <section
                key={block.id}
                data-md-block={block.id}
                data-md-block-change={block.change}
                tabIndex={-1}
                className="markdown-review-block"
              >
                {!wholeFile && block.change !== 'unchanged' && block.change !== 'changed' && (
                  <div className="markdown-block-label">
                    {block.change === 'added' ? (
                      <Plus size={12} />
                    ) : block.change === 'removed' ? (
                      <Minus size={12} />
                    ) : (
                      <ArrowRightLeft size={12} />
                    )}
                    {
                      ({ added: 'Added', removed: 'Removed', changed: 'Changed', moved: 'Moved' } as const)[
                        block.change
                      ]
                    }
                  </div>
                )}
                <div className="markdown-block-content">
                  <Tree tree={block.tree} />
                </div>
                <button
                  className="markdown-source-link"
                  onClick={() => onSource(block.after ?? block.before)}
                  aria-label="View source for section"
                  title="View source for section"
                >
                  <Code2 size={14} />
                </button>
                {assignments.get(block.id)?.map((annotation, index) => (
                  <div key={index} className="markdown-review-discussion">
                    {annotation.content}
                  </div>
                ))}
              </section>
            );
          })}
        </div>
      )}
      {!!unmatched.length && (
        <section className="markdown-review-unmapped">
          <h3>Source discussions</h3>
          <p>These comments stay attached to their original source lines.</p>
          {unmatched.map((annotation, index) => (
            <div key={index}>{annotation.content}</div>
          ))}
        </section>
      )}
    </div>
  );
}
