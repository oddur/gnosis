interface Props {
  filePath: string;
  gitFileUrlBase?: string | null;
  className?: string;
}

export function FilePathLink({ filePath, gitFileUrlBase, className }: Props) {
  if (!gitFileUrlBase) {
    return <span className={className}>{filePath}</span>;
  }

  return (
    <button
      type="button"
      className={`hover:underline hover:text-foreground transition-colors text-left ${className ?? ''}`}
      onClick={() => void window.electronAPI.openExternal(gitFileUrlBase + filePath)}
      title={`Open on GitHub`}
    >
      {filePath}
    </button>
  );
}
