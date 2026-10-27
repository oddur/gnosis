import { useEffect, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, CircleMinus, Clock3, ExternalLink, RefreshCw } from 'lucide-react';
import type { ReviewSubject } from '../lib/workbench';
import {
  checkCounts,
  checkGroup,
  checkLabel,
  orderedChecks,
  type PrChecks,
  type PrCheck,
  type CheckFilter,
  type CheckDetails,
  type CheckLog,
} from '../lib/pr-checks';
import { Markdown } from './Markdown';
import { Button } from './ui/button';
import { timeAgo } from '../lib/utils';
export interface CheckFocus {
  url: string;
  id?: string;
  nonce: number;
}
type Selection = { snapshot: PrChecks; check: PrCheck };
function duration(check: PrCheck) {
  if (!check.startedAt || !check.completedAt) return '';
  const seconds = Math.max(0, Math.round((Date.parse(check.completedAt) - Date.parse(check.startedAt)) / 1000));
  return Number.isFinite(seconds)
    ? seconds < 60
      ? `${seconds}s`
      : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    : '';
}
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
}: {
  subject: ReviewSubject;
  values: Partial<Record<string, PrChecks>>;
  errors: Partial<Record<string, string>>;
  busy: boolean;
  refresh: () => void;
  focus?: CheckFocus;
  onSource: (url: string, path: string, line: number, headSha: string) => void;
}) {
  const operation = useRef(0);
  const [requested, setRequested] = useState(false);
  const [filter, setFilter] = useState<CheckFilter>('all');
  const [selected, setSelected] = useState<Selection>();
  const [details, setDetails] = useState<{ selection: Selection; value: CheckDetails }>();
  const [error, setError] = useState('');
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
    let live = true;
    operation.current++;
    setRequested(false);
    setError('');
    setLog(undefined);
    setLogError('');
    setLogBusy(false);
    setRerunMessage('');
    setRerunning(false);
    if (!selected || selected.check.kind === 'status')
      return () => {
        operation.current++;
      };
    void window.electronAPI
      .getCheckDetails({ url: selected.snapshot.url, headSha: selected.snapshot.headSha, id: selected.check.id })
      .then((value) => {
        if (live) setDetails({ selection: selected, value });
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
      operation.current++;
    };
  }, [selected, attempt]);
  const detail = details && details.selection === selected ? details.value : undefined;
  const selectedMember = selected && subject.members.find((m) => m.url === selected.snapshot.url);
  const latest = selected && values[selected.snapshot.url];
  const stale = !!selected && !!latest && latest.headSha !== selected.snapshot.headSha;
  const updated =
    !!selected &&
    !!latest &&
    (stale ||
      latest.checks.find((c) => c.id === selected.check.id)?.conclusion !== selected.check.conclusion ||
      latest.checks.find((c) => c.id === selected.check.id)?.status !== selected.check.status ||
      latest.checks.find((c) => c.id === selected.check.id)?.completedAt !== selected.check.completedAt);
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
      setRerunMessage('Rerun requested. GitHub will queue the jobs.');
      refresh();
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
        <div role="group" aria-label="Filter checks">
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
                  ? `Needs attention (${counts.attention})`
                  : `Running (${counts.running})`}
            </Button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={refresh}
          disabled={busy}
          aria-label="Refresh checks"
          title="Refresh checks"
        >
          <RefreshCw size={15} className={busy ? 'animate-spin' : undefined} />
        </Button>
      </div>
      <div className="checks-panes">
        <nav className="checks-list" aria-label="Checks by PR">
          {subject.members.map((member) => {
            const snapshot = values[member.url];
            const checks = snapshot ? orderedChecks(snapshot.checks, filter) : [];
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
                  <p className="checks-error" role="status">
                    {snapshot ? 'Showing saved results. ' : ''}
                    {errors[member.url]} <button onClick={refresh}>Retry</button>
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
                    <CheckIcon check={check} />
                    <span className="check-row-content">
                      <strong>{check.name}</strong>
                      <small>
                        {check.provider} · <span className={`check-${checkGroup(check)}`}>{checkLabel(check)}</span>
                      </small>
                    </span>
                    <span className="check-duration">{duration(check)}</span>
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
        <div className="check-detail" aria-label="Selected check details">
          {!selected ? (
            <div className="checks-empty">
              <CircleCheck size={24} />
              <h2>Select a check</h2>
              <p>Choose a result to inspect its output and annotations.</p>
            </div>
          ) : (
            <>
              {updated && (
                <div className="checks-update" role="status">
                  <p>
                    {stale
                      ? `These results are from previous commit ${selected.snapshot.headSha.slice(0, 7)}.`
                      : 'This check has new results.'}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const check =
                        latest.checks.find((c) => c.id === selected.check.id) ??
                        latest.checks.find(
                          (c) =>
                            c.kind === selected.check.kind &&
                            c.name === selected.check.name &&
                            c.provider === selected.check.provider
                        );
                      if (check) setSelected({ snapshot: latest, check });
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
                    <CheckIcon check={selected.check} />
                    {selected.check.name}
                  </h2>
                  <p>
                    {selected.check.provider} ·{' '}
                    <span className={`check-${checkGroup(selected.check)}`}>{checkLabel(selected.check)}</span> ·{' '}
                    {selected.check.required === true
                      ? 'Required'
                      : selected.check.required === false
                        ? 'Optional'
                        : 'Requirement unknown'}
                    {duration(selected.check) && ` · ${duration(selected.check)}`}
                  </p>
                </div>
                {selected.check.url && (
                  <a href={selected.check.url} target="_blank" rel="noopener noreferrer">
                    {selected.check.kind === 'status' ? 'Open provider result' : 'Open on GitHub'}{' '}
                    <ExternalLink size={13} />
                  </a>
                )}
              </header>
              {selected.check.kind === 'status' ? (
                <p>
                  {selected.check.description ||
                    'This provider has not supplied further details. Open its result to investigate.'}
                </p>
              ) : error ? (
                <p className="checks-error" role="alert">
                  {error} <button onClick={() => setAttempt((n) => n + 1)}>Retry details</button>
                </p>
              ) : !detail ? (
                <p role="status">Loading check details…</p>
              ) : (
                <>
                  {detail.warning && <p className="checks-notice">{detail.warning}</p>}
                  {detail.summary && <Markdown>{detail.summary}</Markdown>}
                  {detail.text && (
                    <details className="check-output">
                      <summary>Full check output</summary>
                      <Markdown>{detail.text}</Markdown>
                    </details>
                  )}
                  {!detail.summary && !detail.text && !detail.annotations.length && !detail.job?.steps.length && (
                    <p className="checks-notice">
                      This check did not supply further output. Open GitHub for more details.
                    </p>
                  )}
                  {detail.job && (
                    <>
                      <div className="check-rerun-actions">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            stale || rerunning || requested || !detail.job.canRerun || detail.job.status !== 'completed'
                          }
                          onClick={() => void rerun('failed')}
                        >
                          Re-run failed jobs
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={
                            stale || rerunning || requested || !detail.job.canRerun || detail.job.status !== 'completed'
                          }
                          onClick={() => void rerun('all')}
                        >
                          Re-run all jobs
                        </Button>
                      </div>
                      <p className="checks-notice">
                        Applies to this workflow run.{' '}
                        {!detail.job.canRerun && 'Repository write access is required to rerun jobs.'}
                      </p>
                      {rerunMessage && <p role="status">{rerunMessage}</p>}
                      <h3>Job steps</h3>
                      <ol className="check-steps">
                        {detail.job.steps.map((step) => (
                          <li key={step.number}>
                            <CheckIcon
                              check={{
                                ...selected.check,
                                status:
                                  step.status === 'completed'
                                    ? 'completed'
                                    : step.status === 'in_progress'
                                      ? 'in_progress'
                                      : 'queued',
                                conclusion: step.conclusion,
                              }}
                            />
                            <span>{step.name}</span>
                            <small>{step.conclusion ?? step.status.replaceAll('_', ' ')}</small>
                          </li>
                        ))}
                      </ol>
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
