import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from 'react-resizable-panels';
import { Check, Copy, CopyX, MessageCircle, MessageSquarePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DiffHunkGroup } from '@/components/DiffHunk';
import { InteractiveDiffHunkGroup } from '@/components/InteractiveDiffHunk';
import { SplitDiffHunkGroup } from '@/components/SplitDiffHunk';
import { FilePathLink } from '@/components/FilePathLink';
import { Markdown } from '@/components/Markdown';
import { MermaidDiagram } from '@/components/MermaidDiagram';
import { slideTypeConfig, safeConfigLookup } from '@/lib/constants';
import {
  buildAgentPrompt,
  buildAnchorableSet,
  isAnchorable,
  looksLikePackedList,
  splitIntoProseChecks,
} from '@/lib/review-checks';
import { useCopyToClipboard } from '@/lib/use-copy';
import type { CommentCallbacks } from '@/components/shared-diff-utils';
import type { Slide, DiffHunk, FileMetadata, PendingReviewComment, Preferences, ReviewCheck } from '@/lib/types';

interface Props {
  slide: Slide;
  slideNumber: number;
  totalSlides: number;
  prUrl: string;
  checkedChecks: Set<string>;
  onToggleCheck: (key: string) => void;
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

// Inline click affordance for a single anchored check — dotted
// underline in brand claret so it reads as a quiet link.
const clickableCheckClass =
  'cursor-pointer underline decoration-dotted decoration-[var(--ring)]/50 underline-offset-4 hover:decoration-[var(--ring)]';

// Small icon button that copies the given text to clipboard and
// flips to a check mark (or an error mark when the clipboard write
// fails) for ~1.5s as confirmation. Title attribute doubles as the
// tooltip. Visible but quiet — brightens on hover and focus-visible
// for keyboard users.
function CopyPromptButton({ prompt, className = '' }: { prompt: string; className?: string }) {
  const { state, copy } = useCopyToClipboard();
  const label =
    state === 'copied'
      ? 'Copied'
      : state === 'failed'
        ? 'Copy failed — click to retry'
        : 'Copy as agent prompt';
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        copy(prompt);
      }}
      title={label}
      aria-label={label}
      className={`inline-flex items-center shrink-0 text-muted-foreground/70 hover:text-foreground focus-visible:text-foreground transition-colors align-middle ${className}`}
    >
      {state === 'copied' ? (
        <Check className="h-3 w-3" />
      ) : state === 'failed' ? (
        <CopyX className="h-3 w-3 text-destructive" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  );
}

// djb2 — a tiny, stable string hash. Used as the trailing segment of
// each checkbox's localStorage key so a reviewer's ticks survive
// layout/renderer changes (bullet vs inline, prose-split reshape).
function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function checkKey(slideId: string, text: string): string {
  return `${slideId}:${hashText(text.trim())}`;
}

// Persistent "I've verified this" checkbox for a single item in the
// "What to check" callout. Renders a native input (for real keyboard
// semantics) styled to match the brand accent, plus a line-through
// strike when checked so skimming back over the list the eye knows
// what's already been done.
function CheckTodo({
  storageKey,
  checked,
  onToggle,
  children,
}: {
  storageKey: string;
  checked: boolean;
  onToggle: (key: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="check-todo">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => {
          e.stopPropagation();
          onToggle(storageKey);
        }}
        onClick={(e) => e.stopPropagation()}
        className="check-todo-input"
        aria-label={checked ? 'Mark check not done' : 'Mark check done'}
      />
      <span className={checked ? 'check-todo-done' : ''}>{children}</span>
    </label>
  );
}

