import { useState, useEffect, useMemo, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { ChangedFile } from '@/lib/types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prUrl: string;
  onConfirm: (excludedFiles: string[]) => void;
}

interface ExtGroup {
  ext: string;
  files: ChangedFile[];
  totalAdditions: number;
  totalDeletions: number;
}

function getExt(filename: string): string {
  const slash = filename.lastIndexOf('/');
  const base = filename.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return 'other';
  return base.slice(dot);
}

interface CheckboxProps {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  className?: string;
}

function Checkbox({ checked, indeterminate, onChange, className }: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = indeterminate ?? false;
    }
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      className={`h-4 w-4 shrink-0 cursor-pointer accent-primary ${className ?? ''}`}
    />
  );
}

export function FilePickerDialog({ open, onOpenChange, prUrl, onConfirm }: Props) {
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setExcluded(new Set());
    window.electronAPI
      .getPrFiles(prUrl)
      .then(setFiles)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load files');
      })
      .finally(() => setLoading(false));
  }, [open, prUrl]);

  const extGroups = useMemo<ExtGroup[]>(() => {
    const map = new Map<string, ChangedFile[]>();
    for (const f of files) {
      const ext = getExt(f.filename);
      const group = map.get(ext) ?? [];
      group.push(f);
      map.set(ext, group);
    }
    return Array.from(map.entries())
      .map(([ext, groupFiles]) => ({
        ext,
        files: groupFiles,
        totalAdditions: groupFiles.reduce((s, f) => s + f.additions, 0),
        totalDeletions: groupFiles.reduce((s, f) => s + f.deletions, 0),
      }))
      .sort((a, b) => a.ext.localeCompare(b.ext));
  }, [files]);

  const includedCount = files.length - excluded.size;

  function toggleFile(filename: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });
  }

  function toggleExt(ext: string) {
    const group = extGroups.find((g) => g.ext === ext);
    if (!group) return;
    const allExcluded = group.files.every((f) => excluded.has(f.filename));
    setExcluded((prev) => {
      const next = new Set(prev);
      if (allExcluded) {
        for (const f of group.files) next.delete(f.filename);
      } else {
        for (const f of group.files) next.add(f.filename);
      }
      return next;
    });
  }

  function handleConfirm() {
    onConfirm(Array.from(excluded));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card sm:max-w-2xl max-h-[80vh] flex flex-col gap-4">
        <DialogHeader>
          <DialogTitle>Select files to include</DialogTitle>
          <DialogDescription>Choose which files to include in the review</DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Loading files…</span>
          </div>
        )}

        {error && <p className="text-sm text-destructive py-4 text-center">{error}</p>}

        {!loading && !error && files.length > 0 && (
          <>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setExcluded(new Set())}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Select all
              </button>
              <span className="text-xs text-muted-foreground">·</span>
              <button
                type="button"
                onClick={() => setExcluded(new Set(files.map((f) => f.filename)))}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Deselect all
              </button>
            </div>

            <div className="overflow-y-auto -mx-6 min-h-0 flex-1 max-h-[50vh]">
              <ul>
                {extGroups.map((group) => {
                  const allExcluded = group.files.every((f) => excluded.has(f.filename));
                  const someExcluded = group.files.some((f) => excluded.has(f.filename));
                  const groupChecked = !allExcluded;
                  const groupIndeterminate = someExcluded && !allExcluded;

                  return (
                    <li key={group.ext}>
                      {/* Extension group row */}
                      <div className="flex items-center gap-2.5 px-6 py-2 hover:bg-muted/40 transition-colors">
                        <Checkbox
                          checked={groupChecked}
                          indeterminate={groupIndeterminate}
                          onChange={() => toggleExt(group.ext)}
                        />
                        <span className="text-sm font-medium flex-1 min-w-0">
                          {group.ext === 'other' ? '(no extension)' : group.ext}
                          <span className="ml-2 text-xs text-muted-foreground font-normal">
                            {group.files.length} {group.files.length === 1 ? 'file' : 'files'}
                          </span>
                        </span>
                        <span className="text-xs text-muted-foreground shrink-0">
                          <span className="text-green-400">+{group.totalAdditions}</span>{' '}
                          <span className="text-red-400">−{group.totalDeletions}</span>
                        </span>
                      </div>

                      {/* File rows */}
                      <ul>
                        {group.files.map((f) => {
                          const isExcluded = excluded.has(f.filename);
                          return (
                            <li key={f.filename}>
                              <div className="flex items-center gap-2.5 pl-12 pr-6 py-1.5 hover:bg-muted/30 transition-colors">
                                <Checkbox checked={!isExcluded} onChange={() => toggleFile(f.filename)} />
                                <span
                                  className={`text-xs flex-1 min-w-0 truncate font-mono ${isExcluded ? 'text-muted-foreground line-through' : ''}`}
                                >
                                  {f.filename}
                                </span>
                                <span className="text-xs text-muted-foreground shrink-0">
                                  <span className="text-green-400">+{f.additions}</span>{' '}
                                  <span className="text-red-400">−{f.deletions}</span>
                                </span>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </li>
                  );
                })}
              </ul>
            </div>
          </>
        )}

        <div className="flex gap-2 justify-end pt-2 border-t border-border/50">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={loading || includedCount === 0}>
            Start Review ({includedCount} of {files.length} {files.length === 1 ? 'file' : 'files'})
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
