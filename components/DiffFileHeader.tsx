import type { ReactNode, Ref } from 'react';
import { quietKindInfo, type QuietHeader } from '../lib/quiet-changes-header';
import { DiffStats } from './DiffStats';
import { FileTypeIcon } from './FileTypeIcon';

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
  fileCounts,
  lead,
  tags,
  actions,
  noise,
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
  /**
   * The whole file's counts, when `additions` and `deletions` count only an Explanation section's part of it (#560):
   * "+3 −692 here · file +14 −1947". Changes never passes them.
   */
  fileCounts?: { additions: number; deletions: number };
  /** Before the path, such as the topic's expand button. */
  lead?: ReactNode;
  /** After the status and counts: the file's kind tags, or the stack PR it comes from. */
  tags?: ReactNode;
  actions?: ReactNode;
  /**
   * How much of the change is noise the reader hides (#396), quietly after the counts: "90 formatting", or the
   * file's whole label, "Formatting only", when every change is.
   */
  noise?: QuietHeader;
}) {
  const fullPath = previousPath ? `${previousPath} → ${path}` : path;
  const counted = additions !== undefined && deletions !== undefined;
  return (
    <header ref={headerRef} className="changes-file-header" data-status={status}>
      {lead}
      <div className="changes-file-title">
        {/* The header is code-tier, dark in both app themes, so the icon uses its dark variant. */}
        <FileTypeIcon filePath={path} surface="dark" />
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
                    {fileCounts && (
                      <span className="changes-file-part" aria-hidden="true">
                        {' here'}
                        <span className="changes-file-sep"> · </span>
                        {'file '}
                        <DiffStats additions={fileCounts.additions} deletions={fileCounts.deletions} />
                      </span>
                    )}
                  </span>
                </>
              )}
              {noise && (
                <>
                  <span className="changes-file-sep"> · </span>
                  <span className="changes-file-noise" title={noise.title} data-noise-stat="" data-noise-kind={noise.kind}>
                    <QuietIcon kind={noise.kind} />
                    {noise.code && (
                      <span className="changes-file-code" data-noise-code="">
                        <DiffStats additions={noise.code.added} deletions={noise.code.deleted} /> code ·{' '}
                      </span>
                    )}
                    {noise.text}
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

/** A quiet change’s icon, beside its words: a pilcrow for whitespace, a brush for formatting, a slash for comments, an arrow in for imports. */
function QuietIcon({ kind }: { kind: QuietHeader['kind'] }) {
  const { Icon } = quietKindInfo(kind);
  return <Icon size={12} aria-hidden="true" />;
}
