import { useRef, useCallback } from 'react';
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from 'react-resizable-panels';
import { Eye, MessageCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
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
  return (
    <div className="inline-flex rounded-md border border-border bg-muted/30 p-0.5 text-xs">
      <button
        className={`px-2.5 py-1 rounded-sm transition-colors ${
          value === 'unified' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
        }`}
        onClick={() => onChange('unified')}
      >
        Unified
      </button>
      <button
        className={`px-2.5 py-1 rounded-sm transition-colors ${
          value === 'split' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
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
        <div className="p-6 flex flex-col gap-5">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={`gap-1 ${typeConfig.className}`}>
              <Icon className="h-3 w-3" />
              {typeConfig.label}
            </Badge>
          </div>

          <h2 className="text-lg font-semibold leading-tight font-display select-text">{slide.title}</h2>

          <Markdown className="text-sm text-muted-foreground leading-relaxed">{slide.narrative}</Markdown>

          {/* Review focus */}
          <div className="review-focus-callout rounded-lg border-l-2 border-l-primary bg-primary/[0.06] px-4 py-3">
            <p className="text-xs uppercase tracking-wider text-primary/70 flex items-center gap-1.5 mb-2">
              <Eye className="h-3 w-3" />
              What to check
            </p>
            {slide.reviewChecks && slide.reviewChecks.length > 0 ? (
              <ul className="text-sm review-focus-content" style={{ listStyle: 'none', paddingLeft: 0 }}>
                {slide.reviewChecks.map((check, i) => {
                  const isClickable = !!(check.filePath && check.startLine != null && check.startLine > 0);
                  return (
                    <li
                      key={i}
                      className={isClickable ? 'cursor-pointer hover:bg-muted/50 rounded-sm transition-colors' : ''}
                      onClick={isClickable ? () => handleCheckClick(check) : undefined}
                    >
                      {check.text}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Markdown className="text-sm review-focus-content">{slide.reviewFocus ?? ''}</Markdown>
            )}
          </div>

          {/* Affected files */}
          {slide.affectedFiles.length > 0 && (
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Affected files</p>
              <ul className="space-y-1">
                {slide.affectedFiles.map((f) => (
                  <li key={f} className="font-mono text-xs text-muted-foreground truncate">
                    {excludedFiles?.has(f) ? (
                      <span className="italic">{f} (excluded)</span>
                    ) : (
                      <FilePathLink filePath={f} gitFileUrlBase={gitFileUrlBase} />
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Context snippets */}
          {slide.contextSnippets.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground select-none list-none flex items-center gap-1">
                <span className="group-open:rotate-90 inline-block transition-transform">&#x25B6;</span>
                Codebase context
              </summary>
              <div className="mt-3 space-y-3">
                {slide.contextSnippets.map((snippet, i) => (
                  <Card key={i} className="bg-muted/30">
                    <CardContent className="p-3">
                      <Markdown className="text-xs text-muted-foreground">{snippet}</Markdown>
                    </CardContent>
                  </Card>
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

      <PanelResizeHandle className="w-1 bg-border hover:bg-primary/50 transition-colors cursor-col-resize" />

      {/* Right panel — diagram + diffs */}
      <Panel defaultSize={60} minSize={30} className="overflow-y-auto min-h-0">
        <div ref={rightPanelRef} className="p-6 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            {slide.mermaidDiagram && <p className="text-xs uppercase tracking-wider text-muted-foreground">Diagram</p>}
            <div className="ml-auto">
              <DiffLayoutToggle value={diffLayout} onChange={onDiffLayoutChange} />
            </div>
          </div>

          {slide.mermaidDiagram && <MermaidDiagram chart={slide.mermaidDiagram} />}

          {groupedHunks.length === 0 && (
            <p className="text-sm text-muted-foreground italic">No diff hunks for this slide.</p>
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
