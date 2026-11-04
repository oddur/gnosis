import { lazy, Suspense } from 'react';
const WorkflowGraphView = lazy(() => import('./WorkflowGraph').then((m) => ({ default: m.WorkflowGraphView })));
import { BulkCheckRerun } from './BulkCheckRerun';
import { useEffect, useRef, useState } from 'react';
import {
  CircleAlert,
  CircleCheck,
  CircleMinus,
  Clock3,
  ExternalLink,
  List,
  RefreshCw,
  Workflow,
  X,
} from 'lucide-react';
import type { ReviewSubject } from '../lib/workbench';
import {
  checkCounts,
  checkVersion,
  checkDetailsKey,
  checkDuration,
  checkGroup,
  checkLabel,
  orderedChecks,
  type PrChecks,
  type PrCheck,
  type CheckFilter,
  type CheckDetails,
  type CheckLog,
} from '../lib/pr-checks';
import { CheckJobSteps } from './CheckJobSteps';
import { Markdown } from './Markdown';
import { Button } from './ui/button';
import { timeAgo } from '../lib/utils';
export interface CheckFocus {
  url: string;
  id?: string;
  nonce: number;
}
type Selection = { snapshot: PrChecks; check: PrCheck };
export function CheckIcon({ check }: { check: PrCheck }) {
  const group = checkGroup(check),
    Icon =
      group === 'attention'
        ? CircleAlert
        : group === 'running'
          ? Clock3
          : group === 'passed'
            ? CircleCheck
            : CircleMinus;
  return <Icon size={16} className={`check-${group}`} aria-hidden="true" />;
}
export function PrChecksView({
  subject,
  values,
  errors,
  busy,
  refresh,
  focus,
  onSource,
  stateKey,
}: {
  subject: ReviewSubject;
  stateKey?: string;
  values: Partial<Record<string, PrChecks>>;
  errors: Partial<Record<string, string>>;
  busy: boolean;
  refresh: (url?: string) => void;
  focus?: CheckFocus;
  onSource: (url: string, path: string, line: number, headSha: string) => void;
}) {
  const [view, setView] = useState<'list' | 'graph'>('list');
  const [graphDetails, setGraphDetails] = useState(false);
  const [graphVisited, setGraphVisited] = useState(false);
  const graphButton = useRef<HTMLButtonElement>(null);
  const graphSelection = useRef<Selection | undefined>(undefined);
  const detailOrigin = useRef<HTMLElement | null>(null);
  const restoreGraphFocus = useRef(false);
  const panes = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [detailNavigation, setDetailNavigation] = useState<HTMLDivElement | null>(null);
  const [graphToolbar, setGraphToolbar] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!panes.current) return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width <= 1050));
    observer.observe(panes.current);
    return () => observer.disconnect();
  }, []);
  const closeGraphDetails = () => {
    restoreGraphFocus.current = true;
    setGraphDetails(false);
  };
  useEffect(() => {
    if (graphDetails || view !== 'graph' || !restoreGraphFocus.current) return;
    const frame = requestAnimationFrame(() => {
      restoreGraphFocus.current = false;
      const origin =
        panes.current?.querySelector<HTMLElement>('.workflow-job[data-selected] .workflow-job-open') ??
        detailOrigin.current;
      if (origin?.isConnected && origin.getClientRects().length) origin.focus({ preventScroll: true });
      else graphButton.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [graphDetails, view]);
  const firstMember =
    subject.members.find((m) => values[m.url]?.checks.some((c) => checkGroup(c) === 'attention')) ??
    subject.members.at(0);
  const warmUrl = firstMember?.url;
  const warmSha = (warmUrl && values[warmUrl]?.headSha) || firstMember?.headSha;
  useEffect(() => {
    if (!warmUrl || !warmSha) return;
    void window.electronAPI.prepareWorkflowGraph?.({ url: warmUrl, headSha: warmSha }).catch(() => {});
    return () => {
      void window.electronAPI.prepareWorkflowGraph?.().catch(() => {});
    };
  }, [warmUrl, warmSha]);
  const [graphRefresh, setGraphRefresh] = useState(0);
  const detailPane = useRef<HTMLDivElement>(null);
  const operation = useRef(0);
  const [requested, setRequested] = useState(false);
  const [filter, setFilter] = useState<CheckFilter>('all');
  const [selected, setSelected] = useState<Selection>();
  useEffect(() => {
    if (view !== 'graph' || !graphDetails) return;
    const frame = requestAnimationFrame(() => {
      if (detailPane.current) detailPane.current.scrollTop = 0;
      detailPane.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [view, graphDetails, selected?.check.id]);
  const [detailCache, setDetailCache] = useState<Record<string, { value: CheckDetails; receivedAt: number }>>({});
  const previousAttempt = useRef(0);
  const [error, setError] = useState('');
  const [detailsBusy, setDetailsBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [log, setLog] = useState<CheckLog>();
  const [logBusy, setLogBusy] = useState(false);
  const [logError, setLogError] = useState('');
  const [rerunning, setRerunning] = useState(false);
  const [rerunMessage, setRerunMessage] = useState('');
  const [handledFocus, setHandledFocus] = useState<number>();
  useEffect(() => {
    if (focus && handledFocus !== focus.nonce) {
      const snapshot = values[focus.url];
      const check =
        snapshot && (snapshot.checks.find((c) => c.id === focus.id) ?? orderedChecks(snapshot.checks, 'all').at(0));
      if (snapshot && check) {
        setSelected({ snapshot, check });
        setFilter('all');
        setView('list');
        setHandledFocus(focus.nonce);
      }
    } else if (!selected) {
      const snapshots = subject.members.flatMap((m) => values[m.url] ?? []);
      const snapshot =
        snapshots.find((s) => s.checks.some((c) => checkGroup(c) === 'attention')) ??
        snapshots.find((s) => s.checks.length);
      const check = snapshot && orderedChecks(snapshot.checks, 'all').at(0);
      if (snapshot && check) setSelected({ snapshot, check });
    }
  }, [values, focus, handledFocus, selected]);
  useEffect(() => {
    operation.current++;
    setRequested(false);
    setError('');
    setLog(undefined);
    setLogError('');
    setLogBusy(false);
    setRerunMessage('');
    setRerunning(false);
    return () => {
      operation.current++;
    };
  }, [selected]);
  const latest = selected && values[selected.snapshot.url];
  const stale = !!selected && !!latest && latest.headSha !== selected.snapshot.headSha;
  const latestCheck =
    selected &&
    latest &&
    (latest.checks.find((c) => c.id === selected.check.id) ??
      (() => {
        const matches = latest.checks.filter(
          (c) =>
            c.kind === selected.check.kind && c.name === selected.check.name && c.provider === selected.check.provider
        );
        // Names can repeat across workflows. Never jump to an ambiguous result.
        const workflow = selected.check.url?.match(/\/actions\/runs\/(\d+)\//)?.[1];
        const sameWorkflow = workflow && matches.filter((c) => c.url?.includes(`/actions/runs/${workflow}/`));
        return sameWorkflow && sameWorkflow.length === 1
          ? sameWorkflow[0]
          : matches.length === 1
            ? matches[0]
            : undefined;
      })());
  const selectionChanged =
    !!selected &&
    !!latest &&
    !!latestCheck &&
    !stale &&
    latest.checkedAt >= selected.snapshot.checkedAt &&
    (latestCheck.id !== selected.check.id ||
      latestCheck.status !== selected.check.status ||
      latestCheck.conclusion !== selected.check.conclusion ||
      latestCheck.startedAt !== selected.check.startedAt ||
      latestCheck.completedAt !== selected.check.completedAt);
  // Follow attempts on this commit; new commits still require an explicit transition.
  useEffect(() => {
    if (selectionChanged) setSelected({ snapshot: latest, check: latestCheck });
  }, [selectionChanged, latest, latestCheck]);
  const detailKey = selected && checkDetailsKey({ ...selected.snapshot, id: selected.check.id }, selected.check);
  const savedDetail = detailKey ? detailCache[detailKey] : undefined;
  const preparedDetail =
    selected &&
    latest?.headSha === selected.snapshot.headSha &&
    latestCheck &&
    checkVersion(latestCheck) === checkVersion(selected.check)
      ? latest.details?.[selected.check.id]
      : undefined;
  const details =
    preparedDetail && (preparedDetail.checkedAt ?? 0) >= (savedDetail?.receivedAt ?? 0)
      ? { value: preparedDetail, receivedAt: preparedDetail.checkedAt ?? 0 }
      : savedDetail;
  const detail = details?.value;
  // Reuse the existing checks subscription to update only the active job. No new polling loop.
  const detailRefreshAt =
    selected &&
    selected.check.status !== 'completed' &&
    values[selected.snapshot.url]?.headSha === selected.snapshot.headSha
      ? values[selected.snapshot.url]?.checkedAt
      : undefined;
  useEffect(() => {
    let live = true;
    setError('');
    if (!selected || selected.check.kind === 'status' || selectionChanged) {
      setDetailsBusy(false);
      return;
    }
    const force = attempt !== previousAttempt.current;
    previousAttempt.current = attempt;
    if (!force && selected.check.status === 'completed' && detail?.state?.status === 'completed' && !detail.warning) {
      setDetailsBusy(false);
      return;
    }
    setDetailsBusy(true);
    void window.electronAPI
      .getCheckDetails(
        { url: selected.snapshot.url, headSha: selected.snapshot.headSha, id: selected.check.id },
        { force }
      )
      .then((value) => {
        if (live && detailKey)
          setDetailCache((current) => {
            const next = { ...current, [detailKey]: { value, receivedAt: value.checkedAt ?? Date.now() } };
            while (Object.keys(next).length > 64) Reflect.deleteProperty(next, Object.keys(next)[0]);
            return next;
          });
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (live) setDetailsBusy(false);
      });
    return () => {
      live = false;
    };
  }, [selected, attempt, detailRefreshAt, selectionChanged]);
  const displayedCheck = selected && { ...selected.check, ...detail?.state };
  const selectedMember = selected && subject.members.find((m) => m.url === selected.snapshot.url);
  const awaitingCheck = (snapshot: PrChecks, check: PrCheck) =>
    requested &&
    selected?.snapshot.url === snapshot.url &&
    selected.snapshot.headSha === snapshot.headSha &&
    selected.check.id === check.id;
  const counts = checkCounts(subject.members.flatMap((m) => values[m.url]?.checks ?? []));
  async function loadLog() {
    if (!selected) return;
    const token = operation.current;
    setLogBusy(true);
    setLogError('');
    try {
      const value = await window.electronAPI.getCheckLog({
        url: selected.snapshot.url,
        headSha: selected.snapshot.headSha,
        id: selected.check.id,
      });
      if (operation.current === token) setLog(value);
    } catch (e) {
      if (operation.current === token) setLogError(e instanceof Error ? e.message : String(e));
    } finally {
      if (operation.current === token) setLogBusy(false);
    }
  }
  async function rerun(mode: 'all' | 'failed') {
    if (!selected || rerunning) return;
    const token = operation.current;
    setRerunning(true);
    setRerunMessage('');
    try {
      await window.electronAPI.rerunChecks({
        url: selected.snapshot.url,
        headSha: selected.snapshot.headSha,
        id: selected.check.id,
        mode,
      });
      if (operation.current !== token) return;
      setRequested(true);
      setRerunMessage('');
      // The backend follows this write; avoid a duplicate forced refresh of the whole stack.
      if (window.electronAPI.githubSyncVersion !== 1) refresh(selected.snapshot.url);
    } catch (e) {
      if (operation.current === token)
        setRerunMessage(
          `${e instanceof Error ? e.message : String(e)} Use GitHub if your token does not have Actions write access.`
        );
    } finally {
      if (operation.current === token) setRerunning(false);
    }
  }
  return (
    <section className="pr-checks-workspace" aria-label="PR checks">
      <div className="checks-toolbar">
        <div className="checks-view-switch" role="group" aria-label="Checks view">
          <Button size="sm" variant="ghost" aria-pressed={view === 'list'} onClick={() => setView('list')}>
            <List size={15} aria-hidden="true" /> List
          </Button>
          <Button
            size="sm"
            variant="ghost"
            ref={graphButton}
            aria-pressed={view === 'graph'}
            onClick={() => {
              setGraphVisited(true);
              setView('graph');
              if (graphSelection.current) setSelected(graphSelection.current);
            }}
          >
            <Workflow size={15} aria-hidden="true" /> Graph
          </Button>
        </div>
        <div className="checks-graph-controls" ref={setGraphToolbar} hidden={view !== 'graph'} />
        <BulkCheckRerun key={subject.id} members={subject.members} values={values} onChanged={() => refresh()} />
        <div role="group" aria-label="Filter checks" hidden={view === 'graph'}>
          {(['all', 'attention', 'running'] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={filter === value ? 'secondary' : 'ghost'}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {value === 'all'
                ? 'All checks'
                : value === 'attention'
                  ? view === 'graph'
                    ? 'Needs attention'
                    : `Needs attention (${counts.attention})`
                  : view === 'graph'
                    ? 'Running'
                    : `Running (${counts.running})`}
            </Button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            refresh();
            setGraphRefresh((n) => n + 1);
          }}
          disabled={busy}
          aria-label="Refresh checks"
          title="Refresh checks"
        >
          <RefreshCw size={15} className={busy ? 'animate-spin' : undefined} />
        </Button>
      </div>
      <div
        ref={panes}
        className={`checks-panes${view === 'graph' ? ` checks-graph-panes${graphDetails ? ' with-detail' : ''}` : ''}`}
      >
        {graphVisited && (
          <div className="workflow-host" hidden={view !== 'graph'} inert={view !== 'graph' || (graphDetails && narrow)}>
            <Suspense fallback={<div className="checks-empty">Loading graph view…</div>}>
              <WorkflowGraphView
                key={`${stateKey ?? subject.id}:${subject.members.map((m) => values[m.url]?.headSha ?? m.headSha).join(':')}`}
                stateKey={`${stateKey ?? subject.id}:${subject.members.map((m) => values[m.url]?.headSha ?? m.headSha).join(':')}`}
                active={view === 'graph'}
                toolbarHost={view === 'graph' ? graphToolbar : null}
                detailHost={view === 'graph' && graphDetails ? detailNavigation : null}
                onRevealContext={closeGraphDetails}
                onFilterChange={setFilter}
                onExternalChecks={(url) => {
                  setFilter('all');
                  setView('list');
                  const source = values[url];
                  const check = source?.checks.find((c) => c.kind === 'status');
                  if (source && check) setSelected({ snapshot: source, check });
                }}
                subject={subject}
                values={values}
                filter={filter}
                refreshNonce={graphRefresh}
                onContextChange={() => {
                  setGraphDetails(false);
                  graphSelection.current = undefined;
                }}
                selectedId={graphSelection.current?.check.id}
                onSelect={(snapshot, check) => {
                  graphSelection.current = { snapshot, check };
                  if (!detailPane.current?.contains(document.activeElement))
                    detailOrigin.current =
                      document.activeElement instanceof HTMLElement ? document.activeElement : null;
                  setSelected({ snapshot, check });
                  setGraphDetails(true);
                }}
              />
            </Suspense>
          </div>
        )}
        {view === 'list' && (
          <nav className="checks-list" aria-label="Checks by PR">
            {subject.members.map((member) => {
              const snapshot = values[member.url];
              const checks = snapshot
                ? orderedChecks(
                    snapshot.checks.map((check) =>
                      detail?.state &&
                      details &&
                      selected?.snapshot.url === snapshot.url &&
                      selected.snapshot.headSha === snapshot.headSha &&
                      selected.check.id === check.id &&
                      snapshot.checkedAt <= details.receivedAt
                        ? { ...check, ...detail.state }
                        : check
                    ),
                    filter
                  )
                : [];
              return (
                <section key={member.url} className="checks-pr-group">
                  <h2>
                    #{member.number} <span>{member.title}</span>
                  </h2>
                  <p className="checks-revision">
                    {snapshot ? (
                      <>
                        {snapshot.headSha.slice(0, 7)} · Checked {timeAgo(new Date(snapshot.checkedAt).toISOString())}
                      </>
                    ) : busy ? (
                      'Loading checks…'
                    ) : (
                      'Checks not loaded'
                    )}
                  </p>
                  {errors[member.url] && (
                    <p className="checks-notice checks-sync-status" role="status">
                      {snapshot ? 'Showing saved results. ' : ''}
                      {errors[member.url]}{' '}
                      <button
                        className="underline underline-offset-4"
                        disabled={busy}
                        onClick={() => refresh(member.url)}
                      >
                        Refresh this PR
                      </button>
                    </p>
                  )}
                  {snapshot?.warning && <p className="checks-notice">{snapshot.warning}</p>}
                  {checks.map((check) => (
                    <button
                      className="check-row"
                      key={check.id}
                      aria-current={
                        selected?.snapshot.url === member.url &&
                        selected.check.id === check.id &&
                        selected.snapshot.headSha === snapshot?.headSha
                          ? 'true'
                          : undefined
                      }
                      onClick={() => {
                        if (snapshot) setSelected({ snapshot, check });
                      }}
                    >
                      <CheckIcon
                        check={
                          snapshot && awaitingCheck(snapshot, check)
                            ? { ...check, status: 'queued', conclusion: null }
                            : check
                        }
                      />
                      <span className="check-row-content">
                        <strong>{check.name}</strong>
                        <small>
                          {check.provider} ·{' '}
                          <span
                            className={`check-${snapshot && awaitingCheck(snapshot, check) ? 'running' : checkGroup(check)}`}
                          >
                            {snapshot && awaitingCheck(snapshot, check) ? 'Rerun requested' : checkLabel(check)}
                          </span>
                        </small>
                      </span>
                      <span className="check-duration">
                        {snapshot && awaitingCheck(snapshot, check) ? '' : checkDuration(check)}
                      </span>
                    </button>
                  ))}
                  {snapshot && !checks.length && (
                    <p className="checks-notice">
                      {snapshot.checks.length ? 'No checks match this filter.' : 'No checks reported for this commit.'}
                    </p>
                  )}
                </section>
              );
            })}
          </nav>
        )}
        <div
          ref={detailPane}
          tabIndex={-1}
          role="region"
          hidden={view === 'graph' && !graphDetails}
          className="check-detail"
          aria-label="Selected check details"
          onKeyDown={(event) => {
            if (view === 'graph' && event.key === 'Escape' && !event.defaultPrevented) {
              event.preventDefault();
              event.stopPropagation();
              closeGraphDetails();
            }
          }}
        >
          {view === 'graph' && (
            <div className="workflow-detail-toolbar">
              <Button
                className="workflow-close-detail"
                size="sm"
                variant="ghost"
                aria-label="Close job details"
                onClick={closeGraphDetails}
              >
                <X size={16} /> Close
              </Button>
              <div className="workflow-detail-navigation" ref={setDetailNavigation} />
            </div>
          )}
          {!selected || !displayedCheck ? (
            <div className="checks-empty">
              <CircleCheck size={24} />
              <h2>Select a check</h2>
              <p>Choose a result to inspect its output and annotations.</p>
            </div>
          ) : (
            <>
              {stale && (
                <div className="checks-update" role="status">
                  <p>These results are from previous commit {selected.snapshot.headSha.slice(0, 7)}.</p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      if (latestCheck) setSelected({ snapshot: latest, check: latestCheck });
                      else setSelected(undefined);
                    }}
                  >
                    View latest results
                  </Button>
                </div>
              )}
              <header className="check-detail-header">
                <div>
                  {selectedMember && (
                    <p className="check-source">
                      <a href={selectedMember.url} target="_blank" rel="noopener noreferrer">
                        {selectedMember.repo} #{selectedMember.number}
                      </a>{' '}
                      · {selected.snapshot.headSha.slice(0, 7)}
                      <span>{selectedMember.title}</span>
                    </p>
                  )}
                  <h2>
                    <CheckIcon
                      check={requested ? { ...displayedCheck, status: 'queued', conclusion: null } : displayedCheck}
                    />
                    {selected.check.name}
                  </h2>
                  <p>
                    {selected.check.provider} ·{' '}
                    <span className={`check-${requested ? 'running' : checkGroup(displayedCheck)}`}>
                      {requested ? 'Rerun requested' : checkLabel(displayedCheck)}
                    </span>{' '}
                    ·{' '}
                    {selected.check.required === true
                      ? 'Required'
                      : selected.check.required === false
                        ? 'Optional'
                        : 'Requirement unknown'}
                    {detail?.job && ` · ${requested ? 'Previous attempt' : 'Attempt'} ${detail.job.attempt}`}
                    {!requested &&
                      displayedCheck.status === 'completed' &&
                      checkDuration(displayedCheck) &&
                      ` · ${checkDuration(displayedCheck)}`}
                  </p>
                </div>
                {selected.check.url && (
                  <a href={selected.check.url} target="_blank" rel="noopener noreferrer">
                    {selected.check.kind === 'status' ? 'Open provider result' : 'Open on GitHub'}{' '}
                    <ExternalLink size={13} />
                  </a>
                )}
              </header>
              {requested && (
                <p className="checks-notice" role="status">
                  Waiting for GitHub to report the new attempt. Results below are from the previous attempt (
                  {checkLabel(displayedCheck).toLowerCase()}).
                </p>
              )}
              {selected.check.kind === 'status' ? (
                <p>
                  {selected.check.description ||
                    'This provider has not supplied further details. Open its result to investigate.'}
                </p>
              ) : error && !detail ? (
                <p className="checks-error" role="alert">
                  {error} <button onClick={() => setAttempt((n) => n + 1)}>Retry details</button>
                </p>
              ) : !detail ? (
                <p role="status">Loading check details…</p>
              ) : (
                <>
                  {error && (
                    <p className="checks-error" role="status">
                      Could not update job steps. Showing the last result. {error}
                    </p>
                  )}
                  {detail.warning && <p className="checks-notice">{detail.warning}</p>}
                  {detail.summary && <Markdown>{detail.summary}</Markdown>}
                  {detail.text && (
                    <details className="check-output">
                      <summary>Full check output</summary>
                      <Markdown>{detail.text}</Markdown>
                    </details>
                  )}
                  {!detail.summary && !detail.text && !detail.annotations.length && !detail.job && (
                    <p className="checks-notice">
                      This check did not supply further output. Open GitHub for more details.
                    </p>
                  )}
                  {detail.job && (
                    <>
                      <CheckJobSteps busy={detailsBusy} job={detail.job} onRefresh={() => setAttempt((n) => n + 1)} />
                      <div className="check-rerun-actions">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            stale || rerunning || requested || !detail.job.canRerun || detail.job.status !== 'completed'
                          }
                          onClick={() => void rerun(displayedCheck.conclusion === 'cancelled' ? 'all' : 'failed')}
                        >
                          {displayedCheck.conclusion === 'cancelled'
                            ? 'Re-run cancelled workflow'
                            : 'Re-run failed jobs'}
                        </Button>
                        {displayedCheck.conclusion !== 'cancelled' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={
                              stale ||
                              rerunning ||
                              requested ||
                              !detail.job.canRerun ||
                              detail.job.status !== 'completed'
                            }
                            onClick={() => void rerun('all')}
                          >
                            Re-run all jobs
                          </Button>
                        )}
                      </div>
                      <p className="checks-notice">
                        Applies to this workflow run.{' '}
                        {!detail.job.canRerun && 'Repository write access is required to rerun jobs.'}
                      </p>
                      {rerunMessage && <p role="status">{rerunMessage}</p>}
                    </>
                  )}
                  {!!detail.annotations.length && (
                    <section className="check-annotations">
                      <h3>Annotations ({detail.annotations.length})</h3>
                      {detail.annotations.map((a, i) => (
                        <article key={i}>
                          <strong>{a.title || a.level}</strong>
                          <button
                            onClick={() =>
                              onSource(selected.snapshot.url, a.path, a.startLine, selected.snapshot.headSha)
                            }
                          >
                            {a.path}:{a.startLine}
                            {a.endLine !== a.startLine ? `–${a.endLine}` : ''}
                          </button>
                          <a
                            href={`${selected.snapshot.url.replace(/\/pull\/\d+$/, '')}/blob/${selected.snapshot.headSha}/${a.path.split('/').map(encodeURIComponent).join('/')}#L${a.startLine}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Source on GitHub <ExternalLink size={12} />
                          </a>
                          <p>{a.message}</p>
                        </article>
                      ))}
                    </section>
                  )}
                  {detail.job && (
                    <section className="check-logs">
                      <h3>Job log</h3>
                      <Button size="sm" variant="outline" disabled={logBusy} onClick={() => void loadLog()}>
                        {logBusy ? 'Loading log…' : log ? 'Reload log' : 'Load log'}
                      </Button>
                      {logError && (
                        <p role="alert" className="checks-error">
                          {logError}
                        </p>
                      )}
                      {log && (
                        <>
                          {log.truncated && (
                            <p className="checks-notice">Showing the first 2 MB. Open GitHub for the complete log.</p>
                          )}
                          <pre tabIndex={0} aria-label="Job log">
                            {log.text || 'No log output.'}
                          </pre>
                        </>
                      )}
                    </section>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
