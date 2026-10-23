import { ChevronDown, ChevronRight, MessageSquare } from 'lucide-react';
import { FilePathLink } from './FilePathLink';
import { prepareReviewHunk } from '@/lib/review-diff';
import type { DiffHunk, FileMetadata } from '@/lib/types';

interface Props {
  filePath: string;
  hunks: DiffHunk[];
  gitFileUrlBase?: string | null;
  metadata?: FileMetadata;
  summary?: string;
  source?: { number: number; title: string };
  commentCount: number;
  age?: string | null;
  expanded?: boolean;
  contentId?: string;
  onToggleExpanded?: () => void;
  viewed?: boolean;
  onViewedChange?: (viewed: boolean) => void;
}

function shownCounts(hunks: DiffHunk[]) {
  const additions = new Set<number>();
  const deletions = new Set<number>();
  for (const hunk of hunks) {
    for (const line of prepareReviewHunk(hunk)?.lines ?? []) {
      if (line.type === 'add') additions.add(line.lineNumber);
      if (line.type === 'remove') deletions.add(line.lineNumber);
    }
  }
  return { additions: additions.size, deletions: deletions.size };
}

/** One header for the whole file, so source and summary remain pinned across
 * Pierre's separate saved hunks and expandable context sections. */
export function ReviewFileHeader({
  filePath,
  hunks,
  gitFileUrlBase,
  metadata,
  summary,
  source,
  commentCount,
  age,
  expanded = true,
  contentId,
  onToggleExpanded,
  viewed = false,
  onViewedChange,
}: Props) {
  const counts = metadata ?? shownCounts(hunks);
  const scope = metadata ? 'in this change' : 'shown in this topic';
  const status = metadata?.status;
  const statusLabel =
    status === 'added'
      ? 'Added'
      : status === 'deleted'
        ? 'Deleted'
        : status === 'renamed'
          ? 'Renamed'
          : status === 'modified'
            ? 'Modified'
            : null;
  return (
    <div className="review-file-context" aria-label="Current source" data-collapsed={!expanded}>
      <div className="review-file-heading">
        <div className="review-file-identity">
          {onToggleExpanded && (
            <button
              type="button"
              className="review-file-expand"
              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${filePath}`}
              aria-expanded={expanded}
              aria-controls={contentId}
              onClick={onToggleExpanded}
            >
              {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
            </button>
          )}
          {source && (
            <span className="source-attribution" title={source.title}>
              PR #{source.number}
            </span>
          )}
          <FilePathLink
            compact
            filePath={filePath}
            gitFileUrlBase={gitFileUrlBase}
            className="font-mono text-xs min-w-0 flex-1"
          />
        </div>
        <div className="review-file-details">
          {statusLabel && (
            <span className="review-file-status" data-status={status}>
              {statusLabel}
            </span>
          )}
          {(counts.additions > 0 || counts.deletions > 0) && (
            <span
              className="review-file-counts"
              title={`File totals ${scope}`}
              aria-label={`${counts.additions} added lines, ${counts.deletions} removed lines ${scope}`}
            >
              <span className="text-[var(--color-success)]">+{counts.additions}</span>
              <span className="text-[var(--color-danger)]">−{counts.deletions}</span>
            </span>
          )}
          {commentCount > 0 && (
            <span
              className="review-file-comments inline-flex items-center gap-1"
              title={`${commentCount} pending ${commentCount === 1 ? 'comment' : 'comments'}`}
            >
              <MessageSquare className="size-3" aria-hidden="true" />
              {commentCount}
              <span className="sr-only"> pending {commentCount === 1 ? 'comment' : 'comments'}</span>
            </span>
          )}
          {onViewedChange && (
            <label className="review-file-viewed" title="Track this file as viewed in Gnosis">
              <input
                type="checkbox"
                checked={viewed}
                onChange={(event) => onViewedChange(event.target.checked)}
                aria-label={`Viewed ${filePath}`}
              />
              Viewed
            </label>
          )}
        </div>
      </div>
      {expanded && summary && <p className="review-file-summary select-text">{summary}</p>}
      {expanded && (age || (metadata?.prCommitCount ?? 1) > 1) && (
        <div className="review-file-history">
          {age && <span>Last changed {age.replace(/ old$/, '')} ago</span>}
          {(metadata?.prCommitCount ?? 1) > 1 && <span>Touched in {metadata?.prCommitCount} commits in this PR</span>}
        </div>
      )}
    </div>
  );
}
