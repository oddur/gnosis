import { useState, useEffect, useMemo } from 'react';
import { Search } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { timeAgo } from '@/lib/utils';
import type { PrSearchResult } from '@/lib/types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (url: string) => void;
}

export function PRPickerDialog({ open, onOpenChange, onSelect }: Props) {
  const [prs, setPrs] = useState<PrSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState<'author' | 'review-requested' | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setFilter('');
    setRepoFilter(null);
    setRoleFilter(null);
    window.electronAPI
      .searchPullRequests()
      .then(setPrs)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load pull requests');
      })
      .finally(() => setLoading(false));
  }, [open]);

  const repos = useMemo(() => {
    const set = new Set<string>();
    for (const pr of prs) set.add(`${pr.repoOwner}/${pr.repoName}`);
    return Array.from(set).sort();
  }, [prs]);

  const filtered = useMemo(() => {
    let list = prs;
    if (roleFilter) {
      list = list.filter((pr) => pr.role === roleFilter);
    }
    if (repoFilter) {
      list = list.filter((pr) => `${pr.repoOwner}/${pr.repoName}` === repoFilter);
    }
    if (filter) {
      const q = filter.toLowerCase();
      list = list.filter(
        (pr) =>
          pr.title.toLowerCase().includes(q) ||
          pr.repoName.toLowerCase().includes(q) ||
          pr.repoOwner.toLowerCase().includes(q) ||
          `${pr.repoOwner}/${pr.repoName}`.toLowerCase().includes(q)
      );
    }
    return list;
  }, [prs, filter, repoFilter, roleFilter]);

  function handleSelect(url: string) {
    onSelect(url);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card sm:max-w-2xl max-h-[80vh] flex flex-col gap-5">
        <DialogHeader>
          <DialogTitle className="editorial-heading">Pull requests</DialogTitle>
          <DialogDescription className="slide-meta">Your open PRs and review requests</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="relative">
            <Search className="absolute left-0 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/60" />
            <input
              type="text"
              placeholder="Filter by title…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="w-full bg-transparent border-0 border-b border-border pl-6 pr-1 py-2 text-sm placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:border-[var(--ring)] transition-colors"
            />
          </div>

          {/* Quiet text-only filter row — same vocabulary as the
              DiffLayoutToggle in SlideView. Active state is a hairline
              underline in the brand amber, no fills, no borders. */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 slide-meta">
            {(
              [
                { value: null, label: 'All' },
                { value: 'review-requested', label: 'Assigned to me' },
                { value: 'author', label: 'By me' },
              ] as const
            ).map(({ value, label }) => (
              <button
                key={label}
                type="button"
                onClick={() => setRoleFilter(roleFilter === value ? null : value)}
                className={`pb-0.5 border-b transition-colors ${
                  roleFilter === value
                    ? 'text-foreground border-[var(--ring)]'
                    : 'border-transparent hover:text-foreground'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {repos.length > 1 && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 slide-meta">
              <button
                type="button"
                onClick={() => setRepoFilter(null)}
                className={`pb-0.5 border-b transition-colors ${
                  repoFilter === null
                    ? 'text-foreground border-[var(--ring)]'
                    : 'border-transparent hover:text-foreground'
                }`}
              >
                All repos
              </button>
              {repos.map((repo) => (
                <button
                  key={repo}
                  type="button"
                  onClick={() => setRepoFilter(repoFilter === repo ? null : repo)}
                  className={`pb-0.5 border-b transition-colors ${
                    repoFilter === repo
                      ? 'text-foreground border-[var(--ring)]'
                      : 'border-transparent hover:text-foreground'
                  }`}
                >
                  {repo}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="overflow-y-auto -mx-6 min-h-0 max-h-[50vh]">
          {loading && (
            <div className="flex flex-col gap-3 px-6 py-2">
              <Skeleton className="h-14 w-full rounded-sm" />
              <Skeleton className="h-14 w-full rounded-sm" />
              <Skeleton className="h-14 w-full rounded-sm" />
            </div>
          )}

          {error && <p className="text-sm text-destructive py-4 text-center">{error}</p>}

          {!loading && !error && filtered.length === 0 && (
            <div className="px-6 py-8 flex flex-col gap-2 max-w-sm">
              {prs.length === 0 ? (
                <>
                  <p className="editorial-label text-sm">Nothing to review yet.</p>
                  <p className="slide-meta">
                    Once you open a PR or get added as a reviewer on GitHub, it'll show up here. You can also paste a
                    PR URL directly into the box on the home screen.
                  </p>
                </>
              ) : (
                <>
                  <p className="editorial-label text-sm">No matches.</p>
                  <p className="slide-meta">Try a different filter, or clear the search to see everything.</p>
                </>
              )}
            </div>
          )}

          {!loading && !error && filtered.length > 0 && (
            <ul>
              {filtered.map((pr) => (
                <li key={pr.url}>
                  <button
                    type="button"
                    onClick={() => handleSelect(pr.url)}
                    className="group w-full flex flex-col gap-1 px-6 py-3.5 text-left border-b border-border/60 last:border-b-0 hover:bg-muted/40 transition-colors"
                  >
                    <div className="flex items-center gap-2 min-w-0 slide-meta">
                      <span className="shrink-0">
                        {pr.repoOwner}/{pr.repoName}#{pr.number}
                      </span>
                      {pr.isDraft && <span className="statusPill-neutral text-[10px] px-1.5 py-0">Draft</span>}
                      {pr.role === 'review-requested' && (
                        <span className="statusPill-amber text-[10px] px-1.5 py-0">Review requested</span>
                      )}
                    </div>
                    <span className="font-serif text-base leading-snug text-foreground/85 group-hover:text-foreground transition-colors truncate">
                      {pr.title}
                    </span>
                    <span className="slide-meta">
                      {pr.author} · {timeAgo(pr.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
