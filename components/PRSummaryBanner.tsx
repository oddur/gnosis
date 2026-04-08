import { ExternalLink, ArrowLeft, Settings } from 'lucide-react';
import { GitHubIcon } from '@/lib/constants';
import { riskConfig } from '@/lib/constants';
import type { ReviewGuide } from '@/lib/types';
import { formatDuration } from '@/lib/utils';

interface Props {
  review: ReviewGuide;
  onBack?: () => void;
  onOpenSettings?: () => void;
}

// Persistent chrome at the top of every slide. Was a Card with
// rounded-none border-x-0 border-t-0 — now just a thin row of type
// on a hairline rule. Reads like the running header of a printed
// monograph: title on the left, metadata on the right, no fills.
export function PRSummaryBanner({ review, onBack, onOpenSettings }: Props) {
  const risk = riskConfig[review.riskLevel];

  return (
    <header className="border-b border-border px-6 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          {onBack && (
            <button
              onClick={onBack}
              className="slide-meta hover:text-foreground transition-colors flex items-center gap-1 shrink-0"
              title="Back to home"
            >
              <ArrowLeft className="h-3 w-3" />
              Back
            </button>
          )}
          <h1 className="text-sm font-semibold tracking-tight truncate text-foreground/90">{review.prTitle}</h1>
          <span className={`${risk.badgeClassName} shrink-0 text-[10px] px-1.5 py-0.5 rounded-sm leading-none`}>
            {risk.label}
          </span>
        </div>

        <div className="flex items-center gap-5 shrink-0 slide-meta">
          <span>{review.author}</span>
          <span>
            {review.totalFilesChanged} {review.totalFilesChanged === 1 ? 'file' : 'files'}
          </span>
          <span>{review.totalLinesChanged} lines</span>
          {review.generationDurationMs != null && <span>{formatDuration(review.generationDurationMs)}</span>}
          {onOpenSettings && (
            <button
              onClick={onOpenSettings}
              className="hover:text-foreground transition-colors"
              aria-label="Settings"
            >
              <Settings className="h-3.5 w-3.5" />
            </button>
          )}
          <a
            href={review.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground transition-colors flex items-center gap-1"
            title="Open on GitHub"
          >
            <GitHubIcon className="h-3.5 w-3.5" />
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>
    </header>
  );
}
