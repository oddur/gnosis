import { watchGitHub } from '../lib/watch-github';
import { loadInspectionBatch, inspectionFailure, type InspectionFailure } from '../lib/inspection-batch';
import { InspectionFailureNotice } from './InspectionFailureNotice';
import { PrBadge, RepositoryBadge, CommitBadge } from './EntityBadge';
import { usePrReadVisit } from '../lib/pr-read-context';
import { useFileProgress } from '../lib/file-view-progress';
import { changeFileKey } from './PrFileInspection';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, RefreshCw } from 'lucide-react';
import {
  peekComparison,
  readComparison,
  prefetchInspection,
  comparisonIsReady,
  inspectionData,
  latestCommitSelection,
} from '../lib/inspection-cache';
import { PrChangesView } from './PrChangesView';
import { GitHubAuthor } from './GitHubAuthor';
import { Button } from './ui/button';
import {
  commitSelectionKey,
  commitViewedKey,
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
  const progress = useFileProgress();
  const [position] = useState(() => restore(subject.id));
  const [lists, setLists] = useState(() =>
    subject.members.flatMap((member) => inspectionData.peekCommits(member) ?? [])
  );
  usePrReadVisit(lists.map(list => ({ url: list.url, headSha: list.metadata.headSha })));
  const [selection, setSelection] = useState(() => {
    const saved = position.selection;
    const list = lists.find((list) => list.url === saved?.url);
    try {
      if (saved && list) {
        selectedCommits(list, saved);
        return saved;
      }
    } catch {
      /* Revision changed. */
    }
    const first = ownedCommits(subject, lists).find((group) => group.commits.length);
    return first?.list ? latestCommitSelection(first.list) : undefined;
  });
  const [commitsOpen, setCommitsOpen] = useState(true),
    [filesOpen, setFilesOpen] = useState(true);
  const [closedGroups, setClosedGroups] = useState<Set<string>>(() => new Set());
  const groupNodes = useRef(new Map<string, HTMLElement>());
  function revealGroup(url: string) {
    setClosedGroups((previous) => {
      const next = new Set(previous);
      next.delete(url);
      return next;
    });
    groupNodes.current.get(url)?.scrollIntoView({ block: 'nearest' });
    groupNodes.current.get(url)?.querySelector<HTMLButtonElement>('.commit-pr-heading')?.focus({ preventScroll: true });
  }
  const [rangeMode, setRangeMode] = useState(false);
  const anchor = useRef<{ url: string; sha: string } | undefined>(undefined);
  const [loading, setLoading] = useState(false),
    [loadErrors, setLoadErrors] = useState<InspectionFailure[]>([]),
    [newer, setNewer] = useState(false);
  const [resolved, setResolved] = useState<{ key: string; snapshot: PrChanges }>();
  const [comparisonError, setComparisonError] = useState(''),
    [attempt, setAttempt] = useState(0);
  const commitListNode = useRef<HTMLDivElement>(null);
  const focusedCommit = useRef<string | undefined>(undefined);
  const attachCommitList = useCallback((node: HTMLDivElement | null) => {
    const previous = commitListNode.current;
    if (previous && previous !== node) {
      position.scroll = previous.scrollTop;
      const active = document.activeElement;
      focusedCommit.current = active instanceof HTMLElement && previous.contains(active)
        ? active.dataset.commitId
        : undefined;
    }
    commitListNode.current = node;
    if (!node) return;
    // Changing the comparison remounts PrChangesView, including this sidebar.
    // Restore on the actual DOM attachment, before paint, not only on expand.
    node.scrollTop = position.scroll ?? 0;
    if (focusedCommit.current) {
      const target = Array.from(node.querySelectorAll<HTMLButtonElement>('[data-commit-id]'))
        .find(button => button.dataset.commitId === focusedCommit.current);
      target?.focus({ preventScroll: true });
      focusedCommit.current = undefined;
    }
  }, [position]);
  const [opening, setOpening] = useState<CommitSelection>();
  const failedSelection = useRef<CommitSelection | undefined>(undefined);
  const navigation = useRef(0);
  const intendedSelection = useRef(selection);
  const hoverCancel = useRef<() => void>(() => {});
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
  const snapshot =
    (selection ? peekComparison(selection) : undefined) ?? (resolved?.key === key ? resolved.snapshot : undefined);
  const first = chosen.at(0),
    last = chosen.at(-1);
  useEffect(() => {
    // A range cannot establish that each constituent commit was inspected.
    if (!snapshot || !selection || chosen.length !== 1 || !first) return;
    const viewed = !snapshot.filesTruncated && snapshot.files.every(file => progress.isFileViewed(changeFileKey({
      snapshot, file, key: file.path,
    })));
    const summary = commitViewedKey(selection.url, first.sha, selection.parentSha ?? first.parents.at(0) ?? '');
    if (progress.isFileViewed(summary) !== viewed) void progress.markFileViewed(summary, viewed);
  }, [snapshot, selection, first, chosen.length, progress]);
  function openSelection(next: CommitSelection) {
    setClosedGroups((previous) => {
      const groups = new Set(previous);
      groups.delete(next.url);
      return groups;
    });
    intendedSelection.current = next;
    const id = ++navigation.current;
    setComparisonError('');
    failedSelection.current = undefined;
    if (comparisonIsReady(next, subject.id)) {
      setSelection(next);
      setOpening(undefined);
      return;
    }
    setOpening(next);
    void readComparison(next, subject.id)
      .then((value) => {
        if (navigation.current !== id) return;
        setSelection(next);
        setResolved({ key: commitSelectionKey(next), snapshot: value });
      })
      .catch((error: unknown) => {
        if (navigation.current !== id) return;
        failedSelection.current = next;
        setComparisonError(
          `Could not open ${short(next.lastSha)}. ${error instanceof Error ? error.message : String(error)}`
        );
      })
      .finally(() => {
        if (navigation.current === id) setOpening(undefined);
      });
  }
  function warmCommit(list: PrCommits, commit: PrCommit) {
    const next = {
      url: list.url,
      prBaseSha: list.metadata.baseSha,
      prHeadSha: list.metadata.headSha,
      firstSha: commit.sha,
      lastSha: commit.sha,
    };
    return prefetchInspection(commitSelectionKey(next), () => readComparison(next, subject.id, true));
  }
  useEffect(() => {
    if (!snapshot || !selection) return;
    const ordered = groups.flatMap((group) =>
      group.list ? [...group.commits].reverse().map((commit) => ({ list: group.list as PrCommits, commit })) : []
    );
    const index = ordered.findIndex((c) => c.list.url === selection.url && c.commit.sha === selection.lastSha);
    const cancel = [index + 1, index + 2, index - 1].flatMap((i) =>
      ordered[i] ? [warmCommit(ordered[i].list, ordered[i].commit)] : []
    );
    return () => cancel.forEach((stop) => stop());
  }, [snapshot, groups, selection]);
  function choose(list: PrCommits, commit: PrCommit, extend = false) {
    const start = extend && anchor.current?.url === list.url ? anchor.current.sha : commit.sha;
    const a = list.commits.findIndex((c) => c.sha === start),
      b = list.commits.findIndex((c) => c.sha === commit.sha);
    openSelection({
      url: list.url,
      prBaseSha: list.metadata.baseSha,
      prHeadSha: list.metadata.headSha,
      firstSha: list.commits[Math.min(a < 0 ? b : a, b)].sha,
      lastSha: list.commits[Math.max(a, b)].sha,
    });
    if (!extend || anchor.current?.url !== list.url) anchor.current = { url: list.url, sha: commit.sha };
  }
  const loadController = useRef<AbortController | undefined>(undefined);
  const [pendingMembers, setPendingMembers] = useState<string[]>([]);
  async function load(refresh: boolean, onlyUrl?: string) {
    const current = ++epoch.current;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    const members = subject.members.filter(m => !onlyUrl || m.url === onlyUrl);
    const waiting = new Set(members.map(m => m.url));
    setLoading(true);
    setPendingMembers([...waiting]);
    const next = new Map(lists.map(list => [list.url, list]));
    const failures = new Map(loadErrors.filter(e => onlyUrl && e.url !== onlyUrl).map(e => [e.url, e]));
    setLoadErrors([...failures.values()]);
    try {
      await loadInspectionBatch(members, (member, signal) => inspectionData.readCommits(member, refresh, false, signal), (member, result) => {
        if (epoch.current !== current) return;
        if ('value' in result) next.set(member.url, result.value);
        else failures.set(member.url, inspectionFailure(member.url, result.error));
        const ordered = subject.members.flatMap(m => next.get(m.url) ?? []);
        setLists(ordered);
        waiting.delete(member.url);
        setPendingMembers([...waiting]);
        setLoadErrors([...failures.values()]);
        // Reconcile only the arriving PR. Another member must not replace an
        // in-flight choice or pull focus back to the first PR in the stack.
        const desired = intendedSelection.current;
        if ('value' in result && desired?.url === member.url) {
          const previous = result.value;
          if (previous.commits.some(c => c.sha === desired.firstSha) && previous.commits.some(c => c.sha === desired.lastSha)) {
            if (desired.prBaseSha !== previous.metadata.baseSha || desired.prHeadSha !== previous.metadata.headSha) {
              navigation.current++;
              setOpening(undefined);
              setComparisonError('');
              const refreshed = { ...desired, prBaseSha: previous.metadata.baseSha, prHeadSha: previous.metadata.headSha };
              intendedSelection.current = refreshed;
              setSelection(refreshed);
            }
          } else {
            const latest = latestCommitSelection(previous);
            if (latest) openSelection(latest);
            else { intendedSelection.current = undefined; setSelection(undefined); }
          }
        } else if (!desired) {
          const group = ownedCommits(subject, ordered).find(g => g.commits.length);
          const latest = group?.commits.at(-1);
          if (group?.list && latest) choose(group.list, latest);
        }
      }, controller.signal);
      if (epoch.current === current && !controller.signal.aborted && !failures.size) setNewer(false);
    } finally {
      if (epoch.current === current) { setLoading(false); setPendingMembers([]); }
    }
  }
  useEffect(() => {
    if (lists.length !== subject.members.length) void load(false);
    return () => {
      epoch.current++;
      loadController.current?.abort();
      navigation.current++;
      hoverCancel.current();
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
    const stop = watchGitHub({ kind: 'metadata', priority: 'active', targets: lists.map(list => ({ url: list.url })) }, update => {
      if (update.kind !== 'metadata') return;
      const list = lists.find(list => list.url === update.url);
      if (list && (update.value.headSha !== list.metadata.headSha || update.value.baseSha !== list.metadata.baseSha)) setNewer(true);
    });
    if (stop) return stop;
    void check();
    const timer = setInterval(() => void check(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [lists]);
  useEffect(() => {
    setComparisonError('');
    if (!key || !selection || peekComparison(selection)) return;
    let cancelled = false;
    void readComparison(selection, subject.id)
      .then((value) => {
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
            ref={attachCommitList}
            onScroll={(e) => {
              position.scroll = e.currentTarget.scrollTop;
              persist();
            }}
            aria-label="Commits"
          >
            {groups.map((group) => (
              <section
                key={group.member.url}
                className="commit-pr-group"
                ref={(node) => {
                  if (node) groupNodes.current.set(group.member.url, node);
                  else groupNodes.current.delete(group.member.url);
                }}
              >
                {subject.kind === 'stack' && (
                  <button
                    className="commit-pr-heading"
                    aria-expanded={!closedGroups.has(group.member.url)}
                    onClick={() =>
                      setClosedGroups((previous) => {
                        const next = new Set(previous);
                        if (next.has(group.member.url)) next.delete(group.member.url);
                        else next.add(group.member.url);
                        return next;
                      })
                    }
                  >
                    {closedGroups.has(group.member.url) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    <span>
                      <strong>#{group.member.number}</strong>
                      <small>{group.member.title}</small>
                    </span>
                    <span className="commit-pr-count">{group.commits.length}</span>
                  </button>
                )}
                {!closedGroups.has(group.member.url) && (
                  <>
                    {group.parents.length > 0 && (
                      <div className="commit-source-links">
                        Based on{' '}
                        {group.parents.map((parent) => (
                          <button key={parent.url} onClick={() => revealGroup(parent.url)}>
                            #{parent.number}
                          </button>
                        ))}
                      </div>
                    )}
                    {group.inheritedFrom.length > 0 && (
                      <div className="commit-source-links">
                        Includes commits from{' '}
                        {group.inheritedFrom.map((source) => (
                          <button key={source.member.url} onClick={() => revealGroup(source.member.url)}>
                            #{source.member.number} ({source.count})
                          </button>
                        ))}
                      </div>
                    )}
                    <div className={subject.kind === 'stack' ? 'commit-pr-commits' : undefined}>
                      {[...group.commits].reverse().map((commit) => {
                        const savedComparison = group.list ? peekComparison({
                          url: group.member.url, prBaseSha: group.list.metadata.baseSha,
                          prHeadSha: group.list.metadata.headSha, firstSha: commit.sha, lastSha: commit.sha,
                        }) : undefined;
                        const viewed = savedComparison
                          ? !savedComparison.filesTruncated && savedComparison.files.every(file => progress.isFileViewed(changeFileKey({ snapshot: savedComparison, file, key: file.path })))
                          : progress.isFileViewed(commitViewedKey(group.member.url, commit.sha, commit.parents.at(0) ?? ''));
                        return (
                        <div key={commit.sha} className="commit-entry">
                        <button
                          data-commit-id={JSON.stringify([group.member.url, commit.sha])}
                          className={`commit-row${viewed ? '' : ' is-unviewed'}`}
                          title={viewed ? 'All files in this commit are viewed' : 'This commit has unviewed files'}
                          aria-busy={opening?.url === group.member.url && opening.lastSha === commit.sha}
                          onPointerEnter={() => {
                            hoverCancel.current();
                            if (group.list) hoverCancel.current = warmCommit(group.list, commit);
                          }}
                          onPointerLeave={() => hoverCancel.current()}
                          onFocus={() => {
                            hoverCancel.current();
                            if (group.list) hoverCancel.current = warmCommit(group.list, commit);
                          }}
                          onBlur={() => hoverCancel.current()}
                          aria-pressed={selection?.url === group.member.url && chosen.some((c) => c.sha === commit.sha)}
                          onClick={(e) =>
                            group.list && choose(group.list, commit, e.shiftKey || (rangeMode && !!anchor.current))
                          }
                        >
                          <span className="commit-row-heading">
                            <span className="commit-view-indicator" aria-hidden="true">
                              {!viewed && <span className="pr-unread-dot" />}
                            </span>
                            <span className="sr-only">{viewed ? 'Viewed: ' : 'Unviewed: '}</span>
                            <span className="commit-row-title">{commit.message.split('\n')[0]}</span>
                          </span>
                          <span className="sr-only"> {short(commit.sha)}</span>
                        </button>
                          <div className="commit-row-meta" onClick={e => {
                            if (!(e.target as HTMLElement).closest('button') && group.list) choose(group.list, commit, e.shiftKey || (rangeMode && !!anchor.current));
                          }}>
                            {commit.author.login ? <GitHubAuthor login={commit.author.login} /> : <span>{authorName(commit)}</span>}
                            <CommitBadge sha={commit.sha} repo={group.member.headRepo} />
                            <time title={commit.committedAt}>
                              {commit.committedAt ? timeAgo(commit.committedAt) : ''}
                            </time>
                          </div>
                        </div>
                        );
                      })}
                      {!group.commits.length && (
                        <p className="commit-inherited">All commits are included in the PRs above.</p>
                      )}
                    </div>
                  </>
                )}
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
          {activeList && <RepositoryBadge repo={activeList.metadata.baseRepo} />} {selection && <PrBadge url={selection.url} title={activeList?.metadata.title} />}
        </span>
        {first.parents.length > 1 ? (
          <label>
            Compare with{' '}
            <select
              aria-label="Compare with parent"
              value={selection?.parentSha ?? first.parents[0]}
              onChange={(e) => {
                if (selection) openSelection({ ...selection, parentSha: e.target.value });
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
                Parent <CommitBadge sha={first.parents[0]} repo={activeList?.metadata.baseRepo} />
              </>
            ) : (
              'Initial commit'
            )}{' '}
            → <CommitBadge sha={last.sha} repo={activeList?.metadata.headRepo} />
          </span>
        )}
        {first.parents.length > 1 && (
          <span>
            → <CommitBadge sha={last.sha} repo={activeList?.metadata.headRepo} />
          </span>
        )}
      </div>
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
                <CommitBadge sha={c.sha} repo={activeList?.metadata.headRepo} /> · {c.author.login ? <GitHubAuthor login={c.author.login} /> : c.author.name} · Authored {c.authoredAt || 'date unavailable'}
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
      <button
        onClick={() => (failedSelection.current ? openSelection(failedSelection.current) : setAttempt((n) => n + 1))}
      >
        Retry
      </button>
    </div>
  ) : !snapshot ? (
    <p className="changes-empty" role="status">
      {key || opening
        ? 'Loading this comparison…'
        : loading
          ? 'Loading commits…'
          : 'Select a commit to inspect its changes.'}
    </p>
  ) : !snapshot.files.length ? (
    <p className="changes-empty">This comparison has no file changes.</p>
  ) : null;
  return (
    <div className="pr-commits">
      {newer && <div className="changes-notice" role="status">New commits are available. Your current comparison is unchanged.</div>}
      {loading && <div className="changes-notice" role="status">
        <span>Loading commits for {pendingMembers.length} {pendingMembers.length === 1 ? 'PR' : 'PRs'}… Available commits are ready to review.</span>
        <button onClick={() => {
          loadController.current?.abort();
          setLoadErrors(errors => [...errors, ...pendingMembers.map(url => ({ url, message: 'Loading was stopped.' }))]);
          setLoading(false); setPendingMembers([]);
        }}>Stop loading</button>
      </div>}
      {loadErrors.map(failure => <InspectionFailureNotice key={failure.url} failure={failure}
        saved={lists.some(list => list.url === failure.url)} kind="commits" busy={pendingMembers.includes(failure.url)} retryDisabled={loading}
        retry={() => void load(true, failure.url)} />)}
      <PrChangesView
        key={`${key}:${snapshot ? 'ready' : 'pending'}`}
        subject={subject}
        preferences={preferences}
        commit={{
          snapshot,
          breadcrumbs: [
            ...(subject.kind === 'stack' && selection
              ? [
                  {
                    id: 'member',
                    label: `Source #${selection.url.split('/').pop()}`,
                    pickerLabel: 'Source PR in combined commits',
                    value: selection.url,
                    options: groups
                      .filter((group) => group.commits.length)
                      .map((group) => ({
                        value: group.member.url,
                        label: `#${group.member.number} · ${group.member.title}`,
                      })),
                    select: (url: string) => {
                      const list = lists.find((list) => list.url === url);
                      const next = list && latestCommitSelection(list);
                      if (next) {
                        setRangeMode(false);
                        anchor.current = undefined;
                        openSelection(next);
                      }
                    },
                  },
                ]
              : []),
            ...(selection && first && last
              ? [
                  {
                    id: 'commit',
                    label:
                      chosen.length > 1
                        ? `${short(first.sha)}…${short(last.sha)} (${chosen.length} commits)`
                        : short(last.sha),
                    title: chosen.map((commit) => commit.message.split('\n')[0]).join(' → '),
                    pickerLabel: 'Commit',
                    value: chosen.length > 1 ? 'current-range' : last.sha,
                    options: [
                      ...(chosen.length > 1
                        ? [
                            {
                              value: 'current-range',
                              label: `${chosen.length} commits · ${short(first.sha)}…${short(last.sha)}`,
                            },
                          ]
                        : []),
                      ...(groups.find((group) => group.member.url === selection.url)?.commits ?? [])
                        .slice()
                        .reverse()
                        .map((commit) => ({
                          value: commit.sha,
                          label: `${short(commit.sha)} · ${commit.message.split('\n')[0]}`,
                        })),
                    ],
                    select: (sha: string) => {
                      if (sha === 'current-range' || !activeList) return;
                      setRangeMode(false);
                      anchor.current = undefined;
                      openSelection({
                        url: activeList.url,
                        prBaseSha: activeList.metadata.baseSha,
                        prHeadSha: activeList.metadata.headSha,
                        firstSha: sha,
                        lastSha: sha,
                      });
                    },
                  },
                ]
              : []),
          ],
          fileStatus: comparisonError
            ? 'File list unavailable. Retry the comparison.'
            : key
              ? 'Loading changed files…'
              : 'Select a commit to load its files.',
          tools: (
            <>
              {opening && snapshot && (
                <span className="changes-progress" role="status">
                  Opening {short(opening.lastSha)}…
                </span>
              )}
              <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load(true)}>
                <RefreshCw size={14} />
                {loading ? 'Loading…' : 'Update commits'}
              </Button>
            </>
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
