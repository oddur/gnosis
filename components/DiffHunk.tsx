import { FilePathLink } from '@/components/FilePathLink';
import type { DiffHunk as DiffHunkType } from '@/lib/types';

interface Props {
  hunk: DiffHunkType;
  showFileHeader?: boolean;
  gitFileUrlBase?: string | null;
}

export function DiffHunk({ hunk, showFileHeader = true, gitFileUrlBase }: Props) {
  return (
    <div className="rounded-md border overflow-x-auto">
      {showFileHeader && (
        <div className="bg-muted/50 px-3 py-2 font-mono text-xs text-muted-foreground border-b truncate">
          <FilePathLink filePath={hunk.filePath} gitFileUrlBase={gitFileUrlBase} />
        </div>
      )}
      {hunk.hunkHeader && (
        <div className="bg-muted/30 px-3 py-1 font-mono text-xs text-muted-foreground border-b">{hunk.hunkHeader}</div>
      )}
      <div className="select-text" dangerouslySetInnerHTML={{ __html: hunk.renderedHtml }} />
    </div>
  );
}

interface GroupedProps {
  filePath: string;
  hunks: DiffHunkType[];
  gitFileUrlBase?: string | null;
}

export function DiffHunkGroup({ filePath, hunks, gitFileUrlBase }: GroupedProps) {
  return (
    <div className="rounded-md border overflow-x-auto">
      <div className="bg-muted/50 px-3 py-2 font-mono text-xs text-muted-foreground border-b truncate">
        <FilePathLink filePath={filePath} gitFileUrlBase={gitFileUrlBase} />
      </div>
      {hunks.map((hunk, i) => (
        <div key={i}>
          {i > 0 && <div className="border-t border-dashed border-muted" />}
          {hunk.hunkHeader && (
            <div className="bg-muted/30 px-3 py-1 font-mono text-xs text-muted-foreground border-b">
              {hunk.hunkHeader}
            </div>
          )}
          <div className="select-text" dangerouslySetInnerHTML={{ __html: hunk.renderedHtml }} />
        </div>
      ))}
    </div>
  );
}
