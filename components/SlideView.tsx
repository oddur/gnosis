import { useRef, useState, useCallback } from 'react';
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from 'react-resizable-panels';
import { MessageCircle, MessageSquarePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DiffHunkGroup } from '@/components/DiffHunk';
import { InteractiveDiffHunkGroup } from '@/components/InteractiveDiffHunk';
import { SplitDiffHunkGroup } from '@/components/SplitDiffHunk';
import { FilePathLink } from '@/components/FilePathLink';
import { Markdown } from '@/components/Markdown';
import { MermaidDiagram } from '@/components/MermaidDiagram';
import { slideTypeConfig, safeConfigLookup } from '@/lib/constants';
import type { CommentCallbacks } from '@/components/shared-diff-utils';
import type { Slide, DiffHunk, FileMetadata, PendingReviewComment, Preferences, ReviewCheck } from '@/lib/types';

interface Props {
  slide: Slide;
  slideNumber: number;
  totalSlides: number;
  pendingComments?: PendingReviewComment[];
  commentCallbacks?: CommentCallbacks;
  diffLayout: Preferences['diffLayout'];
  onDiffLayoutChange: (layout: Preferences['diffLayout']) => void;
  onAskQuestion?: () => void;
  onAskAboutSelection?: (quotedCode: string) => void;
  viewMode?: 'split' | 'focus';
  fileMetadataMap?: Map<string, FileMetadata>;
  gitFileUrlBase?: string | null;
  excludedFiles?: Set<string>;
  isReviewed?: boolean;
  onMarkReviewed?: () => void;
  onToggleReviewed?: () => void;
}

// Format a file's last-modified date as a human-readable age badge.
// Returns strings like "2y old", "5mo old", "14d old", or null for
// new files or missing data.
function formatFileAge(lastModified: string | null | undefined): string | null {
  if (!lastModified) return null;
  const ms = Date.now() - new Date(lastModified).getTime();
  const days = Math.floor(ms / 86400000);
  if (days >= 365) return `${Math.floor(days / 365)}y old`;
  if (days >= 30) return `${Math.floor(days / 30)}mo old`;
  if (days >= 1) return `${days}d old`;
  return null; // modified today — not worth showing
}

// Group hunks by filePath so we can render them under a single file header
function groupHunksByFile(hunks: DiffHunk[]): { filePath: string; hunks: DiffHunk[] }[] {
  const map = new Map<string, DiffHunk[]>();
  for (const hunk of hunks) {
    const existing = map.get(hunk.filePath);
    if (existing) {
      existing.push(hunk);
    } else {
      map.set(hunk.filePath, [hunk]);
    }
  }
  return Array.from(map.entries()).map(([filePath, hunks]) => ({ filePath, hunks }));
}

function DiffLayoutToggle({
  value,
  onChange,
}: {
  value: Preferences['diffLayout'];
  onChange: (v: Preferences['diffLayout']) => void;
}) {
  // Quiet text-only toggle — no fills, no borders. The active option
  // gets a hairline underline in the brand amber so the choice is
  // visible without becoming chrome.
  return (
    <div className="inline-flex items-center gap-4 slide-meta">
      <button
        className={`transition-colors ${
          value === 'unified'
            ? 'text-foreground border-b border-[var(--ring)] pb-0.5'
            : 'hover:text-foreground border-b border-transparent pb-0.5'
        }`}
        onClick={() => onChange('unified')}
      >
        Unified
      </button>
      <button
        className={`transition-colors ${
          value === 'split'
            ? 'text-foreground border-b border-[var(--ring)] pb-0.5'
            : 'hover:text-foreground border-b border-transparent pb-0.5'
        }`}
        onClick={() => onChange('split')}
      >
        Split
      </button>
    </div>
  );
}

