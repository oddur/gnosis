import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { FreshnessResult } from '../lib/types';
import { timeAgo } from '../lib/utils';

interface Props {
  freshness: FreshnessResult;
  onReReview: () => void;
}

const MAX_DISPLAYED_COMMITS = 20;

// Freshness banner. Was a series of rounded card-shaped boxes; now a
// thin typographic strip that sits between the PR header and the slide
// content. The semantic color comes from the staleBanner-* classes
// (already warmed in /colorize); the structure is just type and a
// hairline rule, no rounded fills.
export function StaleBanner({ freshness, onReReview }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (freshness.status === 'current') {
    return (
      <div className="staleBanner-current border-b border-[var(--color-success)]/24 px-6 py-1.5 text-xs">
        Up to date
      </div>
    );
  }

  if (freshness.status === 'unknown') {
    return (
      <div className="staleBanner-unknown border-b border-border px-6 py-1.5 text-xs">
        Couldn't check freshness: {freshness.reason}
      </div>
    );
  }

  if (freshness.status === 'force-pushed') {
    return (
      <div className="staleBanner-warn border-b border-[var(--color-warning)]/28 px-6 py-1.5 text-xs flex items-center justify-between gap-2">
        <span>PR was force-pushed since this review was generated.</span>
        <button
          onClick={onReReview}
          className="staleBanner-warn-btn px-2 py-0.5 rounded-sm text-xs transition-colors"
        >
          Re-review
        </button>
      </div>
    );
  }

  // status === 'stale'
  const { aheadBy, commits } = freshness;
  const displayed = commits.slice(0, MAX_DISPLAYED_COMMITS);
  const overflow = aheadBy - displayed.length;

  return (
    <div className="staleBanner-warn border-b border-[var(--color-warning)]/28 text-xs">
      <div className="flex items-center justify-between gap-2 px-6 py-1.5">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="staleBanner-warn-toggle inline-flex items-center gap-1.5 text-left transition-colors"
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {aheadBy} commit{aheadBy !== 1 ? 's' : ''} behind
        </button>
        <button
          onClick={onReReview}
          className="staleBanner-warn-btn px-2 py-0.5 rounded-sm text-xs transition-colors"
        >
          Re-review
        </button>
      </div>

      {expanded && (
        <ul className="staleBanner-warn-list px-6 py-2 flex flex-col gap-1">
          {displayed.map((c) => (
            <li key={c.sha} className="flex items-baseline gap-2">
              <code className="staleBanner-warn-sha shrink-0">{c.sha.slice(0, 7)}</code>
              <span className="truncate">{c.message}</span>
              <span className="staleBanner-warn-meta shrink-0">
                {c.authorLogin}
                {c.authorDate ? ` · ${timeAgo(c.authorDate)}` : ''}
              </span>
            </li>
          ))}
          {overflow > 0 && <li className="staleBanner-warn-meta">and {overflow} more…</li>}
        </ul>
      )}
    </div>
  );
}
