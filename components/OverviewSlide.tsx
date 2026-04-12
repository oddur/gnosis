import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Markdown } from '@/components/Markdown';
import { riskConfig, safeConfigLookup } from '@/lib/constants';
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
      ? 'text-[var(--color-danger)]'
      : tone === 'warn'
        ? 'text-[var(--color-warning)]'
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
  const risk = safeConfigLookup(riskConfig, review.riskLevel, riskConfig.low);
  const [descOpen, setDescOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [remainingOpen, setRemainingOpen] = useState(false);

  // Files that appear in changedFiles but not in any slide's
  // affectedFiles. These are the "remaining changes" — files in the
  // PR that the AI didn't feature in the walkthrough.
  const remainingFiles = (() => {
    if (!review.changedFiles || review.changedFiles.length === 0) return [];
    const narrated = new Set(review.slides.flatMap((s) => s.affectedFiles));
    return review.changedFiles.filter((f) => !narrated.has(f.filename));
  })();

  const riskToneClass =
    review.riskLevel === 'high'
      ? 'text-[var(--color-danger)]'
      : review.riskLevel === 'medium'
        ? 'text-[var(--color-warning)]'
        : 'text-muted-foreground';

  // The first real chapter — used to render the prominent
  // "Start reading" call-to-action at the bottom of the prose.
  // .at() returns T | undefined regardless of noUncheckedIndexedAccess.
  const firstSlide = review.slides.at(0);

  return (
    <div className="flex-1 overflow-y-auto px-10 py-10">
      <StatusLine status={prStatus} />

      {/* Single-column prose layout. The persistent TocRail in the
          parent ReviewPage replaces the previous right-column TOC,
          which frees the overview to be a comfortable reading
          column at editorial measure. */}
      <div className="max-w-3xl mx-auto w-full flex flex-col gap-8">
        {/* Summary — no label, the prose stands on its own. */}
        <section className="animate-fade-in-up">
          <Markdown className="slide-prose">{review.summary}</Markdown>
          {(review.neighborFileCount ?? 0) > 0 && (
            <p className="slide-meta mt-3">
              {review.neighborFileCount} additional {review.neighborFileCount === 1 ? 'file' : 'files'} included for
              context
            </p>
          )}
        </section>

        {/* Risk — a single inline editorial line. */}
        <section className="animate-fade-in-up" style={{ animationDelay: '60ms' }}>
          <p className="slide-prose">
            <span className={`editorial-label ${riskToneClass}`}>{risk.label}.</span>{' '}
            <span className="text-muted-foreground">{review.riskRationale}</span>
          </p>
        </section>

        {/* PR Description — collapsible inline disclosure. */}
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

        {/* Start reading — the explicit "click here to begin"
            affordance. The bottom nav also surfaces this as
            "Begin reading: NN — title", but having the same call
            on the page itself catches users who scroll the prose
            without noticing the bottom bar. */}
        {firstSlide && (
          <section
            className="animate-fade-in-up pt-6 mt-2 border-t border-border"
            style={{ animationDelay: '240ms' }}
          >
            <button
              onClick={() => onNavigate(firstSlide.slideNumber)}
              className="group flex items-baseline gap-3 text-left"
            >
              <span className="slide-meta">Start reading</span>
              <span className="font-serif text-lg text-foreground group-hover:opacity-80 transition-opacity">
                {firstSlide.slideNumber.toString().padStart(2, '0')} — {firstSlide.title} →
              </span>
            </button>
          </section>
        )}

        {/* Remaining changes — files in the PR that the AI didn't
            feature in any slide. Collapsed by default so they don't
            distract, but visible enough that the reviewer knows
            they exist and can inspect them. Ensures 100% coverage. */}
        {remainingFiles.length > 0 && (
          <section
            className="animate-fade-in-up pt-6 mt-2 border-t border-border"
            style={{ animationDelay: '300ms' }}
          >
            <button
              onClick={() => setRemainingOpen((v) => !v)}
              className="slide-meta hover:text-foreground transition-colors flex items-center gap-1.5"
            >
              {remainingOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {remainingFiles.length} {remainingFiles.length === 1 ? 'file' : 'files'} not featured in the walkthrough
            </button>
            {remainingOpen && (
              <ul className="mt-3 ml-4 flex flex-col gap-1 border-l border-border pl-4">
                {remainingFiles.map((f) => (
                  <li key={f.filename} className="slide-meta flex items-center gap-3">
                    <span className="truncate">{f.filename}</span>
                    <span className="shrink-0 opacity-60">
                      +{f.additions} −{f.deletions}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
