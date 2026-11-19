import type { ReactNode, Ref } from 'react';
import { DiffStats } from './DiffStats';

/**
 * A changed file's header, in the code tier (#395): its path in the code's type, its status and counts, and the view's
 * actions on the right, on a surface drawn from the diff's syntax theme (lib/code-palette.ts). Changes
 * (PrFileInspection) and Explanation topics (ReviewFileHeader) both render it, so the two headers stay one design;
 * each passes its own actions. The header sticks to the top of its scroller, and the hunk headers pin under it.
 */
export function DiffFileHeader({
  headerRef,
  path,
  previousPath,
  status,
  stats,
  additions,
  deletions,
  countsLabel,
  lead,
  tags,
  actions,
}: {
  headerRef?: Ref<HTMLElement>;
  path: string;
  previousPath?: string;
  /** The file's status, for the rule on the header's left edge: added, deleted, renamed or modified. */
  status?: string;
  /** Replaces the status word and counts, such as "Moved · contents unchanged". */
  stats?: ReactNode;
  additions?: number;
  deletions?: number;
  /** The counts in words, when they are not the whole file's ("in this topic"). */
  countsLabel?: string;
  /** Before the path, such as the topic's expand button. */
  lead?: ReactNode;
  /** After the status and counts: the file's kind tags, or the stack PR it comes from. */
  tags?: ReactNode;
  actions?: ReactNode;
}) {
  const fullPath = previousPath ? `${previousPath} → ${path}` : path;
  const counted = additions !== undefined && deletions !== undefined;
  return (
    <header ref={headerRef} className="changes-file-header" data-status={status}>
      {lead}
      <div className="changes-file-title">
        <h2 title={fullPath} data-renamed={previousPath ? '' : undefined}>
          {previousPath && (
            <>
              <FilePath path={previousPath} old />
              <span className="changes-file-arrow"> → </span>
            </>
          )}
          <FilePath path={path} />
        </h2>
        <span className="changes-file-stats">
          {stats ?? (
            <>
              {status}
              {counted && (
                <>
                  {status && <span className="changes-file-sep"> · </span>}
                  <span className="changes-file-counts" title={countsLabel} aria-label={countsLabel}>
                    <DiffStats additions={additions} deletions={deletions} />
                  </span>
                </>
              )}
            </>
          )}
        </span>
        {tags}
      </div>
      {actions && <div className="changes-file-actions">{actions}</div>}
    </header>
  );
}

/**
 * A file's path in the code's type: folders muted, the name in the text colour. A long path gives way from the left,
 * `…/Core/ECONemoConnector.cs`, keeping its name; the text stays whole for selection and copying.
 */
export function FilePath({ path, old }: { path: string; old?: boolean }) {
  const slash = path.lastIndexOf('/');
  return (
    <span className="changes-file-path" data-old={old || undefined}>
      {slash >= 0 && (
        <span className="changes-file-dir">
          <span>{path.slice(0, slash + 1)}</span>
        </span>
      )}
      <span className="changes-file-name">{path.slice(slash + 1)}</span>
    </span>
  );
}
