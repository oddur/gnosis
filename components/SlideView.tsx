import { useSessionScroll, useSessionDraft } from '../lib/session-drafts';
import { ReviewImageDiff } from './ReviewImageDiff';
import { LFS_VERSION } from '../lib/git-lfs';
import { imageMimeType } from '../lib/review-images';
import { sourceForPath } from '../lib/workbench';
import { buildFileUrlBase } from '../lib/github-url';
import type { ReviewGuide } from '../lib/types';
import type { ReactNode } from 'react';
import { useEffect, useId, useMemo, useRef, useState, useCallback } from 'react';
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from 'react-resizable-panels';
import { ArrowRight, Check, Copy, CopyX, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { findReviewLine } from './ReviewDiff';
import { ReviewSelectionActions } from './ReviewSelectionActions';
import { ReviewFileDiscussion } from './ReviewFileDiscussion';
import { DiffAppearanceMenu } from './DiffAppearanceMenu';
import { DEFAULT_DIFF_APPEARANCE, type DiffAppearance } from '@/lib/review-diff';
import { ReviewFileHeader } from './ReviewFileHeader';
import { normalizeInlineExplanations } from '@/lib/inline-explanations';
import { FilePathLink } from '@/components/FilePathLink';
import { Markdown } from '@/components/Markdown';
import { MermaidDiagram } from '@/components/MermaidDiagram';
import { D2Diagram } from '@/components/D2Diagram';
import { CODE_THEMES, slideTypeConfig, safeConfigLookup } from '@/lib/constants';
import {
  buildAgentPrompt,
  buildAnchorableSet,
  isAnchorable,
  looksLikePackedList,
  splitIntoProseChecks,
} from '@/lib/review-checks';
import { useCopyToClipboard } from '@/lib/use-copy';
import { extractShikiStyles, type CommentCallbacks } from '@/components/shared-diff-utils';
import type { Slide, DiffHunk, FileMetadata, PendingReviewComment, Preferences, ReviewCheck } from '@/lib/types';

interface Props {
  review?: ReviewGuide;
  leftSlot?: ReactNode;
  rightSlot?: ReactNode;
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
  diffAppearance?: DiffAppearance;
  onDiffAppearanceChange: (value: DiffAppearance) => void;
  onAskQuestion?: () => void;
  onExplore?: () => void;
  onAskAboutSelection?: (quotedCode: string) => void;
  viewMode?: 'split' | 'focus';
  fileMetadataMap?: Map<string, FileMetadata>;
  gitFileUrlBase?: string | null;
  excludedFiles?: Set<string>;
  isReviewed?: boolean;
  onMarkReviewed?: () => void;
  onToggleReviewed?: () => void;
  viewedFiles?: Set<string>;
  onFileViewedChange?: (filePath: string, viewed: boolean) => void;
  onContinue?: () => void;
  nextTopicTitle?: string | null;
  showReviewSuggestions?: boolean;
  showInlineExplanations?: boolean;
  onShowInlineExplanationsChange?: (show: boolean) => void;
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
    state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed — click to retry' : 'Copy as agent prompt';
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
  onToggleCheck: (key: string) => void,
  review?: ReviewGuide
): ReactNode {
  const todoFor = (text: string, children: ReactNode): ReactNode => {
    const key = checkKey(slideId, text);
    return (
      <CheckTodo storageKey={key} checked={checkedChecks.has(key)} onToggle={onToggleCheck}>
        {children}
      </CheckTodo>
    );
  };
  const copyFor = (text: string, filePath?: string | null, startLine?: number | null) => {
    const origin = review && filePath ? sourceForPath(review, filePath) : undefined;
    return (
      <CopyPromptButton
        prompt={buildAgentPrompt(text, slideTitle, origin?.member?.url ?? prUrl, origin?.path ?? filePath, startLine)}
        className="ml-2"
      />
    );
  };
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
                {copyFor(check.text, isClickable ? check.filePath : null, isClickable ? check.startLine : null)}
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
                {copyFor(sentence, isClickable ? check.filePath : null, isClickable ? check.startLine : null)}
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
            {copyFor(check.text, isClickable ? check.filePath : null, isClickable ? check.startLine : null)}
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
        {copyFor(check.text, isClickable ? check.filePath : null, isClickable ? check.startLine : null)}
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

export function SlideView({
  review,
  leftSlot,
  rightSlot,
  slide,
  slideNumber,
  totalSlides,
  prUrl,
  checkedChecks,
  onToggleCheck,
  pendingComments,
  commentCallbacks,
  diffLayout,
  onDiffLayoutChange,
  diffAppearance = DEFAULT_DIFF_APPEARANCE,
  onDiffAppearanceChange,
  onAskQuestion,
  onExplore,
  onAskAboutSelection,
  viewMode = 'split',
  fileMetadataMap,
  gitFileUrlBase,
  excludedFiles,
  isReviewed,
  onMarkReviewed,
  onToggleReviewed,
  viewedFiles,
  onFileViewedChange,
  onContinue,
  nextTopicTitle,
  showReviewSuggestions = true,
  showInlineExplanations = true,
  onShowInlineExplanationsChange,
}: Props) {
  const [diagramOpen, setDiagramOpen] = useState(false);
  useEffect(() => setDiagramOpen(false), [slide.id]);
  const narrativeScroll = useSessionScroll(`${slide.id}:narrative`);
  const codeScroll = useSessionScroll(`${slide.id}:code`);
  const focusScroll = useSessionScroll(`${slide.id}:focus`);
  const typeConfig = safeConfigLookup(slideTypeConfig, slide.slideType, slideTypeConfig.foundation);
  const Icon = typeConfig.icon;
  const groupedHunks = groupHunksByFile(slide.diffHunks);
  for (const filePath of slide.affectedFiles) {
    if (imageMimeType(filePath) && !groupedHunks.some((group) => group.filePath === filePath))
      groupedHunks.push({ filePath, hunks: [] });
  }
  const allFilesViewed = groupedHunks.length > 0 && groupedHunks.every(({ filePath }) => viewedFiles?.has(filePath));
  const isLastTopic = slideNumber === totalSlides;
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const fileContentId = useId();
  const [fileExpansion, setFileExpansion] = useSessionDraft<Record<string, boolean>>(`file-expansion:${slide.id}`, {});
  const [explanationNotice, setExplanationNotice] = useState('');
  const inlineExplanations = useMemo(
    () =>
      normalizeInlineExplanations(
        slide.inlineExplanations,
        slide.diffHunks,
        review?.changedFiles ?? (fileMetadataMap ? [...fileMetadataMap.values()] : undefined)
      ),
    [slide.inlineExplanations, slide.diffHunks, review?.changedFiles, fileMetadataMap]
  );
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 1000px)').matches);
  const [narrowPane, setNarrowPane] = useState<'explanation' | 'code'>('explanation');
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1000px)');
    const update = () => setNarrow(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const hasLeftSlot = !!leftSlot,
    hasRightSlot = !!rightSlot;
  useEffect(() => {
    if (hasRightSlot) setNarrowPane('code');
  }, [hasRightSlot]);
  useEffect(() => {
    if (hasLeftSlot) setNarrowPane('explanation');
  }, [hasLeftSlot]);

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
    const filePath = check.filePath;
    const container = rightPanelRef.current;
    if (!container) return;

    const target = findReviewLine(container, check.filePath, check.startLine);

    if (!target) {
      setAnchorMiss({ filePath: check.filePath, line: check.startLine, at: Date.now() });
      return;
    }

    setNarrowPane('code');
    setFileExpansion((current) => ({ ...current, [filePath]: true }));
    requestAnimationFrame(() => target.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    target.classList.remove('check-highlight');
    // Force reflow to restart animation if clicking the same item again
    void target.offsetWidth;
    target.classList.add('check-highlight');
  }, []);

  // ── Shared content blocks ── Extracted so both split and focus
  // modes can render the same narrative and diff content without
  // duplicating JSX. The layout wrapper changes; the content doesn't.

  const narrativeContent = (
    <div className="review-narrative px-8 py-10 flex flex-col gap-6">
      <div className="slide-chapter select-text">
        <span>Topic {chapterNumber}</span>
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

      {slide.d2Diagram?.source ? (
        <D2Diagram
          key={slide.id}
          diagram={slide.d2Diagram}
          title={slide.title}
          expanded={diagramOpen}
          onExpandedChange={setDiagramOpen}
          canShowCode={(source) => isAnchorable({ ...source, text: '' }, anchorable)}
          onShowCode={(source) => handleCheckClick({ ...source, text: '' })}
        />
      ) : (
        slide.mermaidDiagram && (
          <MermaidDiagram
            chart={slide.mermaidDiagram}
            title={slide.title}
            expanded={diagramOpen}
            onExpandedChange={setDiagramOpen}
          />
        )
      )}

      {onExplore &&
        (slide.explainerIdea ||
          slide.explainer ||
          (slide.explainerIdea === undefined && slide.diffHunks.length > 0)) && (
          <div className="interactive-explanation-prompt my-6 py-4 border-y border-border flex flex-col items-start gap-3">
            <div>
              <p className="editorial-label mb-1">Interactive explanation</p>
              <p className="font-serif text-lg">
                {slide.explainerIdea?.title ?? slide.explainer?.title ?? 'Explore this change'}
              </p>
              <p className="text-sm text-muted-foreground leading-relaxed mt-1">
                {slide.explainerIdea?.description ??
                  slide.explainer?.description ??
                  'Build an interactive diagram to explain the code in this topic.'}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={onExplore}
              title={
                slide.explainer
                  ? 'Open the saved interactive explanation without generating it again'
                  : 'Generate an interactive diagram for this topic'
              }
              className="mt-1"
            >
              {slide.explainer ? 'Open interactive explanation' : 'Create interactive explanation'}
            </Button>
          </div>
        )}

      {slide.educationNotes && slide.educationNotes.length > 0 && (
        <aside className="education-notes select-text" aria-label="Background concepts">
          {slide.educationNotes.map((note, i) => (
            <div key={i} className="flex flex-col gap-1">
              <span className="slide-meta">Background</span>
              <p className="slide-prose">
                <span className="editorial-label">{note.concept}.</span> {note.explanation}
              </p>
            </div>
          ))}
        </aside>
      )}

      {slide.affectedFiles.length > 0 && (
        <ul className="slide-meta flex flex-col gap-1 select-text">
          {slide.affectedFiles.map((f) => {
            const origin = review ? sourceForPath(review, f).member : undefined;
            return (
              <li key={f} className="truncate">
                {excludedFiles?.has(f) ? (
                  <span className="italic opacity-70">{f} (excluded)</span>
                ) : (
                  <FilePathLink
                    filePath={f}
                    gitFileUrlBase={origin ? buildFileUrlBase(origin.url, origin.headSha) : gitFileUrlBase}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {showReviewSuggestions && (
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
            review
          )}
          {anchorMiss && (
            <p className="slide-meta mt-2" role="status" aria-live="polite">
              Line {anchorMiss.line} in <span className="font-mono">{anchorMiss.filePath}</span> isn't in this slide's
              visible diff.
            </p>
          )}
        </div>
      )}

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
            aria-describedby="topic-progress-help"
            onClick={isReviewed ? onToggleReviewed : onMarkReviewed}
            className={`slide-meta flex items-center gap-1.5 hover:text-foreground transition-colors self-start ${
              isReviewed ? 'text-[var(--ring)]' : ''
            }`}
          >
            {isReviewed ? <>✓ Topic reviewed · press r to undo</> : <>Mark topic reviewed and continue · r</>}
          </button>
        )}
        {onMarkReviewed && (
          <p id="topic-progress-help" className="text-xs text-muted-foreground">
            Tracks your progress in Gnosis. Does not approve or submit feedback to GitHub.
          </p>
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
    <div ref={rightPanelRef} className="review-code relative px-6 py-10 flex flex-col gap-5">
      {onAskAboutSelection && (
        <ReviewSelectionActions
          containerRef={rightPanelRef}
          onAsk={onAskAboutSelection}
          resetKey={JSON.stringify([slideNumber, diffLayout, fileExpansion, narrowPane, hasRightSlot])}
        />
      )}
      <div className="flex items-center justify-end">
        <div className="flex items-center gap-3 flex-wrap">
          {inlineExplanations.length > 0 && onShowInlineExplanationsChange && (
            <label className="inline-explanations-toggle">
              <input
                type="checkbox"
                checked={showInlineExplanations}
                onChange={(event) => {
                  const draft = rightPanelRef.current?.querySelector('textarea');
                  if (draft) {
                    draft.focus();
                    setExplanationNotice('Finish or cancel your comment before changing inline explanations.');
                    return;
                  }
                  setExplanationNotice('');
                  onShowInlineExplanationsChange(event.target.checked);
                }}
              />
              Inline explanations
            </label>
          )}
          <DiffAppearanceMenu
            layout={diffLayout}
            onLayoutChange={onDiffLayoutChange}
            value={diffAppearance}
            onChange={onDiffAppearanceChange}
          />
        </div>
      </div>

      {explanationNotice && (
        <p className="text-xs text-muted-foreground" role="status">
          {explanationNotice}
        </p>
      )}

      {groupedHunks.length === 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="editorial-label text-sm">Background topic.</p>
          <p className="slide-meta">No code changes here — this topic provides context for what follows.</p>
        </div>
      )}
      {groupedHunks.map(({ filePath, hunks }, index) => {
        const origin = review ? sourceForPath(review, filePath) : undefined;
        const sourceUrl = origin?.member ? buildFileUrlBase(origin.member.url, origin.member.headSha) : gitFileUrlBase;
        const fm = fileMetadataMap?.get(filePath);
        const ageBadge = fm ? formatFileAge(fm.lastModified) : null;
        const viewed = viewedFiles?.has(filePath) ?? false;
        const expanded = fileExpansion[filePath] ?? !viewed;
        const contentId = `${fileContentId}-${index}`;
        const lfsResource = hunks.some((hunk) => hunk.content.includes(LFS_VERSION));
        const fileDiff = (
          <ReviewFileDiscussion
            inlineExplanations={
              showInlineExplanations ? inlineExplanations.filter((note) => note.filePath === filePath) : []
            }
            review={review}
            filePath={filePath}
            pinnedLines={slide.reviewChecks
              ?.filter((check) => check.filePath === filePath && check.startLine != null)
              .map((check) => check.startLine as number)}
            fileStatus={fm?.status}
            hunks={hunks}
            diffLayout={diffLayout}
            appearance={diffAppearance}
            pendingComments={pendingComments}
            slideIndex={slideNumber}
            commentCallbacks={commentCallbacks}
          />
        );

        return (
          <div key={filePath} className="review-file-group flex flex-col gap-0" data-file-path={filePath}>
            <ReviewFileHeader
              expanded={expanded}
              contentId={contentId}
              onToggleExpanded={() => {
                setFileExpansion((current) => ({ ...current, [filePath]: !expanded }));
              }}
              viewed={viewed}
              onViewedChange={
                onFileViewedChange
                  ? (next) => {
                      setFileExpansion((current) => ({ ...current, [filePath]: !next }));
                      onFileViewedChange(filePath, next);
                    }
                  : undefined
              }
              filePath={origin?.path ?? filePath}
              hunks={hunks}
              gitFileUrlBase={sourceUrl}
              metadata={fm}
              summary={slide.fileSummaries?.find((entry) => entry.filePath === filePath)?.summary}
              source={review?.snapshot?.subject.kind === 'stack' ? origin?.member : undefined}
              commentCount={pendingComments?.filter((c) => c.filePath === filePath).length ?? 0}
              age={ageBadge}
            />
            <div id={contentId} className="review-file-content" hidden={!expanded}>
              {(imageMimeType(filePath) || lfsResource) && (
                <ReviewImageDiff
                  key={`${review?.reviewId}:${filePath}`}
                  reviewId={review?.reviewId}
                  filePath={filePath}
                  enabled={expanded}
                  diffLayout={diffLayout}
                  diffAppearance={diffAppearance}
                  diffTheme={
                    CODE_THEMES.find((theme) =>
                      extractShikiStyles(hunks[0]?.renderedHtml ?? '')
                        .preClass.split(' ')
                        .includes(theme.id)
                    )?.id ?? 'aurora-x'
                  }
                />
              )}
              {(imageMimeType(filePath) || lfsResource) && hunks.length > 0 ? (
                <details className="review-image-source">
                  <summary>Source diff and comments</summary>
                  {fileDiff}
                </details>
              ) : (
                fileDiff
              )}
            </div>
          </div>
        );
      })}
      {allFilesViewed && onContinue && (
        <div className="review-files-complete flex flex-col items-start gap-3 border-t border-border pt-6">
          <div className="space-y-1" role="status">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Check className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              All files in this topic viewed
            </p>
            <p className="text-sm text-muted-foreground break-words">
              {isLastTopic
                ? 'You’ve reached the last topic.'
                : nextTopicTitle
                  ? `Up next: ${nextTopicTitle}`
                  : 'Continue to the next topic.'}
            </p>
          </div>
          <Button onClick={onContinue}>
            {isLastTopic ? 'Back to overview' : 'Next topic'}
            <ArrowRight className="size-4" aria-hidden="true" />
          </Button>
        </div>
      )}
    </div>
  );

  if (narrow)
    return (
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        <div className="flex gap-2 border-b border-border px-3 py-2" aria-label="Review pane">
          <Button
            size="sm"
            variant={narrowPane === 'explanation' ? 'secondary' : 'ghost'}
            aria-pressed={narrowPane === 'explanation'}
            onClick={() => setNarrowPane('explanation')}
          >
            {leftSlot ? 'Chat' : 'Explanation'}
          </Button>
          <Button
            size="sm"
            variant={narrowPane === 'code' ? 'secondary' : 'ghost'}
            aria-pressed={narrowPane === 'code'}
            onClick={() => setNarrowPane('code')}
          >
            {rightSlot ? 'Interactive explanation' : 'Code'}
          </Button>
        </div>
        <div hidden={narrowPane !== 'explanation'} className="flex-1 min-h-0 overflow-hidden">
          <div {...narrativeScroll} hidden={!!leftSlot} className="h-full overflow-y-auto">
            {narrativeContent}
          </div>
          {leftSlot && <div className="review-tool-slot">{leftSlot}</div>}
        </div>
        <div hidden={narrowPane !== 'code'} className="flex-1 min-h-0 overflow-hidden">
          <div {...codeScroll} hidden={!!rightSlot} className="h-full overflow-y-auto">
            {diffContent}
          </div>
          {rightSlot && <div className="review-tool-slot">{rightSlot}</div>}
        </div>
      </div>
    );

  // ── Split mode ── resizable narrative (left) + diff (right) panels
  if (viewMode === 'split' || leftSlot || rightSlot) {
    return (
      <PanelGroup orientation="horizontal" className="flex flex-1 overflow-hidden">
        <Panel defaultSize={40} minSize={25} className="overflow-hidden min-h-0">
          <div {...narrativeScroll} hidden={!!leftSlot} className="h-full overflow-y-auto">
            {narrativeContent}
          </div>
          {leftSlot && <div className="review-tool-slot">{leftSlot}</div>}
        </Panel>
        <PanelResizeHandle className="w-px bg-border hover:bg-[var(--ring)]/40 transition-colors cursor-col-resize" />
        <Panel defaultSize={60} minSize={30} className="overflow-hidden min-h-0">
          <div {...codeScroll} hidden={!!rightSlot} className="h-full overflow-y-auto">
            {diffContent}
          </div>
          {rightSlot && <div className="review-tool-slot">{rightSlot}</div>}
        </Panel>
      </PanelGroup>
    );
  }

  // ── Focus mode ── narrative stacked above diff, both full-width,
  // single scrollable column. Ideal for complex sections where both
  // the narrative and the diff need horizontal space.
  return (
    <div {...focusScroll} className="flex-1 overflow-y-auto">
      {narrativeContent}
      <div className="border-t border-border">{diffContent}</div>
    </div>
  );
}
