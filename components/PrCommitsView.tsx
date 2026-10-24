import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Copy, ExternalLink, RefreshCw } from 'lucide-react';
import { PrChangesView } from './PrChangesView';
import { GitHubAuthor } from './GitHubAuthor';
import { Button } from './ui/button';
import {
  commitSelectionKey,
  ownedCommits,
  selectedCommits,
  type CommitSelection,
  type PrCommit,
  type PrCommits,
} from '../lib/pr-commits';
import type { PrChanges } from '../lib/pr-changes';
import type { Preferences } from '../lib/types';
import type { ReviewSubject } from '../lib/workbench';
import { timeAgo } from '../lib/utils';

interface Position {
  selection?: CommitSelection;
  scroll?: number;
}
const catalogs = new Map<string, PrCommits[]>();
const comparisons = new Map<string, PrChanges>();
function restore(id: string): Position {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`gnosis-commits:${id}`) ?? '{}');
    return value && typeof value === 'object' ? (value as Position) : {};
  } catch {
    return {};
  }
}
const authorName = (commit: PrCommit) => commit.author.login || commit.author.name;
const short = (sha: string) => sha.slice(0, 7);
export function PrCommitsView({
  subject,
  preferences,
  onOpenCurrentFile,
}: {
  subject: ReviewSubject;
  preferences: Preferences;
  onOpenCurrentFile: (url: string, path: string) => void;
}) {
  const [position] = useState(() => restore(subject.id));
  const [lists, setLists] = useState(() => catalogs.get(subject.id) ?? []);
  const [selection, setSelection] = useState(position.selection);
  const [commitsOpen, setCommitsOpen] = useState(true),
    [filesOpen, setFilesOpen] = useState(true);
  const [rangeMode, setRangeMode] = useState(false);
  const anchor = useRef<{ url: string; sha: string } | undefined>(undefined);
  const [loading, setLoading] = useState(false),
    [listError, setListError] = useState(''),
    [newer, setNewer] = useState(false);
  const [resolved, setResolved] = useState<{ key: string; snapshot: PrChanges }>();
  const [comparisonError, setComparisonError] = useState(''),
    [attempt, setAttempt] = useState(0);
  const [copyStatus, setCopyStatus] = useState('');
  const epoch = useRef(0);
  const persist = () => {
    try {
      localStorage.setItem(
        `gnosis-commits:${subject.id}`,
        JSON.stringify({ selection: position.selection, scroll: position.scroll })
      );
    } catch {
      /* Optional navigation memory. */
    }
  };
  const groups = useMemo(() => ownedCommits(subject, lists), [subject, lists]);
  const activeList = lists.find((list) => list.url === selection?.url);
  let chosen: PrCommit[] = [];
  try {
    if (selection && activeList) chosen = selectedCommits(activeList, selection);
  } catch {
    /* A removed commit is replaced after explicit refresh. */
  }
  const key = selection && chosen.length ? commitSelectionKey(selection) : '';
  const snapshot = comparisons.get(key) ?? (resolved?.key === key ? resolved.snapshot : undefined);
  const first = chosen.at(0),
    last = chosen.at(-1);
  function choose(list: PrCommits, commit: PrCommit, extend = false) {
    const start = extend && anchor.current?.url === list.url ? anchor.current.sha : commit.sha;
    const a = list.commits.findIndex((c) => c.sha === start),
      b = list.commits.findIndex((c) => c.sha === commit.sha);
    setSelection({
      url: list.url,
      prBaseSha: list.metadata.baseSha,
      prHeadSha: list.metadata.headSha,
      firstSha: list.commits[Math.min(a < 0 ? b : a, b)].sha,
      lastSha: list.commits[Math.max(a, b)].sha,
    });
    if (!extend || anchor.current?.url !== list.url) anchor.current = { url: list.url, sha: commit.sha };
    setCopyStatus('');
  }
  async function load(refresh: boolean) {
    const current = ++epoch.current;
    setLoading(true);
    setListError('');
    try {
      const next: PrCommits[] = [];
      for (const member of subject.members) next.push(await window.electronAPI.getPrCommits(member.url, refresh));
      if (epoch.current !== current) return;
      catalogs.set(subject.id, next);
      setLists(next);
      setNewer(false);
      const previous = selection && next.find((list) => list.url === selection.url);
      if (
        selection &&
        previous &&
        previous.commits.some((c) => c.sha === selection.firstSha) &&
        previous.commits.some((c) => c.sha === selection.lastSha)
      ) {
        setSelection({ ...selection, prBaseSha: previous.metadata.baseSha, prHeadSha: previous.metadata.headSha });
      } else {
        const group = ownedCommits(subject, next).find((g) => g.commits.length);
        const latest = group?.commits.at(-1);
        if (group?.list && latest) choose(group.list, latest);
        else setSelection(undefined);
      }
    } catch (e) {
      if (epoch.current === current) setListError(e instanceof Error ? e.message : String(e));
    } finally {
      if (epoch.current === current) setLoading(false);
    }
  }
  useEffect(() => {
    void load(false);
    return () => {
      epoch.current++;
    };
  }, [subject.id]);
  useEffect(() => {
    position.selection = selection;
    persist();
  }, [selection]);
  // The shared GitHub scheduler/cache handles these revision checks; it never swaps an open diff.
  useEffect(() => {
    if (!lists.length) return;
    let cancelled = false;
    const check = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        for (const list of lists) {
          const current = await window.electronAPI.checkPrChanges(list.url);
          if (!cancelled && (current.headSha !== list.metadata.headSha || current.baseSha !== list.metadata.baseSha))
            setNewer(true);
        }
      } catch {
        /* Explicit Update commits reports errors without interrupting a cached comparison. */
      }
    };
    void check();
    const timer = setInterval(() => void check(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [lists]);
  useEffect(() => {
    setComparisonError('');
    if (!key || !selection || comparisons.has(key)) return;
    let cancelled = false;
    void window.electronAPI
      .getCommitComparison(selection)
      .then((value) => {
        comparisons.set(key, value);
        while (comparisons.size > 100) {
          const oldestKey = comparisons.keys().next().value;
          if (oldestKey === undefined) break;
          comparisons.delete(oldestKey);
        }
        if (!cancelled) setResolved({ key, snapshot: value });
      })
      .catch((e: unknown) => {
        if (!cancelled) setComparisonError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [key, attempt]);
  const sidebar = (
    <>
      <button className="commit-section-toggle" onClick={() => setCommitsOpen((v) => !v)} aria-expanded={commitsOpen}>
        {commitsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Commits{' '}
        <span>{groups.reduce((n, g) => n + g.commits.length, 0)}</span>
      </button>
      {commitsOpen && (
        <div className="commit-browser">
          <div className="commit-range-controls">
            <label>
              <input
                type="checkbox"
                checked={rangeMode}
                onChange={(e) => {
                  setRangeMode(e.target.checked);
                  anchor.current = undefined;
                }}
              />{' '}
              Compare a range
            </label>
            {rangeMode && <p>Choose the first and last commits in one PR. All commits between them are included.</p>}
          </div>
          <div
            className="commit-list"
            ref={(node) => {
              if (node) node.scrollTop = position.scroll ?? 0;
            }}
            onScroll={(e) => {
              position.scroll = e.currentTarget.scrollTop;
              persist();
            }}
            aria-label="Commits"
          >
            {groups.map((group) => (
              <section key={group.member.url}>
                {subject.kind === 'stack' && (
                  <h2 title={group.member.title}>
                    #{group.member.number} · {group.member.title}
                  </h2>
                )}
                {group.omitted > 0 && <p className="commit-inherited">{group.omitted} shared with earlier PRs</p>}
                {[...group.commits].reverse().map((commit) => (
                  <button
                    key={commit.sha}
                    className="commit-row"
                    aria-pressed={selection?.url === group.member.url && chosen.some((c) => c.sha === commit.sha)}
                    onClick={(e) =>
                      group.list && choose(group.list, commit, e.shiftKey || (rangeMode && !!anchor.current))
                    }
                  >
                    <span className="commit-row-title">{commit.message.split('\n')[0]}</span>
                    <span className="commit-row-meta">
                      <span>{authorName(commit)}</span>
                      <code>{short(commit.sha)}</code>
                      <time title={commit.committedAt}>{commit.committedAt ? timeAgo(commit.committedAt) : ''}</time>
                    </span>
                  </button>
                ))}
              </section>
            ))}
            {!groups.some((g) => g.commits.length) && (
              <p className="commit-inherited">{loading ? 'Loading commits…' : 'No commits in this PR.'}</p>
            )}
          </div>
        </div>
      )}
    </>
  );
  const header = first && last && (
    <div className="commit-detail" key={key}>
      <div className="commit-detail-title">
        <strong>
          {chosen.length > 1
            ? `${chosen.length} commits · ${short(first.sha)} → ${short(last.sha)}`
            : first.message.split('\n')[0]}
        </strong>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Copy commit SHA"
          onClick={() => {
            void navigator.clipboard.writeText(last.sha).then(
              () => setCopyStatus('SHA copied'),
              () => setCopyStatus('Could not copy SHA')
            );
          }}
        >
          <Copy size={14} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Open comparison on GitHub"
          onClick={() => {
            void window.electronAPI.openExternal(
              chosen.length === 1 && (!selection?.parentSha || selection.parentSha === first.parents[0])
                ? last.url
                : `https://github.com/${activeList?.metadata.baseRepo}/compare/${selection?.parentSha ?? first.parents[0]}...${last.sha}`
            );
          }}
        >
          <ExternalLink size={14} />
        </Button>
      </div>
      <div className="commit-baseline">
        <span>
          {activeList?.metadata.baseRepo} #{selection?.url.split('/').pop()}
        </span>
        {first.parents.length > 1 ? (
          <label>
            Compare with{' '}
            <select
              aria-label="Compare with parent"
              value={selection?.parentSha ?? first.parents[0]}
              onChange={(e) => {
                if (selection) setSelection({ ...selection, parentSha: e.target.value });
              }}
            >
              {first.parents.map((sha, i) => (
                <option key={sha} value={sha}>
                  Parent {i + 1} · {short(sha)}
                  {i === 0 ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span>
            {first.parents.length ? (
              <>
                Parent <code>{short(first.parents[0])}</code>
              </>
            ) : (
              'Initial commit'
            )}{' '}
            → <code>{short(last.sha)}</code>
          </span>
        )}
        {first.parents.length > 1 && (
          <span>
            → <code title={last.sha}>{short(last.sha)}</code>
          </span>
        )}
      </div>
      {copyStatus && <span role="status">{copyStatus}</span>}
      <details>
        <summary title="Full commit messages, authors, and metadata">Details</summary>
        <div className="commit-messages">
          <div className="commit-detail-meta">
            {first.author.login ? <GitHubAuthor login={first.author.login} /> : <span>{first.author.name}</span>}
            <time title={first.authoredAt}>{first.authoredAt ? timeAgo(first.authoredAt) : ''}</time>
            {chosen.length === 1 && first.verified && <span className="commit-verified">Verified</span>}
          </div>
          <p>Viewed progress is for this comparison and does not affect the full PR.</p>
          {chosen.map((c) => (
            <article key={c.sha}>
              <pre>{c.message}</pre>
              <p>
                <code>{c.sha}</code> · {c.author.name} · Authored {c.authoredAt || 'date unavailable'}
              </p>
              <p>
                Committed by {c.committer || c.author.name} · {c.committedAt || 'date unavailable'} · {c.parents.length}{' '}
                {c.parents.length === 1 ? 'parent' : 'parents'}
                {c.verified ? ' · Verified' : ''}
              </p>
            </article>
          ))}
        </div>
      </details>
    </div>
  );
  const status = comparisonError ? (
    <div className="changes-notice" role="alert">
      {comparisonError}
      <button onClick={() => setAttempt((n) => n + 1)}>Retry</button>
    </div>
  ) : !snapshot ? (
    <p className="changes-empty" role="status">
      {key ? 'Loading this comparison…' : loading ? 'Loading commits…' : 'Select a commit to inspect its changes.'}
    </p>
  ) : !snapshot.files.length ? (
    <p className="changes-empty">This comparison has no file changes.</p>
  ) : null;
  return (
    <div className="pr-commits">
      {(listError || newer) && (
        <div className="changes-notice" role="status">
          {listError || 'New commits are available. Your current comparison is unchanged.'}
        </div>
      )}
      <PrChangesView
        key={`${key}:${snapshot ? 'ready' : 'pending'}`}
        subject={subject}
        preferences={preferences}
        commit={{
          snapshot,
          fileStatus: comparisonError
            ? 'File list unavailable. Retry the comparison.'
            : key
              ? 'Loading changed files…'
              : 'Select a commit to load its files.',
          tools: (
            <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load(true)}>
              <RefreshCw size={14} />
              {loading ? 'Loading…' : 'Update commits'}
            </Button>
          ),
          sidebar,
          header,
          status,
          filesOpen,
          toggleFiles: () => setFilesOpen((v) => !v),
          onOpenCurrentFile,
        }}
      />
    </div>
  );
}