function renderReviewChecks(
  checks: ReviewCheck[] | undefined,
  reviewFocus: string | null,
  anchorable: Set<string>,
  onCheckClick: (check: ReviewCheck) => void,
  slideId: string,
  slideTitle: string,
  prUrl: string,
  checkedChecks: Set<string>,
  onToggleCheck: (key: string) => void
): ReactNode {
  const todoFor = (text: string, children: ReactNode): ReactNode => {
    const key = checkKey(slideId, text);
    return (
      <CheckTodo storageKey={key} checked={checkedChecks.has(key)} onToggle={onToggleCheck}>
        {children}
      </CheckTodo>
    );
  };
  const copyFor = (text: string, filePath?: string | null, startLine?: number | null) => (
    <CopyPromptButton
      prompt={buildAgentPrompt(text, slideTitle, prUrl, filePath, startLine)}
      className="ml-2"
    />
  );
  // Multi-item structured: custom bulleted list, per-item click
  // affordance for anchored checks.
  if (checks && checks.length > 1) {
    return (
      <>
        <p className="slide-prose">
          <span className="editorial-label">What to check.</span>
        </p>
        <ul className="slide-prose review-checks-list mt-1.5">
          {checks.map((check, i) => {
            const isClickable = isAnchorable(check, anchorable);
            return (
              <li key={i} className="review-checks-item">
                {todoFor(
                  check.text,
                  <span
                    className={isClickable ? clickableCheckClass : ''}
                    onClick={isClickable ? () => onCheckClick(check) : undefined}
                  >
                    {check.text}
                  </span>
                )}
                {copyFor(
                  check.text,
                  isClickable ? check.filePath : null,
                  isClickable ? check.startLine : null
                )}
              </li>
            );
          })}
        </ul>
      </>
    );
  }

  // Single structured check. If its text is actually several
  // sentences crammed together, split into bullets. If just long,
  // promote to a block through Markdown. Otherwise keep the inline
  // run-in label + sentence.
  if (checks && checks.length === 1) {
    const check = checks[0];
    const isClickable = isAnchorable(check, anchorable);
    const packed = looksLikePackedList(check.text);
    const longText = check.text.length > 180;
    const split = longText || packed ? splitIntoProseChecks(check.text) : [check.text];
    if (split.length > 1) {
      // Prose-split into multiple sentences → render as bulleted
      // list. The anchor click (when present) applies to every
      // bullet; the whole check points at one line.
      return (
        <>
          <p className="slide-prose">
            <span className="editorial-label">What to check.</span>
          </p>
          <ul className="slide-prose review-checks-list mt-1.5">
            {split.map((sentence, i) => (
              <li key={i} className="review-checks-item">
                {todoFor(
                  sentence,
                  <span
                    className={isClickable ? clickableCheckClass : ''}
                    onClick={isClickable ? () => onCheckClick(check) : undefined}
                  >
                    <Markdown className="review-focus-markdown">{sentence}</Markdown>
                  </span>
                )}
                {copyFor(
                  sentence,
                  isClickable ? check.filePath : null,
                  isClickable ? check.startLine : null
                )}
              </li>
            ))}
          </ul>
        </>
      );
    }
    if (packed || longText) {
      return (
        <>
          <p className="slide-prose">
            <span className="editorial-label">What to check.</span>
          </p>
          <div className="slide-prose mt-1.5 flex items-start gap-2">
            {todoFor(
              check.text,
              <span
                className={isClickable ? clickableCheckClass : ''}
                onClick={isClickable ? () => onCheckClick(check) : undefined}
              >
                <Markdown className="review-focus-markdown">{check.text}</Markdown>
              </span>
            )}
            {copyFor(
              check.text,
              isClickable ? check.filePath : null,
              isClickable ? check.startLine : null
            )}
          </div>
        </>
      );
    }
    return (
      <p className="slide-prose">
        <span className="editorial-label">What to check.</span>{' '}
        <span className="review-focus-content">
          {todoFor(
            check.text,
            <span
              className={isClickable ? clickableCheckClass : ''}
              onClick={isClickable ? () => onCheckClick(check) : undefined}
            >
              {check.text}
            </span>
          )}
        </span>
        {copyFor(
          check.text,
          isClickable ? check.filePath : null,
          isClickable ? check.startLine : null
        )}
      </p>
    );
  }

  // Fallback: render reviewFocus. The model is told to format it as
  // a markdown bullet list, so route it through <Markdown> — that way
  // "- item1\n- item2" actually renders as a list, and a paragraph
  // still renders as a paragraph. Try prose-splitting first to catch
  // packed-in-prose fallbacks.
  const focus = reviewFocus ?? '';
  if (!focus.trim()) {
    return (
      <p className="slide-prose">
        <span className="editorial-label">What to check.</span>
      </p>
    );
  }
  if (looksLikePackedList(focus) || focus.length > 180) {
    const split = splitIntoProseChecks(focus);
    if (split.length > 1) {
      return (
        <>
          <p className="slide-prose">
            <span className="editorial-label">What to check.</span>
          </p>
          <ul className="slide-prose review-checks-list mt-1.5">
            {split.map((sentence, i) => (
              <li key={i} className="review-checks-item">
                {todoFor(sentence, <Markdown className="review-focus-markdown">{sentence}</Markdown>)}
                {copyFor(sentence)}
              </li>
            ))}
          </ul>
        </>
      );
    }
    return (
      <>
        <p className="slide-prose">
          <span className="editorial-label">What to check.</span>
        </p>
        <div className="slide-prose mt-1.5 flex items-start gap-2">
          {todoFor(focus, <Markdown className="review-focus-markdown">{focus}</Markdown>)}
          {copyFor(focus)}
        </div>
      </>
    );
  }
  return (
    <p className="slide-prose">
      <span className="editorial-label">What to check.</span>{' '}
      <span className="review-focus-content">{todoFor(focus, <>{focus}</>)}</span>
      {copyFor(focus)}
    </p>
  );
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
  prUrl,
  checkedChecks,
  onToggleCheck,
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

  // When a review-check click can't be resolved to a visible diff line
  // (rare, because we also pre-filter at render time), surface a brief
  // muted note below the callout so the user isn't left guessing why
  // the click did nothing. Cleared after ~3s.
  const [anchorMiss, setAnchorMiss] = useState<{ filePath: string; line: number; at: number } | null>(null);

  // Auto-clear the miss notice so it doesn't linger past the moment
  // the user expects feedback.
  useEffect(() => {
    if (!anchorMiss) return;
    const t = setTimeout(() => {
      setAnchorMiss((current) => (current && current.at === anchorMiss.at ? null : current));
    }, 3000);
    return () => clearTimeout(t);
  }, [anchorMiss]);

  // Which `{filePath, line}` anchors can actually resolve inside THIS
  // slide's diff hunks. Used to pre-filter click affordances so we
  // never render a clickable-looking check that will silently fail.
  const anchorable = useMemo(() => buildAnchorableSet(slide.diffHunks), [slide.diffHunks]);

  const handleCheckClick = useCallback((check: ReviewCheck) => {
    if (!check.filePath || !check.startLine) return;
    const container = rightPanelRef.current;
    if (!container) return;

    const escapedPath = CSS.escape(check.filePath);
    // Primary: new-file line number (matches what the AI is told to emit).
    // Fallback: old-file line number, in case the AI anchored at a
    // removed line.
    const target =
      container.querySelector(`[data-file-path="${escapedPath}"][data-line-number="${check.startLine}"]`) ??
      container.querySelector(`[data-file-path="${escapedPath}"][data-base-line="${check.startLine}"]`);

    if (!target) {
      setAnchorMiss({ filePath: check.filePath, line: check.startLine, at: Date.now() });
      return;
    }

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

      {slide.educationNotes && slide.educationNotes.length > 0 && (
        <aside className="education-notes select-text" aria-label="Background concepts">
          {slide.educationNotes.map((note, i) => (
            <div key={i} className="flex flex-col gap-1">
              <span className="slide-meta">Background</span>
              <p className="slide-prose">
                <span className="editorial-label">{note.concept}.</span>{' '}
                {note.explanation}
              </p>
            </div>
          ))}
        </aside>
      )}

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
        {renderReviewChecks(
          slide.reviewChecks,
          slide.reviewFocus,
          anchorable,
          handleCheckClick,
          slide.id,
          slide.title,
          prUrl,
          checkedChecks,
          onToggleCheck,
        )}
        {anchorMiss && (
          <p className="slide-meta mt-2" role="status" aria-live="polite">
            Line {anchorMiss.line} in <span className="font-mono">{anchorMiss.filePath}</span> isn't in this slide's
            visible diff.
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
