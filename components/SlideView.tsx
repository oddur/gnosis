import { useRef, useCallback } from 'react';
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from 'react-resizable-panels';
import { MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DiffHunkGroup } from '@/components/DiffHunk';
import { InteractiveDiffHunkGroup } from '@/components/InteractiveDiffHunk';
import { SplitDiffHunkGroup } from '@/components/SplitDiffHunk';
import { FilePathLink } from '@/components/FilePathLink';
import { Markdown } from '@/components/Markdown';
import { MermaidDiagram } from '@/components/MermaidDiagram';
import { slideTypeConfig } from '@/lib/constants';
import type { CommentCallbacks } from '@/components/shared-diff-utils';
import type { Slide, DiffHunk, PendingReviewComment, Preferences, ReviewCheck } from '@/lib/types';

interface Props {
  slide: Slide;
  slideNumber: number;
  totalSlides: number;
  pendingComments?: PendingReviewComment[];
  commentCallbacks?: CommentCallbacks;
  diffLayout: Preferences['diffLayout'];
  onDiffLayoutChange: (layout: Preferences['diffLayout']) => void;
  onAskQuestion?: () => void;
  gitFileUrlBase?: string | null;
  excludedFiles?: Set<string>;
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
  gitFileUrlBase,
  excludedFiles,
}: Props) {
  const typeConfig = slideTypeConfig[slide.slideType];
  const Icon = typeConfig.icon;
  const groupedHunks = groupHunksByFile(slide.diffHunks);
  const rightPanelRef = useRef<HTMLDivElement>(null);

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

  return (
    <PanelGroup orientation="horizontal" className="flex flex-1 overflow-hidden">
      {/* Left panel — narrative */}
      <Panel defaultSize={40} minSize={25} className="overflow-y-auto min-h-0">
        <div className="px-8 py-10 flex flex-col gap-6">
          {/* Chapter chip — quiet mono label above the title, like a
              section number in a printed monograph. */}
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

          {/* Affected files — quiet mono margin-note, no label.
              The file paths speak for themselves; an "AFFECTED FILES"
              banner above them was redundant. */}
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

          {/* Review focus — the canonical editorial callout pattern
              from the brief: soft tinted block with a bold inline
              label followed by prose on the same line. NOT a card,
              NOT a side-stripe border, NOT a titled tip box. */}
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

          {/* Context snippets — collapsible inline disclosure, no
              cards. Just a small toggle and indented prose. */}
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

          {onAskQuestion && (
            <Button variant="outline" size="sm" onClick={onAskQuestion} className="gap-1.5 w-full mt-2">
              <MessageCircle className="h-3.5 w-3.5" />
              Ask a question
            </Button>
          )}
        </div>
      </Panel>

      <PanelResizeHandle className="w-px bg-border hover:bg-[var(--ring)]/40 transition-colors cursor-col-resize" />

      {/* Right panel — diagram + diffs */}
      <Panel defaultSize={60} minSize={30} className="overflow-y-auto min-h-0">
        <div ref={rightPanelRef} className="px-6 py-10 flex flex-col gap-5">
          {/* Diff layout toggle floats to the right with no label —
              the toggle itself is self-explanatory. */}
          <div className="flex items-center justify-end">
            <DiffLayoutToggle value={diffLayout} onChange={onDiffLayoutChange} />
          </div>

          {slide.mermaidDiagram && <MermaidDiagram chart={slide.mermaidDiagram} />}

          {groupedHunks.length === 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="editorial-label text-sm">A narrative-only slide.</p>
              <p className="slide-meta">
                This chapter has no diff to show — the author wrote it as context for the slides that follow.
              </p>
            </div>
          )}
          {groupedHunks.map(({ filePath, hunks }) => {
            if (diffLayout === 'split') {
              return (
                <SplitDiffHunkGroup
                  key={filePath}
                  filePath={filePath}
                  hunks={hunks}
                  pendingComments={pendingComments}
                  slideIndex={slideNumber}
                  commentCallbacks={commentCallbacks}
                  gitFileUrlBase={gitFileUrlBase}
                />
              );
            }
            return commentCallbacks ? (
              <InteractiveDiffHunkGroup
                key={filePath}
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
              <DiffHunkGroup key={filePath} filePath={filePath} hunks={hunks} gitFileUrlBase={gitFileUrlBase} />
            );
          })}
        </div>
      </Panel>
    </PanelGroup>
  );
}