export function SlideView({
  slide,
  slideNumber,
  pendingComments,
  commentCallbacks,
  diffLayout,
  onDiffLayoutChange,
  onAskQuestion,
  onAskAboutSelection,
  viewMode = 'split',
  fileMetadataMap,
  gitFileUrlBase,
  excludedFiles,
  isReviewed,
  onMarkReviewed,
  onToggleReviewed,
}: Props) {
  const typeConfig = safeConfigLookup(slideTypeConfig, slide.slideType, slideTypeConfig.foundation);
  const Icon = typeConfig.icon;
  const groupedHunks = groupHunksByFile(slide.diffHunks);
  const rightPanelRef = useRef<HTMLDivElement>(null);

  // Selection-to-chat: when the user selects code in the diff panel,
  // show a small floating "Ask about this" button near the selection.
  const [selectionPopover, setSelectionPopover] = useState<{
    text: string;
    top: number;
    left: number;
  } | null>(null);

  const handleDiffMouseUp = useCallback(() => {
    if (!onAskAboutSelection) return;
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!text || text.length < 3) {
      setSelectionPopover(null);
      return;
    }
    const range = sel?.getRangeAt(0);
    if (!range) return;
    const rect = range.getBoundingClientRect();
    const container = rightPanelRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    setSelectionPopover({
      text,
      top: rect.bottom - containerRect.top + container.scrollTop + 4,
      left: rect.left - containerRect.left + rect.width / 2,
    });
  }, [onAskAboutSelection]);

  const handleDiffMouseDown = useCallback(() => {
    setSelectionPopover(null);
  }, []);

  const chapterNumber = slideNumber.toString().padStart(2, '0');
  const fileCount = slide.affectedFiles.length;
  const fileCountLabel = fileCount === 0 ? 'no files' : `${fileCount} ${fileCount === 1 ? 'file' : 'files'}`;

  const handleCheckClick = useCallback((check: ReviewCheck) => {
    if (!check.filePath || !check.startLine) return;
    const container = rightPanelRef.current;
    if (!container) return;

    const selector = `[data-file-path="${CSS.escape(check.filePath)}"][data-line-number="${check.startLine}"]`;
    const target = container.querySelector(selector);
    if (!target) return;

    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('check-highlight');
    // Force reflow to restart animation if clicking the same item again
    void (target as HTMLElement).offsetWidth;
    target.classList.add('check-highlight');
  }, []);

  // ── Shared content blocks ── Extracted so both split and focus
  // modes can render the same narrative and diff content without
  // duplicating JSX. The layout wrapper changes; the content doesn't.

  const narrativeContent = (
    <div className="px-8 py-10 flex flex-col gap-6">
      <div className="slide-chapter select-text">
        <span>Section {chapterNumber}</span>
        <span aria-hidden="true">·</span>
        <span>{fileCountLabel}</span>
        <span aria-hidden="true">·</span>
        <span className={typeConfig.className}>
          <Icon className="inline h-3 w-3 -translate-y-px mr-1" aria-hidden="true" />
          {typeConfig.label}
        </span>
      </div>

      <h2 className="slide-title select-text">{slide.title}</h2>

      <Markdown className="slide-prose select-text">{slide.narrative}</Markdown>

      {slide.affectedFiles.length > 0 && (
        <ul className="slide-meta flex flex-col gap-1 select-text">
          {slide.affectedFiles.map((f) => (
            <li key={f} className="truncate">
              {excludedFiles?.has(f) ? (
                <span className="italic opacity-70">{f} (excluded)</span>
              ) : (
                <FilePathLink filePath={f} gitFileUrlBase={gitFileUrlBase} />
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="editorial-callout select-text">
        {slide.reviewChecks && slide.reviewChecks.length > 0 ? (
          (() => {
            const checks = slide.reviewChecks;
            return (
              <p className="slide-prose">
                <span className="editorial-label">What to check.</span>{' '}
                <span className="review-focus-content">
                  {checks.map((check, i) => {
                    const isClickable = !!(check.filePath && check.startLine != null && check.startLine > 0);
                    return (
                      <span
                        key={i}
                        className={
                          isClickable
                            ? 'cursor-pointer underline decoration-dotted decoration-[var(--ring)]/50 underline-offset-4 hover:decoration-[var(--ring)]'
                            : ''
                        }
                        onClick={isClickable ? () => handleCheckClick(check) : undefined}
                      >
                        {check.text}
                        {i < checks.length - 1 && ' '}
                      </span>
                    );
                  })}
                </span>
              </p>
            );
          })()
        ) : (
          <p className="slide-prose">
            <span className="editorial-label">What to check.</span>{' '}
            <span className="review-focus-content">{slide.reviewFocus ?? ''}</span>
          </p>
        )}
      </div>

      {slide.contextSnippets.length > 0 && (
        <details className="group select-text">
          <summary className="cursor-pointer slide-meta hover:text-foreground transition-colors select-none list-none flex items-center gap-1.5">
            <span className="group-open:rotate-90 inline-block transition-transform">▸</span>
            Codebase context
          </summary>
          <div className="mt-3 ml-4 flex flex-col gap-3 border-l border-border pl-4">
            {slide.contextSnippets.map((snippet, i) => (
              <Markdown key={i} className="text-sm text-muted-foreground leading-relaxed">
                {snippet}
              </Markdown>
            ))}
          </div>
        </details>
      )}

      <div className="flex flex-col gap-2 mt-2">
        {onMarkReviewed && (
          <button
            onClick={isReviewed ? onToggleReviewed : onMarkReviewed}
            className={`slide-meta flex items-center gap-1.5 hover:text-foreground transition-colors self-start ${
              isReviewed ? 'text-[var(--ring)]' : ''
            }`}
          >
            {isReviewed ? (
              <>✓ Reviewed · press r to undo</>
            ) : (
              <>Mark reviewed and continue · r</>
            )}
          </button>
        )}
        {onAskQuestion && (
          <Button variant="outline" size="sm" onClick={onAskQuestion} className="gap-1.5 w-full">
            <MessageCircle className="h-3.5 w-3.5" />
            Ask a question
          </Button>
        )}
      </div>
    </div>
  );

  const diffContent = (
    <div
      ref={rightPanelRef}
      className="relative px-6 py-10 flex flex-col gap-5"
      onMouseUp={handleDiffMouseUp}
      onMouseDown={handleDiffMouseDown}
    >
      {selectionPopover && (
        <button
          className="absolute z-10 slide-meta bg-background border border-border rounded px-2 py-1 shadow-sm hover:text-foreground transition-colors flex items-center gap-1.5 -translate-x-1/2 animate-fade-in"
          style={{ top: selectionPopover.top, left: selectionPopover.left }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => {
            onAskAboutSelection?.(selectionPopover.text);
            setSelectionPopover(null);
          }}
        >
          <MessageSquarePlus className="h-3 w-3" />
          Ask about this
        </button>
      )}
      <div className="flex items-center justify-end">
        <DiffLayoutToggle value={diffLayout} onChange={onDiffLayoutChange} />
      </div>

      {slide.mermaidDiagram && <MermaidDiagram chart={slide.mermaidDiagram} />}

      {groupedHunks.length === 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="editorial-label text-sm">Context section.</p>
          <p className="slide-meta">
            No code changes here — this section provides context for what follows.
          </p>
        </div>
      )}
      {groupedHunks.map(({ filePath, hunks }) => {
        const fm = fileMetadataMap?.get(filePath);
        const ageBadge = fm ? formatFileAge(fm.lastModified) : null;
        const churnBadge = fm && (fm.prCommitCount ?? 1) > 1 ? `${fm.prCommitCount}× in this PR` : null;

        return (
          <div key={filePath} className="flex flex-col gap-0">
            {/* File metadata badges — age + churn. Render as quiet
                mono text above the file's diff header, only when
                data is available. */}
            {(ageBadge || churnBadge) && (
              <div className="flex items-center gap-3 px-3 py-1 slide-meta">
                {ageBadge && (
                  <span className="statusPill-amber">{ageBadge}</span>
                )}
                {churnBadge && (
                  <span className="statusPill-neutral">{churnBadge}</span>
                )}
              </div>
            )}
            {diffLayout === 'split' ? (
              <SplitDiffHunkGroup
                filePath={filePath}
                hunks={hunks}
                pendingComments={pendingComments}
                slideIndex={slideNumber}
                commentCallbacks={commentCallbacks}
                gitFileUrlBase={gitFileUrlBase}
              />
            ) : commentCallbacks ? (
              <InteractiveDiffHunkGroup
                filePath={filePath}
                hunks={hunks}
                pendingComments={pendingComments ?? []}
                slideIndex={slideNumber}
                onAddComment={commentCallbacks.onAddComment}
                onRemoveComment={commentCallbacks.onRemoveComment}
                onEditComment={commentCallbacks.onEditComment}
                gitFileUrlBase={gitFileUrlBase}
              />
            ) : (
              <DiffHunkGroup filePath={filePath} hunks={hunks} gitFileUrlBase={gitFileUrlBase} />
            )}
          </div>
        );
      })}
    </div>
  );

  // ── Split mode ── resizable narrative (left) + diff (right) panels
  if (viewMode === 'split') {
    return (
      <PanelGroup orientation="horizontal" className="flex flex-1 overflow-hidden">
        <Panel defaultSize={40} minSize={25} className="overflow-y-auto min-h-0">
          {narrativeContent}
        </Panel>
        <PanelResizeHandle className="w-px bg-border hover:bg-[var(--ring)]/40 transition-colors cursor-col-resize" />
        <Panel defaultSize={60} minSize={30} className="overflow-y-auto min-h-0">
          {diffContent}
        </Panel>
      </PanelGroup>
    );
  }

  // ── Focus mode ── narrative stacked above diff, both full-width,
  // single scrollable column. Ideal for complex sections where both
  // the narrative and the diff need horizontal space.
  return (
    <div className="flex-1 overflow-y-auto">
      {narrativeContent}
      <div className="border-t border-border">
        {diffContent}
      </div>
    </div>
  );
}
