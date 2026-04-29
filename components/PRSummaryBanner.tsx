import { ExternalLink, ArrowLeft, Settings, GitCompare } from 'lucide-react';
import { GitHubIcon, riskConfig, safeConfigLookup } from '@/lib/constants';
import type { ReviewGuide } from '@/lib/types';
import { formatDuration } from '@/lib/utils';
import { isLocalUrl } from '@/lib/local-url';
import { CopyAllChecksButton } from '@/components/CopyAllChecksButton';

interface Props {
  review: ReviewGuide;
  onBack?: () => void;
  onOpenSettings?: () => void;
}

// Persistent chrome at the top of every slide. Was a Card with
// rounded-none border-x-0 border-t-0 — now just a thin row of type
// on a hairline rule. Reads like the running header of a printed
// monograph: title on the left, metadata on the right, no fills.
/** Parse a `local:/abs/path#base..head` URL into its display-worthy parts.
 *  Returns null for non-local URLs or malformed inputs. */
function parseLocalRange(url: string): { base: string; head: string } | null {
  if (!url.startsWith('local:')) return null;
  const hash = url.lastIndexOf('#');
  if (hash === -1) return null;
  const range = url.slice(hash + 1);
  const dot = range.indexOf('..');
  if (dot === -1) return null;
  const base = range.slice(0, dot);
  let head = range.slice(dot + 2);
  if (head.startsWith('.')) head = head.slice(1);
  return base && head ? { base, head } : null;
}

export function PRSummaryBanner({ review, onBack, onOpenSettings }: Props) {
  const risk = safeConfigLookup(riskConfig, review.riskLevel, riskConfig.low);
  const isLocal = isLocalUrl(review.prUrl);
  const localRange = isLocal ? parseLocalRange(review.prUrl) : null;

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
          <CopyAllChecksButton review={review} variant="compact" />
          {onOpenSettings && (
            <button
              onClick={onOpenSettings}
              className="hover:text-foreground transition-colors"
              aria-label="Settings"
            >
              <Settings className="h-3.5 w-3.5" />
            </button>
          )}
          {isLocal ? (
            <span
              className="flex items-center gap-1.5 text-muted-foreground font-mono tabular-nums"
              title={review.prUrl}
            >
              <GitCompare className="h-3.5 w-3.5" />
              {localRange ? (
                <span className="truncate max-w-[28ch]">
                  {localRange.base} <span className="text-muted-foreground/60">→</span> {localRange.head}
                </span>
              ) : (
                <span>Local</span>
              )}
            </span>
          ) : (
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
          )}
        </div>
      </div>
    </header>
  );
}
