interface Props {
  filePath: string;
  gitFileUrlBase?: string | null;
  className?: string;
}

export function FilePathLink({ filePath, gitFileUrlBase, className }: Props) {
  const displayPath = filePath.replace(/^PR-[^/]+\//, '');
  if (!gitFileUrlBase) {
    return <span className={`truncate ${className ?? ''}`}>{displayPath}</span>;
  }

  return (
    <button
      type="button"
      className={`hover:underline hover:text-foreground transition-colors text-left truncate ${className ?? ''}`}
      onClick={() =>
        void window.electronAPI.openExternal(gitFileUrlBase + displayPath.split('/').map(encodeURIComponent).join('/'))
      }
      title={`Open on GitHub`}
    >
      {displayPath}
    </button>
  );
}
