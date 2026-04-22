import { useState, useCallback, useEffect } from 'react';
import { FolderOpen, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with a synthetic `local:…#base..head` URL and the tool-mode flag
   *  on success. `localTools` is true when the reviewer opted in to run
   *  project-local skills / MCP servers / tests during the review. */
  onSubmit: (localUrl: string, opts: { localTools: boolean }) => void;
}

const LAST_REPO_PATH_KEY = 'gnosis-local-repo-last-path';
const LAST_LOCAL_TOOLS_KEY = 'gnosis-local-repo-last-tools';

function buildUrl(repoPath: string, baseRef: string, headRef: string): string {
  return `local:${repoPath}#${baseRef}..${headRef}`;
}

// Read last path lazily — localStorage access inside the component body,
// not top-level, so SSR / test environments without `window` don't break.
function loadLastRepoPath(): string {
  try {
    return localStorage.getItem(LAST_REPO_PATH_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveLastRepoPath(p: string): void {
  try {
    localStorage.setItem(LAST_REPO_PATH_KEY, p);
  } catch {
    /* quota / disabled — fine */
  }
}

export function LocalRepoDialog({ open, onOpenChange, onSubmit }: Props) {
  const [repoPath, setRepoPath] = useState('');
  const [baseRef, setBaseRef] = useState('HEAD~1');
  const [headRef, setHeadRef] = useState('HEAD');
  const [localTools, setLocalTools] = useState(false);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<{ title: string; hint: string; detail?: string } | null>(null);
  const [refs, setRefs] = useState<{ branches: string[]; tags: string[] }>({ branches: [], tags: [] });
  const [loadingRefs, setLoadingRefs] = useState(false);
  const [preview, setPreview] = useState<{ changedFileCount: number; mergeBase: string | null } | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  // Seed path + tool-mode preference from last-used values on open.
  useEffect(() => {
    if (!open) return;
    const last = loadLastRepoPath();
    if (last) setRepoPath(last);
    try {
      setLocalTools(localStorage.getItem(LAST_LOCAL_TOOLS_KEY) === '1');
    } catch {
      /* localStorage unavailable */
    }
  }, [open]);

  // Fetch branches + tags whenever the repo path changes (debounced).
  useEffect(() => {
    const trimmed = repoPath.trim();
    if (!trimmed) {
      setRefs({ branches: [], tags: [] });
      return;
    }
    let cancelled = false;
    setLoadingRefs(true);
    const timer = setTimeout(() => {
      window.electronAPI
        .listRepoRefs(trimmed)
        .then((result) => {
          if (cancelled) return;
          setRefs({ branches: result.branches, tags: result.tags });
          if (result.defaultBase && (baseRef === 'HEAD~1' || baseRef === '')) {
            setBaseRef(result.defaultBase);
          }
          if (result.defaultHead && (headRef === 'HEAD' || headRef === '')) {
            setHeadRef(result.defaultHead);
          }
        })
        .catch(() => {
          if (!cancelled) setRefs({ branches: [], tags: [] });
        })
        .finally(() => {
          if (!cancelled) setLoadingRefs(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [repoPath]);

  // Preview the diff whenever all three inputs are populated — gives the user
  // early warning if the picked base produces a runaway file count (e.g. a
  // stale local main → huge merge-base gap).
  useEffect(() => {
    const rp = repoPath.trim();
    const br = baseRef.trim();
    const hr = headRef.trim();
    if (!rp || !br || !hr) {
      setPreview(null);
      return;
    }
    if (br === hr) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setLoadingPreview(true);
    const timer = setTimeout(() => {
      window.electronAPI
        .validateLocalRepo(rp, br, hr)
        .then((result) => {
          if (cancelled) return;
          if (result.ok) {
            setPreview({ changedFileCount: result.changedFileCount, mergeBase: result.mergeBase });
          } else {
            setPreview(null);
          }
        })
        .catch(() => {
          if (!cancelled) setPreview(null);
        })
        .finally(() => {
          if (!cancelled) setLoadingPreview(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [repoPath, baseRef, headRef]);

  const handleBrowse = useCallback(async () => {
    const dir = await window.electronAPI.pickRepoDir();
    if (dir) {
      setRepoPath(dir);
      setError(null);
    }
  }, []);

  const handleSubmit = useCallback(
    async (e: React.SyntheticEvent) => {
      e.preventDefault();
      const rp = repoPath.trim();
      const br = baseRef.trim();
      const hr = headRef.trim();
      if (!rp || !br || !hr) return;

      // Client-side short-circuit: identical refs. Saves a round trip and
      // surfaces the same message that main.ts would return anyway.
      if (br === hr) {
        setError({
          title: 'Base and head are the same.',
          hint: 'Pick two different commits to compare.',
        });
        return;
      }

      setValidating(true);
      setError(null);
      try {
        const result = await window.electronAPI.validateLocalRepo(rp, br, hr);
        if (!result.ok) {
          setError(explainValidationFailure(result, rp));
          return;
        }
        saveLastRepoPath(rp);
        try {
          localStorage.setItem(LAST_LOCAL_TOOLS_KEY, localTools ? '1' : '0');
        } catch {
          /* localStorage unavailable */
        }
        onSubmit(buildUrl(rp, br, hr), { localTools });
        onOpenChange(false);
      } finally {
        setValidating(false);
      }
    },
    [repoPath, baseRef, headRef, localTools, onSubmit, onOpenChange],
  );

  const inputClass =
    'w-full bg-transparent border-0 border-b border-border px-0 py-2 text-base placeholder:text-muted-foreground/60 focus:outline-none focus:border-[var(--ring)] transition-colors';

  const refOptions = [...refs.branches, ...refs.tags];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Review a local git diff</DialogTitle>
          <DialogDescription>
            Point Gnosis at a local git repository and two commit refs. Any ref works —
            a SHA, branch, tag, or <code>HEAD~n</code>.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5 pt-2">
          <div className="flex flex-col gap-1">
            <label className="slide-meta text-foreground/70" htmlFor="local-repo-path">
              Repository
            </label>
            <div className="flex items-center gap-3">
              <input
                id="local-repo-path"
                type="text"
                placeholder="/absolute/path/to/repo"
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                className={inputClass}
                aria-describedby="local-repo-status"
                required
                autoFocus
              />
              <button
                type="button"
                onClick={handleBrowse}
                className="slide-meta hover:text-foreground transition-colors flex items-center gap-1 pb-1"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                Browse
              </button>
            </div>
          </div>

          {/* Shared datalist — both inputs point at it so a single list of
              branches + tags drives autocomplete on both fields. */}
          <datalist id="local-ref-suggestions">
            {refOptions.map((ref) => (
              <option key={ref} value={ref} />
            ))}
          </datalist>

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1">
              <label className="slide-meta text-foreground/70" htmlFor="local-base-ref">
                Base
              </label>
              <input
                id="local-base-ref"
                type="text"
                list="local-ref-suggestions"
                placeholder="HEAD~1"
                value={baseRef}
                onChange={(e) => setBaseRef(e.target.value)}
                className={inputClass}
                required
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="slide-meta text-foreground/70" htmlFor="local-head-ref">
                Head
              </label>
              <input
                id="local-head-ref"
                type="text"
                list="local-ref-suggestions"
                placeholder="HEAD"
                value={headRef}
                onChange={(e) => setHeadRef(e.target.value)}
                className={inputClass}
                required
              />
            </div>
          </div>

          {/* Fixed-height status row — reserves space so loading → empty
              doesn't shift layout. Doubles as the error surface and diff
              preview. Errors take priority; otherwise show the file count
              so the user can catch a bad base before kicking off the review. */}
          <div
            id="local-repo-status"
            className="min-h-[2.5rem] slide-meta"
            aria-live="polite"
          >
            {error ? (
              <div className="text-destructive">
                <p className="text-sm font-medium">{error.title}</p>
                <p className="text-xs opacity-80 break-words mt-0.5">{error.hint}</p>
                {error.detail && (
                  <p className="text-[11px] font-mono opacity-60 break-words mt-1">{error.detail}</p>
                )}
              </div>
            ) : loadingRefs ? (
              <span className="text-muted-foreground">Reading branches…</span>
            ) : preview ? (
              <DiffPreview
                count={preview.changedFileCount}
                mergeBase={preview.mergeBase}
                loading={loadingPreview}
              />
            ) : loadingPreview ? (
              <span className="text-muted-foreground">Checking diff…</span>
            ) : null}
          </div>

          {/* Tool-mode opt-in. Off by default because running project-local
              scripts is a trust boundary — it executes code from whichever
              branch is checked out. */}
          <label
            htmlFor="local-tools"
            className="flex items-start gap-3 cursor-pointer select-none group"
          >
            <input
              id="local-tools"
              type="checkbox"
              checked={localTools}
              onChange={(e) => setLocalTools(e.target.checked)}
              className="mt-1 h-4 w-4 rounded border-border bg-transparent accent-[var(--ring)] cursor-pointer"
            />
            <div className="flex flex-col gap-0.5">
              <span className="text-sm text-foreground/90 group-hover:text-foreground transition-colors">
                Run project tools during review
              </span>
              <span className="slide-meta leading-relaxed">
                Lets Claude run tests, read the whole tree, and use the repo's own MCP
                servers and skills. Only enable for repos you trust.
              </span>
            </div>
          </label>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={validating} className="gap-2">
              {validating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Validating…
                </>
              ) : (
                'Begin review'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// File count above which the diff is almost certainly too big to be
// useful — typically a stale base or a long-lived feature branch that
// hasn't been rebased. Surfaced as a gentle warning, not a hard block.
const LARGE_DIFF_THRESHOLD = 500;

interface DiffPreviewProps {
  count: number;
  mergeBase: string | null;
  loading: boolean;
}

function DiffPreview({ count, mergeBase, loading }: DiffPreviewProps) {
  if (count === 0) {
    return (
      <span className="text-muted-foreground">
        No changed files in this range. Pick a different base or head.
      </span>
    );
  }
  const huge = count >= LARGE_DIFF_THRESHOLD;
  return (
    <div className={huge ? 'text-destructive' : 'text-muted-foreground'}>
      <p>
        {count.toLocaleString()} file{count === 1 ? '' : 's'} will be reviewed
        {mergeBase && (
          <>
            {' '}from merge-base <span className="font-mono">{mergeBase.slice(0, 7)}</span>
          </>
        )}
        {loading && '…'}
      </p>
      {huge && (
        <p className="text-xs opacity-80 mt-0.5">
          That's a lot — often means the base branch is stale. Try{' '}
          <code>git fetch</code> and pick <code>origin/main</code>, or choose a more
          recent base.
        </p>
      )}
    </div>
  );
}

// Map main-process validation failures onto user-facing copy. The main
// process classifies the failure; this is just the humanizer.
function explainValidationFailure(
  result: Exclude<Awaited<ReturnType<typeof window.electronAPI.validateLocalRepo>>, { ok: true }>,
  repoPath: string,
): { title: string; hint: string; detail?: string } {
  switch (result.reason) {
    case 'not-a-repo':
      return {
        title: `Not a git repository`,
        hint: `${repoPath} doesn't contain a .git directory. Pick a different folder, or run "git init" there first.`,
      };
    case 'unknown-ref':
      return {
        title: `Couldn't find "${result.ref ?? '?'}"`,
        hint: `Any branch, tag, SHA, or HEAD~n works. Check spelling and try again.`,
      };
    case 'same-refs':
      return {
        title: 'Base and head are the same.',
        hint: 'Pick two different commits to compare.',
      };
    case 'other':
    default:
      return {
        title: "Couldn't open that repo",
        hint: 'Something went wrong resolving the commits. The raw git message is below.',
        detail: result.message,
      };
  }
}
