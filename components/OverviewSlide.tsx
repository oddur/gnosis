import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Markdown } from '@/components/Markdown';
import { riskConfig } from '@/lib/constants';
import type { PrStatus, ReviewGuide } from '@/lib/types';

interface Props {
  review: ReviewGuide;
  prStatus: PrStatus | null;
  onNavigate: (slideNumber: number) => void;
}

// ─── StatusLine ────────────────────────────────────────────────
//
// Quiet mono line summarizing the PR's GitHub-side state. Replaces
// the previous cluster of 7+ colored pills. Each segment is plain
// text in muted-foreground; only segments that signal a *problem*
// (CI failing, conflicts, blocked, changes requested) get the warm
// coral color, so red actually means red. Everything else is just
// text — color as punctuation, not category shorthand.
function StatusLine({ status }: { status: PrStatus | null }) {
  if (!status) {
    return (
      <div className="slide-meta animate-pulse opacity-60 max-w-6xl mx-auto w-full mb-6">
        loading PR status…
      </div>
    );
  }

  const {
    ciConclusion,
    ciChecks,
    reviewSummary,
    isDraft,
    labels,
    baseBranch,
    commitCount,
    requestedReviewers,
    requestedTeams,
    mergeableState,
    autoMerge,
    milestone,
  } = status;

  const failCount = ciChecks.filter(
    (c) => c.conclusion === 'failure' || c.conclusion === 'timed_out' || c.conclusion === 'cancelled'
  ).length;

  type Segment = { text: string; tone?: 'warn' | 'error' };
  const segments: Segment[] = [];

  if (isDraft) segments.push({ text: 'draft' });

  if (ciConclusion === 'success') segments.push({ text: 'CI passing' });
  else if (ciConclusion === 'failure')
    segments.push({ text: failCount > 0 ? `CI failing (${failCount})` : 'CI failing', tone: 'error' });
  else if (ciConclusion === 'pending') segments.push({ text: 'CI pending', tone: 'warn' });
  else if (ciChecks.length === 0) segments.push({ text: 'no CI' });

  if (reviewSummary.approved > 0) {
    segments.push({ text: `${reviewSummary.approved} approved` });
  }
  if (reviewSummary.changesRequested > 0) {
    segments.push({ text: `${reviewSummary.changesRequested} changes requested`, tone: 'error' });
  }
  if (reviewSummary.approved === 0 && reviewSummary.changesRequested === 0) {
    segments.push({ text: 'no reviews' });
  }

  segments.push({ text: `${commitCount} ${commitCount === 1 ? 'commit' : 'commits'}` });

  const awaiting = [...requestedReviewers, ...requestedTeams];
  if (awaiting.length > 0) {
    segments.push({ text: `awaiting ${awaiting.join(', ')}`, tone: 'warn' });
  }

  // Mergeable state — only flag the non-clean states; "clean" is
  // the default and doesn't deserve a segment of its own.
  if (mergeableState === 'behind') segments.push({ text: 'behind base', tone: 'warn' });
  else if (mergeableState === 'dirty') segments.push({ text: 'has conflicts', tone: 'error' });
  else if (mergeableState === 'blocked') segments.push({ text: 'merge blocked', tone: 'error' });
  else if (mergeableState === 'unstable') segments.push({ text: 'unstable', tone: 'warn' });

  if (autoMerge) segments.push({ text: `auto-merge (${autoMerge.method})` });

  if (milestone) segments.push({ text: `milestone: ${milestone.title}` });

  // Cap labels at 3 to avoid the line ballooning on label-heavy PRs.
  const visibleLabels = labels.slice(0, 3);
  if (visibleLabels.length > 0) {
    segments.push({ text: visibleLabels.join(', ') });
    if (labels.length > visibleLabels.length) {
      segments.push({ text: `+${labels.length - visibleLabels.length} more` });
    }
  }

  segments.push({ text: `→ ${baseBranch}` });

  const toneClass = (tone?: 'warn' | 'error') =>
    tone === 'error'
      ? 'text-[oklch(0.65_0.14_22)]'
      : tone === 'warn'
        ? 'text-[oklch(0.7_0.12_55)]'
        : 'text-muted-foreground';

  return (
    <div className="slide-meta animate-fade-in-up max-w-6xl mx-auto w-full mb-8 leading-relaxed">
      {segments.map((seg, i) => (
        <span key={i}>
          <span className={toneClass(seg.tone)}>{seg.text}</span>
          {i < segments.length - 1 && <span className="text-muted-foreground/40 mx-2">·</span>}
        </span>
      ))}
    </div>
  );
}

