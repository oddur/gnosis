import { commandRecents as recentIds, rememberCommandDestination as remember } from '../lib/command-recents';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  ChevronRight,
  Command as CommandIcon,
  FileCode2,
  GitBranch,
  GitPullRequest,
  Loader2,
  Search,
  Settings2,
  Sparkles,
  MessageSquare,
  ExternalLink,
  Clock,
} from 'lucide-react';
import { Command, CommandInput, CommandList, CommandGroup, CommandItem } from './ui/command';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog';
import { Button } from './ui/button';
import type { AppCommand } from '../lib/command-center';
import type { SearchDestination, SearchDocument, SearchHit } from '../lib/command-search';
import type { LocalSearchResponse } from '../src/command-search-service';
import type { PrSearchResult } from '../lib/types';

const icons = {
  pr: GitPullRequest,
  stack: GitBranch,
  briefing: Sparkles,
  topic: Sparkles,
  file: FileCode2,
  insight: Sparkles,
  comment: MessageSquare,
  explainer: Sparkles,
  view: Settings2,
  repository: GitBranch,
};
function Highlight({ text, query }: { text: string; query: string }) {
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!tokens.length) return <>{text}</>;
  const expression = new RegExp(`(${tokens.join('|')})`, 'ig');
  return <>{text.split(expression).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}</>;
}
export function GlobalCommandPalette({
  open,
  onClose,
  commands,
  navigate,
}: {
  open: boolean;
  onClose: () => void;
  commands: AppCommand[];
  navigate: (destination: SearchDestination) => Promise<void>;
}) {
  const [query, setQuery] = useState(''),
    [value, setValue] = useState(''),
    [result, setResult] = useState<LocalSearchResponse | null>(null);
  const [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [localSearchFailed, setLocalSearchFailed] = useState(false);
  const [includeBots, setIncludeBots] = useState(false),
    [expanded, setExpanded] = useState(new Set<string>());
  const [remote, setRemote] = useState<PrSearchResult[] | null>(null),
    [remotePending, setRemotePending] = useState(false);
  const selectionTouched = useRef(false);
  const actionPending = useRef(false);
  const remoteInFlight = useRef(false);
  const sequence = useRef(0),
    remoteSequence = useRef(0),
    account = useRef('local'),
    opener = useRef<HTMLElement | null>(null),
    input = useRef<HTMLInputElement>(null);
  const commandOnly = query.trimStart().startsWith('>'),
    term = commandOnly ? query.trimStart().slice(1).trim() : query.trim();
  useEffect(() => {
    if (open) {
      opener.current = document.activeElement as HTMLElement;
      requestAnimationFrame(() => input.current?.focus());
      selectionTouched.current = false;
      setQuery('');
      setError('');
      setRemote(null);
      setValue('');
      setExpanded(new Set());
      setIncludeBots(false);
    }
    return () => {
      remoteSequence.current++;
    };
  }, [open]);
  useEffect(() => {
    remoteSequence.current++;
    remoteInFlight.current = false;
    setRemote(null);
    setRemotePending(false);
  }, [open, term, commandOnly]);
  useEffect(() => {
    if (!open) return;
    const id = ++sequence.current;
    setError('');
    setLocalSearchFailed(false);
    if (commandOnly) {
      setPending(false);
      return;
    }
    setPending(true);
    const timer = setTimeout(
      () => {
        void window.electronAPI
          .commandSearch(term, includeBots, recentIds(account.current))
          .then(async (data) => {
            if (id !== sequence.current) return;
            if (account.current !== data.account) {
              account.current = data.account;
              setIncludeBots(false);
              if (!term && recentIds(data.account).length)
                data = await window.electronAPI.commandSearch('', includeBots, recentIds(data.account));
            }
            if (id !== sequence.current) return;
            setResult(data);
            setPending(false);
          })
          .catch((e: unknown) => {
            if (id === sequence.current) {
              setError(e instanceof Error ? e.message : String(e));
              setPending(false);
              setResult(null);
              setLocalSearchFailed(true);
            }
          });
      },
      term ? 70 : 0
    );
    return () => {
      clearTimeout(timer);
      sequence.current++;
    };
  }, [open, term, commandOnly, includeBots, searchAttempt]);
  const filteredCommands = useMemo(
    () =>
      commands
        .filter(
          (c) =>
            !term ||
            term
              .toLowerCase()
              .split(/\s+/)
              .every((t) => `${c.label} ${c.keywords ?? ''}`.toLowerCase().includes(t))
        )
        .slice(0, commandOnly || term ? 30 : 6),
    [commands, term, commandOnly]
  );
  const groups = useMemo(() => {
    const groups = new Map<string, SearchHit[]>();
    for (const hit of !commandOnly && !pending ? (result?.hits ?? []) : []) {
      const group = groups.get(hit.document.groupId) ?? [];
      group.push(hit);
      groups.set(hit.document.groupId, group);
    }
    return [...groups.entries()].slice(0, term ? 120 : 4);
  }, [result, pending, commandOnly, term]);
  const visible = groups.flatMap(([id, hits]) => (expanded.has(id) ? hits : hits.slice(0, 1)));
  const selected =
      visible.find((h) => h.document.id === value) ??
      (value.startsWith('expand:') ? groups.find(([id]) => `expand:${id}` === value)?.[1][0] : undefined),
    selectedCommand = filteredCommands.find((c) => c.id === value);
  const remoteRows = remote?.filter(
    (r) => includeBots || !result?.ignoreBots || !r.author.toLowerCase().startsWith('dependabot')
  );
  const selectedRemote = remoteRows?.find((r) => `remote:${r.url}` === value);
  useEffect(() => {
    const ids = [
      ...visible.map((h) => h.document.id),
      ...groups.filter(([, hits]) => hits.length > 1).map(([id]) => `expand:${id}`),
      ...filteredCommands.map((c) => c.id),
      ...(remoteRows ?? []).map((r) => `remote:${r.url}`),
    ];
    if (!selectionTouched.current || !ids.includes(value)) setValue(ids[0] ?? '');
  }, [visible.map((h) => h.document.id).join('|'), filteredCommands, remote, value]);
  async function run(action: () => void | Promise<void>, doc?: SearchDocument) {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
      if (doc) remember(account.current, doc.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  }
  async function searchGitHub() {
    if (remoteInFlight.current) return;
    remoteInFlight.current = true;
    const id = ++remoteSequence.current;
    setRemotePending(true);
    setError('');
    try {
      const rows = await window.electronAPI.commandGitHubSearch(term);
      if (id === remoteSequence.current) setRemote(rows);
    } catch (e) {
      if (id === remoteSequence.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === remoteSequence.current) {
        remoteInFlight.current = false;
        setRemotePending(false);
      }
    }
  }
  const isPrUrl = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#].*)?$/.test(term);
  const openSelected = () =>
    selected
      ? void run(() => navigate(selected.document.destination), selected.document)
      : selectedCommand
        ? void run(selectedCommand.perform)
        : selectedRemote
          ? void run(() => navigate({ kind: 'home', url: selectedRemote.url }))
          : undefined;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent
        className="global-command-dialog command-palette"
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          input.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (
            !document.querySelector('[role=dialog][data-state=open]') &&
            opener.current?.isConnected &&
            !opener.current.closest('[hidden]')
          )
            opener.current.focus();
        }}
      >
        <DialogTitle className="sr-only">Search and navigate Gnosis</DialogTitle>
        <DialogDescription className="sr-only">
          Search local PRs, stacks, code, and explanations. Use arrows to choose and Enter to open. Type greater-than
          for commands.
        </DialogDescription>
        <Command
          shouldFilter={false}
          value={value}
          onValueChange={setValue}
          loop
          className="global-command"
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) selectionTouched.current = true;
            if (event.key === 'ArrowRight' && selectionTouched.current && selected) {
              const g = selected.document.groupId;
              if ((groups.find(([id]) => id === g)?.[1].length ?? 0) > 1) {
                event.preventDefault();
                setExpanded((prev) => new Set([...prev, g]));
              }
            }
          }}
        >
          <div className="global-command-search">
            <CommandInput
              ref={input}
              value={query}
              onValueChange={(next) => {
                selectionTouched.current = false;
                setQuery(next);
                setValue('');
                setExpanded(new Set());
              }}
              placeholder="Search PRs, code, explanations…"
              aria-label="Search Gnosis"
              maxLength={1000}
            />
            <kbd className="kbd">Esc</kbd>
          </div>
          <div className="global-command-scope">
            <span className="sr-only" role="status">
              {commandOnly
                ? `${filteredCommands.length} commands`
                : pending
                  ? 'Searching local content'
                  : term
                    ? `${result?.total ?? 0} local matches`
                    : 'Recent destinations and commands'}
            </span>
            <span>
              <Search size={13} />
              {commandOnly ? 'Commands' : remote ? 'Local + GitHub results' : 'All local content'}
              {term &&
                !pending &&
                !commandOnly &&
                result &&
                ` · ${result.total} matches${result.total > 120 ? ' · best 120 shown' : ''}`}
              {pending && <Loader2 size={13} className="animate-spin" />}
            </span>
            {!commandOnly && result?.ignoreBots && (
              <label>
                <input type="checkbox" checked={includeBots} onChange={(e) => setIncludeBots(e.target.checked)} />
                Include Dependabot
              </label>
            )}
            {!query && (
              <span className="global-command-tip">
                Type <kbd>&gt;</kbd> for commands
              </span>
            )}
          </div>
          <div className="global-command-body">
            <CommandList
              className="global-command-results"
              label="Search results"
              onPointerMove={() => {
                selectionTouched.current = true;
              }}
              aria-busy={pending || busy}
            >
              {groups.length > 0 && (
                <CommandGroup heading={term ? 'Matching work' : 'Recent & available work'}>
                  {groups.map(([groupId, hits]) => (
                    <div key={groupId} className="global-command-result-group">
                      {(expanded.has(groupId) ? hits : hits.slice(0, 1)).map(({ document: doc, snippet }) => {
                        const Icon = icons[doc.kind];
                        return (
                          <CommandItem
                            key={doc.id}
                            value={doc.id}
                            disabled={busy}
                            onSelect={() => void run(() => navigate(doc.destination), doc)}
                          >
                            <Icon size={17} />
                            <span className="global-command-result-copy">
                              <strong>
                                <Highlight text={doc.title} query={term} />
                              </strong>
                              <span>
                                {doc.kind !== 'pr' && doc.kind !== 'stack' ? `${doc.groupTitle} · ` : ''}
                                {doc.source}
                              </span>
                              {term && snippet && (
                                <small>
                                  <Highlight text={snippet.slice(0, 120)} query={term} />
                                </small>
                              )}
                            </span>
                            <span className="global-command-kind">{doc.kind === 'pr' ? doc.state : doc.kind}</span>
                          </CommandItem>
                        );
                      })}
                      {hits.length > 1 && (
                        <CommandItem
                          value={`expand:${groupId}`}
                          disabled={busy}
                          onSelect={() =>
                            setExpanded((prev) => {
                              const next = new Set(prev);
                              if (next.has(groupId)) next.delete(groupId);
                              else next.add(groupId);
                              return next;
                            })
                          }
                          className="global-command-more"
                        >
                          <ChevronRight size={13} />
                          {expanded.has(groupId)
                            ? 'Show fewer'
                            : `${hits.length - 1} more ${hits.length === 2 ? 'match' : 'matches'} in ${hits[0].document.groupTitle}`}
                        </CommandItem>
                      )}
                    </div>
                  ))}
                </CommandGroup>
              )}
              {pending && !commandOnly && (
                <CommandItem disabled value="loading" className="global-command-empty">
                  <Loader2 size={18} className="animate-spin" />
                  <p>Searching this computer…</p>
                </CommandItem>
              )}
              {!pending && !groups.length && !filteredCommands.length && !remote?.length && (
                <CommandItem disabled value="no-results" className="global-command-empty">
                  <Search size={22} />
                  <strong>{term ? 'No local matches' : 'Your work will appear here'}</strong>
                  <p>
                    {term
                      ? 'Try a PR number, filename, author, or a few words from the change.'
                      : 'Open a PR or save a review to make it searchable.'}
                  </p>
                </CommandItem>
              )}
              {filteredCommands.length > 0 && (
                <CommandGroup heading={commandOnly ? 'Commands' : term ? 'Actions & navigation' : 'Useful here'}>
                  {filteredCommands.map((command) => (
                    <CommandItem
                      key={command.id}
                      value={command.id}
                      disabled={busy}
                      onSelect={() => void run(command.perform)}
                    >
                      <CommandIcon size={16} />
                      <span className="global-command-result-copy">
                        <strong>{command.label}</strong>
                      </span>
                      {command.hint && <kbd className="kbd">{command.hint}</kbd>}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {remote && (
                <CommandGroup heading="From GitHub">
                  {remoteRows?.map((row) => (
                    <CommandItem
                      key={row.url}
                      value={`remote:${row.url}`}
                      disabled={busy}
                      onSelect={() => void run(() => navigate({ kind: 'home', url: row.url }))}
                    >
                      <GitPullRequest size={16} />
                      <span className="global-command-result-copy">
                        <strong>{row.title}</strong>
                        <span>
                          {row.repoOwner}/{row.repoName} #{row.number} · {row.author}
                        </span>
                      </span>
                    </CommandItem>
                  ))}
                  {!remoteRows?.length && (
                    <p className="global-command-empty">
                      {remote.length
                        ? 'Matching Dependabot PRs are hidden. Select “Include Dependabot” to show them.'
                        : 'No matching PRs on GitHub.'}
                    </p>
                  )}
                </CommandGroup>
              )}
            </CommandList>
            <aside className="global-command-preview" aria-label="Result preview">
              {selected ? (
                <>
                  <div className="global-command-preview-meta">
                    <span>{selected.document.kind}</span>
                    <span>{selected.document.state}</span>
                  </div>
                  <h2>{selected.document.title}</h2>
                  <p className="global-command-source">{selected.document.source}</p>
                  <div className="global-command-match" tabIndex={0}>
                    {selected.codeSnippet ? (
                      <>
                        {selected.proseSnippet && (
                          <p>
                            <Highlight text={selected.proseSnippet} query={term} />
                          </p>
                        )}
                        <pre className="global-command-code">
                          <code>
                            <Highlight text={selected.codeSnippet} query={term} />
                          </code>
                        </pre>
                      </>
                    ) : (
                      <Highlight text={selected.snippet || selected.document.groupTitle} query={term} />
                    )}
                  </div>
                  <div className="global-command-preview-actions">
                    <Button size="sm" disabled={busy} onClick={openSelected}>
                      Open{' '}
                      {selected.document.destination.kind === 'home' || ['pr', 'stack'].includes(selected.document.kind)
                        ? 'summary'
                        : 'match'}
                      <ArrowRight size={14} />
                    </Button>
                    {selected.document.reviewId && ['pr', 'stack', 'briefing'].includes(selected.document.kind) && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => navigate({ kind: 'review', reviewId: selected.document.reviewId as string }),
                            selected.document
                          )
                        }
                      >
                        Resume review
                      </Button>
                    )}
                  </div>
                </>
              ) : selectedCommand ? (
                <>
                  <CommandIcon size={22} />
                  <h2>{selectedCommand.label}</h2>
                  <p className="global-command-match" tabIndex={0}>
                    {selectedCommand.group ?? 'Navigate Gnosis'}
                    {selectedCommand.hint ? ` · ${selectedCommand.hint}` : ''}
                  </p>
                  <Button size="sm" disabled={busy} onClick={openSelected}>
                    Run action
                    <ArrowRight size={14} />
                  </Button>
                </>
              ) : selectedRemote ? (
                <>
                  <GitPullRequest size={22} />
                  <h2>{selectedRemote.title}</h2>
                  <p>
                    {selectedRemote.repoOwner}/{selectedRemote.repoName} #{selectedRemote.number}
                  </p>
                  <Button size="sm" disabled={busy} onClick={openSelected}>
                    Open PR overview
                  </Button>
                </>
              ) : (
                <>
                  <Clock size={24} />
                  <h2>Your next destination</h2>
                  <p className="global-command-match" tabIndex={0}>
                    Find a change, understand a match, or pick up where you left off.
                  </p>
                </>
              )}
            </aside>
          </div>
          {error && (
            <div className="global-command-error" role="alert">
              <span>{error}</span>
              {localSearchFailed && (
                <button
                  type="button"
                  className="ml-3 underline underline-offset-2"
                  onClick={() => setSearchAttempt((n) => n + 1)}
                >
                  Retry local search
                </button>
              )}
            </div>
          )}
          {!!result?.warnings.length && (
            <details className="global-command-warning">
              <summary>
                {result.warnings.length} saved {result.warnings.length === 1 ? 'review could' : 'reviews could'} not be
                indexed
              </summary>
              {result.warnings.map((w) => (
                <p key={w}>{w}</p>
              ))}
            </details>
          )}
          <div className="global-command-footer">
            <span>
              {busy && <Loader2 size={13} className="animate-spin" />}
              <kbd>↑ ↓</kbd> choose <kbd>↵</kbd> open
            </span>
            {term && !commandOnly && (
              <Button
                size="sm"
                variant="ghost"
                disabled={remotePending || busy}
                onClick={() => (isPrUrl ? void run(() => navigate({ kind: 'home', url: term })) : void searchGitHub())}
              >
                {remotePending ? <Loader2 size={13} className="animate-spin" /> : <ExternalLink size={13} />}{' '}
                {isPrUrl ? 'Open PR URL' : 'Search GitHub…'}
              </Button>
            )}
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
