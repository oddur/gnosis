import { Download, LoaderCircle } from 'lucide-react';
import { Button } from './ui/button';
import { lfsSize, type LfsPointer } from '../lib/git-lfs';

/** Shared explicit opt-in for resource downloads in inspection and explanation diffs. */
export function LfsDownload({
  pointers,
  busy,
  error,
  onDownload,
}: {
  pointers: LfsPointer[];
  busy: boolean;
  error?: string;
  onDownload: () => void;
}) {
  const unique = [...new Map(pointers.map((pointer) => [pointer.oid, pointer])).values()];
  const bytes = unique.reduce((size, pointer) => size + pointer.size, 0);
  const oversized = unique.some((pointer) => pointer.size > 8 * 1024 * 1024);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded border border-border bg-muted/30 p-4" aria-busy={busy}>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">Git LFS resource · {lfsSize(bytes)}</p>
        <p className="text-sm text-muted-foreground" role="status">
          {error ||
            (oversized
              ? 'This resource exceeds the 8 MB preview limit. Open it on GitHub or in your checkout.'
              : busy
                ? 'Downloading the displayed revisions…'
                : 'Download to preview the file contents. Nothing is downloaded automatically.')}
        </p>
      </div>
      {!oversized && (
        <Button variant="outline" size="sm" disabled={busy} onClick={onDownload}>
          {busy ? (
            <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : (
            <Download size={14} aria-hidden="true" />
          )}
          {busy ? 'Downloading…' : error ? 'Retry download' : 'Download'}
        </Button>
      )}
    </div>
  );
}