// ─── OverviewSlide ─────────────────────────────────────────────

export function OverviewSlide({ review, prStatus, onNavigate }: Props) {
  const risk = riskConfig[review.riskLevel];
  const [descOpen, setDescOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);

  const riskToneClass =
    review.riskLevel === 'high'
      ? 'text-[oklch(0.65_0.14_22)]'
      : review.riskLevel === 'medium'
        ? 'text-[oklch(0.7_0.12_55)]'
        : 'text-muted-foreground';

  return (
    <div className="flex-1 overflow-y-auto px-8 py-10">
      <StatusLine status={prStatus} />

      <div className="max-w-6xl mx-auto w-full grid grid-cols-[2fr_3fr] gap-12 items-start">
        {/* Left column — context */}
        <div className="flex flex-col gap-8 sticky top-0">
          {/* Summary — no label, the prose stands on its own.
              The slide-prose class gives it the right measure and
              line-height; nothing else needed. */}
          <section className="animate-fade-in-up">
            <Markdown className="slide-prose text-foreground">{review.summary}</Markdown>
            {(review.neighborFileCount ?? 0) > 0 && (
              <p className="slide-meta mt-3">
                {review.neighborFileCount} additional {review.neighborFileCount === 1 ? 'file' : 'files'} included for
                context
              </p>
            )}
          </section>

          {/* Risk — a single inline editorial line. No box, no
              badge, no border. The risk level is bolded in tone
              color and the rationale follows as plain prose. */}
          <section className="animate-fade-in-up" style={{ animationDelay: '60ms' }}>
            <p className="slide-prose">
              <span className={`editorial-label ${riskToneClass}`}>{risk.label}.</span>{' '}
              <span className="text-muted-foreground">{review.riskRationale}</span>
            </p>
          </section>

          {/* PR Description — collapsible inline disclosure. No
              box around the expanded content; just a chevron
              toggle and indented prose. */}
          {review.prDescription && (
            <section className="animate-fade-in-up" style={{ animationDelay: '120ms' }}>
              <button
                onClick={() => setDescOpen((v) => !v)}
                className="slide-meta hover:text-foreground transition-colors flex items-center gap-1.5"
              >
                {descOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                PR description
              </button>
              {descOpen && (
                <div className="mt-3 ml-4 max-h-64 overflow-y-auto border-l border-border pl-4">
                  <Markdown className="text-sm text-muted-foreground leading-relaxed">{review.prDescription}</Markdown>
                </div>
              )}
            </section>
          )}

          {/* Web Sources — same pattern as PR description. */}
          {review.webSources && review.webSources.length > 0 && (
            <section className="animate-fade-in-up" style={{ animationDelay: '180ms' }}>
              <button
                onClick={() => setSourcesOpen((v) => !v)}
                className="slide-meta hover:text-foreground transition-colors flex items-center gap-1.5"
              >
                {sourcesOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                Web sources ({review.webSources.length})
              </button>
              {sourcesOpen && (
                <ul className="mt-3 ml-4 flex flex-col gap-1.5 border-l border-border pl-4">
                  {review.webSources.map((source, i) => (
                    <li key={i}>
                      <button
                        onClick={() => window.electronAPI.openExternal(source.url)}
                        className="text-sm text-[var(--ring)] hover:underline truncate max-w-full text-left"
                        title={source.url}
                      >
                        {source.title || source.url}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>

        {/* Right column — slides as a numbered table of contents.
            No card, no border, no fills. Each entry is a row with
            a mono chapter number, a serif title, and a quiet
            file-count meta. Hairline rules between rows are the
            only chrome. */}
        <section>
          <ol className="flex flex-col">
            {review.slides.map((slide, index) => {
              const num = slide.slideNumber.toString().padStart(2, '0');
              const fileCount = slide.affectedFiles.length;
              const fileLabel = `${fileCount} ${fileCount === 1 ? 'file' : 'files'}`;
              return (
                <li key={slide.id}>
                  <button
                    onClick={() => onNavigate(slide.slideNumber)}
                    className="animate-fade-in-up group w-full grid grid-cols-[2.5rem_1fr_auto] gap-4 items-baseline py-4 text-left border-b border-border/60 last:border-b-0"
                    style={{ animationDelay: `${120 + index * 50}ms` }}
                  >
                    <span className="slide-meta text-muted-foreground/70 text-right">{num}</span>
                    <span className="font-serif text-base leading-snug text-foreground/85 group-hover:text-foreground transition-colors text-balance">
                      {slide.title}
                    </span>
                    <span className="slide-meta">{fileLabel}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      </div>
    </div>
  );
}
