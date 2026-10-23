import { FileTypeIcon } from './FileTypeIcon';

interface Props {
  compact?: boolean;
  filePath: string;
  gitFileUrlBase?: string | null;
  className?: string;
}

export function FilePathLink({ filePath, gitFileUrlBase, className, compact = false }: Props) {
  const displayPath = filePath.replace(/^PR-[^/]+\//, '');
  const slash = displayPath.lastIndexOf('/');
  const content =
    compact && slash >= 0 ? (
      <>
        <span className="truncate shrink-0 max-w-[65%]">{displayPath.slice(slash + 1)}</span>
        <span className="truncate text-muted-foreground">{displayPath.slice(0, slash)}</span>
      </>
    ) : (
      <span className="truncate">{displayPath}</span>
    );
  const layout = compact
    ? 'flex items-center gap-2 min-w-0'
    : 'inline-flex items-center gap-2 min-w-0 max-w-full align-middle';
  if (!gitFileUrlBase) {
    return (
      <span title={displayPath} className={`${layout} ${className ?? ''}`}>
        <FileTypeIcon filePath={displayPath} />
        {content}
      </span>
    );
  }

  return (
    <button
      type="button"
      className={`hover:underline hover:text-foreground transition-colors text-left ${layout} ${className ?? ''}`}
      onClick={() =>
        void window.electronAPI.openExternal(gitFileUrlBase + displayPath.split('/').map(encodeURIComponent).join('/'))
      }
      aria-label={`Open ${displayPath} on GitHub`}
      title={`Open ${displayPath} on GitHub`}
    >
      <FileTypeIcon filePath={displayPath} />
      {content}
    </button>
  );
}
