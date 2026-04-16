import { useState, useRef, useCallback } from 'react';
import { X, Search, Eye } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { RepoSearchResult } from '../lib/types';

interface Props {
  open: boolean;
  onComplete: (repos: string[]) => void;
  onSkip: () => void;
}

export function OnboardingRepoSetup({ open, onComplete, onSkip }: Props) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<RepoSearchResult[]>([]);
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const search = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(() => {
      void window.electronAPI.searchRepos(q.trim()).then((results) => {
        setSuggestions(results.filter((r) => !selectedRepos.includes(r.fullName)));
        setLoading(false);
      });
    }, 300);
  }, [selectedRepos]);

  function addRepo(fullName: string) {
    setSelectedRepos((prev) => prev.includes(fullName) ? prev : [...prev, fullName]);
    setQuery('');
    setSuggestions([]);
    inputRef.current?.focus();
  }

  function removeRepo(fullName: string) {
    setSelectedRepos((prev) => prev.filter((r) => r !== fullName));
  }

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        className="bg-card sm:max-w-md"
        showCloseButton={false}
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Watch repos for automatic reviews</DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          Gnosis can automatically review every open PR in repos you pick. You'll get reviews without pasting a single URL.
        </p>

        {/* Search input */}
        <div className="relative">
          <div className="flex items-center gap-2 border-b border-border">
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              placeholder="Search for a repo..."
              onChange={(e) => {
                setQuery(e.target.value);
                search(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && query.includes('/')) {
                  e.preventDefault();
                  addRepo(query.trim());
                }
              }}
              className="flex-1 bg-transparent border-0 px-0 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 outline-none"
              autoFocus
            />
          </div>

          {/* Suggestions dropdown */}
          {suggestions.length > 0 && (
            <ul className="absolute z-50 top-full left-0 right-0 mt-1 bg-popover border border-border rounded-md shadow-md max-h-48 overflow-y-auto">
              {suggestions.map((repo) => (
                <li key={repo.fullName}>
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors flex flex-col gap-0.5"
                    onMouseDown={(e) => { e.preventDefault(); addRepo(repo.fullName); }}
                  >
                    <span className="font-mono text-xs text-foreground">{repo.fullName}</span>
                    {repo.description && (
                      <span className="text-xs text-muted-foreground truncate">{repo.description}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {loading && query.length >= 2 && suggestions.length === 0 && (
            <p className="text-xs text-muted-foreground mt-2">Searching...</p>
          )}
        </div>

        {/* Selected repos */}
        {selectedRepos.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-1">
            {selectedRepos.map((repo) => (
              <span
                key={repo}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs font-mono bg-accent rounded-md text-foreground"
              >
                <Eye className="h-3 w-3 text-muted-foreground" />
                {repo}
                <button
                  type="button"
                  onClick={() => removeRepo(repo)}
                  className="ml-0.5 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 justify-end pt-2">
          <Button variant="outline" onClick={onSkip}>
            Skip for now
          </Button>
          <Button
            onClick={() => onComplete(selectedRepos)}
            disabled={selectedRepos.length === 0}
          >
            {selectedRepos.length > 0
              ? `Watch ${selectedRepos.length} repo${selectedRepos.length > 1 ? 's' : ''}`
              : 'Select repos to watch'}
          </Button>
        </div>

        <p className="text-xs text-muted-foreground text-center">
          You can change this anytime in Settings.
        </p>
      </DialogContent>
    </Dialog>
  );
}
