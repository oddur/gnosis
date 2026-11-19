import { useLayoutEffect, type RefObject } from 'react';
import { applyCodePalette } from '@/lib/diff-code-palette';
import { MarkdownViewSwitch } from './MarkdownViewSwitch';
import { PrBadge } from './EntityBadge';
import { ExternalLink, MessageSquare } from 'lucide-react';
import { prepareReviewHunk } from '@/lib/review-diff';
import type { DiffHunk, FileMetadata } from '@/lib/types';
import { DiffFileHeader } from './DiffFileHeader';
import { Button } from './ui/button';

interface Props {
  markdownPreview?: boolean;
  filePath: string;
  previousPath?: string;
  hunks: DiffHunk[];
  gitFileUrlBase?: string | null;
  metadata?: FileMetadata;
  summary?: string;
  source?: { number: number; title: string; url?: string };
  commentCount: number;
  age?: string | null;
  expanded?: boolean;
  contentId?: string;
  onToggleExpanded?: () => void;
  viewed?: boolean;
  onViewedChange?: (viewed: boolean) => void;
  headerRef?: RefObject<HTMLElement | null>;
  /** The diff's Pierre theme: the header takes its palette, as Changes' does (lib/code-palette.ts). */
  codeTheme?: string;
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

/**
 * A topic file's header: Changes' own code-tier header (DiffFileHeader), with what a topic adds: the expand button,
 * the topic's draft comments and a link to the file on GitHub. A stack's PR sits above it, as in Changes' stack view.
 * The topic's summary of the file and its history follow below, in the reading tier, and scroll away; only the header
 * pins, so the hunk headers pinned under it keep the code in view.
 */
export function ReviewFileHeader({
  markdownPreview,
  filePath,
  previousPath,
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
  headerRef,
  codeTheme,
}: Props) {
  useLayoutEffect(() => applyCodePalette(codeTheme), [codeTheme]);
  const counts = metadata ?? shownCounts(hunks);
  const scope = metadata ? 'in this change' : 'shown in this topic';
  const displayPath = filePath.replace(/^PR-[^/]+\//, '');
  const history = (age || (metadata?.prCommitCount ?? 1) > 1) && (
    <div className="review-file-history">
      {age && <span>Last changed {age.replace(/ old$/, '')} ago</span>}
      {(metadata?.prCommitCount ?? 1) > 1 && <span>Touched in {metadata?.prCommitCount} commits in this PR</span>}
    </div>
  );
  return (
    <>
      {source && (
        <div className="changes-file-context">
          <span className="source-attribution" title={source.title}>
            {source.url ? <PrBadge url={source.url} number={source.number} title={source.title} /> : `PR #${source.number}`}
          </span>
        </div>
      )}
      <DiffFileHeader
        headerRef={headerRef}
        path={displayPath}
        previousPath={previousPath?.replace(/^PR-[^/]+\//, '')}
        status={metadata?.status}
        additions={counts.additions}
        deletions={counts.deletions}
        countsLabel={`${counts.additions} added ${counts.additions === 1 ? 'line' : 'lines'}, ${counts.deletions} removed ${counts.deletions === 1 ? 'line' : 'lines'} ${scope}`}
        lead={
          onToggleExpanded && (
            <button
              type="button"
              className="review-file-expand"
              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${displayPath}`}
              aria-expanded={expanded}
              aria-controls={contentId}
              onClick={onToggleExpanded}
            >
              <span className={`icon-mask ${expanded ? 'icon-chevron-down' : 'icon-chevron-right'}`} aria-hidden="true" />
            </button>
          )
        }
        actions={
          <>
            {markdownPreview && <MarkdownViewSwitch />}
            {commentCount > 0 && (
              <span
                className="review-file-comments"
                title={`${commentCount} pending ${commentCount === 1 ? 'comment' : 'comments'}`}
              >
                <MessageSquare size={14} aria-hidden="true" />
                {commentCount}
                <span className="sr-only"> pending {commentCount === 1 ? 'comment' : 'comments'}</span>
              </span>
            )}
            {onViewedChange && (
              <label title="Track this file as viewed in Gnosis">
                <input
                  type="checkbox"
                  checked={viewed}
                  onChange={(event) => onViewedChange(event.target.checked)}
                  aria-label={`Viewed ${displayPath}`}
                />
                Viewed
              </label>
            )}
            {gitFileUrlBase && (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Open ${displayPath} on GitHub`}
                title={`Open ${displayPath} on GitHub`}
                onClick={() =>
                  void window.electronAPI.openExternal(
                    gitFileUrlBase + displayPath.split('/').map(encodeURIComponent).join('/')
                  )
                }
              >
                <ExternalLink size={14} aria-hidden="true" />
              </Button>
            )}
          </>
        }
      />
      {expanded && (summary || history) && (
        <div className="review-file-notes">
          {summary && <p className="review-file-summary select-text">{summary}</p>}
          {history}
        </div>
      )}
    </>
  );
}
