import { LoadingIndicator } from './LoadingState';
import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { CodeView, EditProvider } from '@pierre/diffs/react';
import { ArrowRight } from 'lucide-react';
import { Button } from './ui/button';
import { ConflictView, ResultEditor, createEditor } from './ConflictBlocks';
import { conflictLabels } from '../lib/conflict-blocks';
import { StepCard } from './StepCard';
import { BranchBadge, PrBadge } from './EntityBadge';
import { hasConflictMarkers, type ConflictRequest, type ConflictSession } from '../lib/conflict-resolution';
import { restackSteps } from '../lib/action-steps';

const prNumber = (url: string) => Number(url.split('/').pop());

export function RestackReview({
  session,
  busy,
  onPrepare,
  onPublish,
  onContinue,
  onSave,
  onDrafts,
  onRecheck,
  onSkip,
  error,
  failedKind,
  options,
}: {
  session: ConflictSession;
  busy: boolean;
  onPrepare: () => void;
  onPublish: (token: string, reviewed: string[]) => void;
  onContinue: () => void;
  onSave: (path: string, contents: string, resolved: boolean) => void;
  onDrafts: (drafts: Record<string, string>) => void;
  /** Reads the branches again. Used after a failed push, which is never resent automatically. */
  onRecheck?: () => void;
  /** Restacking is optional; skipping leaves the dependent PRs unchanged. */
  onSkip?: () => void;
  error?: string;
  failedKind?: ConflictRequest['kind'];
  options: ComponentProps<typeof CodeView>['options'];
}) {
  const plan = session.restack;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  useEffect(() => {
    setDrafts({});
    onDrafts({});
  }, [session.version]);
  const [review, setReview] = useState<{ token: string; urls: string[] }>({ token: '', urls: [] });
  const [confirming, setConfirming] = useState('');
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const blockedBranch = plan?.blocked ? plan.expected.find((entry) => entry.url === plan.blocked?.url) : undefined;
  const labels = useMemo(
    () =>
      conflictLabels('restack', {
        head: blockedBranch?.headBranch ?? 'this PR',
        base: blockedBranch?.baseBranch ?? 'the parent',
      }),
    [blockedBranch?.headBranch, blockedBranch?.baseBranch]
  );
  // Keep a resolved pause in the plan, so the step list does not shrink after Continue restack.
  const paused = useRef(new Set<string>());
  if (plan?.status === 'blocked') paused.current.add(plan.token);
  const reviewed = review.token === plan?.token ? review.urls : [];
  const published = plan?.status === 'published';
  const count = session.dependents?.length ?? 0;
  const running = busy && !error;
  const failureStep =
    failedKind === 'restack-prepare'
      ? plan?.status === 'blocked'
        ? 'resolve'
        : 'rebase'
      : failedKind === 'restack-continue' || failedKind === 'restack-save'
        ? 'resolve'
        : failedKind === 'restack-publish'
          ? 'push'
          : undefined;
  const isConfirming = !!plan && confirming === plan.token && plan.status === 'prepared';
  const steps = restackSteps(session, {
    confirming: isConfirming || failureStep === 'push',
    paused: !!plan && paused.current.has(plan.token),
    running,
    failure:
      error && failureStep
        ? {
            step: failureStep,
            message:
              failureStep === 'push'
                ? `${error} Check the branches again before retrying; Gnosis does not resend the push.`
                : error,
          }
        : undefined,
  });
  const step = steps.steps[steps.current];
  const blockedReady =
    plan?.blocked?.files.every(
      (file) =>
        file.resolved && !file.unsupported && !(Object.hasOwn(drafts, file.path) && drafts[file.path] !== file.result)
    ) ?? false;
  const continueProps = published
    ? {}
    : step.id === 'rebase'
      ? {
          onContinue: onPrepare,
          continueLabel: running ? (
            <LoadingIndicator announce={false}>Preparing restack…</LoadingIndicator>
          ) : (
            `Prepare restack · ${count} PRs`
          ),
          continueDisabled: !count,
        }
      : step.id === 'resolve'
        ? { onContinue, continueLabel: running ? 'Continuing…' : 'Continue restack', continueDisabled: !blockedReady }
        : step.id === 'review'
          ? {
              onContinue: () => plan && setConfirming(plan.token),
              continueDisabled: !plan || reviewed.length !== plan.branches.length,
            }
          : {
              onContinue: () => plan && onPublish(plan.token, reviewed),
              continueLabel: running ? 'Updating branches…' : `Push ${plan?.branches.length ?? 0} PR updates`,
              continueDisabled: !plan || reviewed.length !== plan.branches.length || failedKind === 'restack-publish',
            };
  return (
    <StepCard
      className="restack-review"
      compactSteps={!!plan}
      title={
        <h2>
          {published
            ? 'Dependent PRs updated'
            : `Restack ${count} dependent ${count === 1 ? 'PR' : 'PRs'} onto ${session.headBranch}`}
        </h2>
      }
      steps={steps.steps}
      current={steps.current}
      busy={busy}
      onSkip={onSkip}
      skipDescription="Leave the dependent PRs unchanged"
      onBack={step.id === 'push' && !published ? () => setConfirming('') : undefined}
      backLabel="Back to review"
      onRetry={
        failureStep === 'push'
          ? onRecheck
          : failedKind === 'restack-continue'
            ? onContinue
            : failedKind === 'restack-prepare'
              ? onPrepare
              : undefined
      }
      retryLabel={failureStep === 'push' ? 'Check again' : 'Retry'}
      status={
        step.id === 'review' && plan
          ? reviewed.length === plan.branches.length
            ? `All ${plan.branches.length} PR updates reviewed · Nothing pushed yet`
            : `${reviewed.length} of ${plan.branches.length} PR updates reviewed · Mark each update reviewed to continue`
          : step.id === 'resolve' && !blockedReady
            ? 'Mark each file reviewed to continue the restack'
            : undefined
      }
      {...continueProps}
    >
      {published ? (
        <p>All prepared branches were pushed together. GitHub will run checks for their new commits.</p>
      ) : step.id === 'rebase' ? (
        <p>
          Rebase {count} dependent {count === 1 ? 'PR' : 'PRs'} in order onto the resolved branch. Matching saved
          resolutions are reused. Preparation does not push anything.
        </p>
      ) : step.id === 'resolve' && plan?.blocked ? (
        <div className="restack-blocked">
          <h3>New resolution needed · #{prNumber(plan.blocked.url)}</h3>
          <p>{plan.blocked.reason}</p>
          {plan.blocked.files.map((file) => {
            const value = drafts[file.path] ?? file.result;
            const dirty = value !== file.result;
            const markers = hasConflictMarkers(value);
            const update = (text: string) => {
              const next = { ...drafts, [file.path]: text };
              setDrafts(next);
              onDrafts(next);
            };
            return (
              <div className="restack-conflict-file" key={file.path}>
                <h4>
                  {file.path}{' '}
                  <span
                    className="conflict-file-status"
                    data-stage={
                      file.unsupported || markers ? 'conflicted' : file.resolved && !dirty ? 'reviewed' : 'resolved'
                    }
                  >
                    {file.unsupported
                      ? 'Needs a local merge tool'
                      : file.resolved && !dirty
                        ? 'Reviewed'
                        : markers
                          ? 'Conflicted'
                          : 'Resolved · needs review'}
                  </span>
                </h4>
                {file.unsupported ? (
                  <p role="alert">{file.unsupported}</p>
                ) : (
                  <>
                    {editing[file.path] ? (
                      <EditProvider createEditor={createEditor}>
                        <ResultEditor
                          key={`${file.path}:${session.version}`}
                          name={file.path}
                          initial={value}
                          onChange={update}
                        />
                      </EditProvider>
                    ) : (
                      <ConflictView
                        key={`${file.path}:${session.version}`}
                        name={file.path}
                        original={file.original}
                        contents={value}
                        labels={labels}
                        disabled={busy}
                        onChange={update}
                      />
                    )}
                    <div className="restack-conflict-actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        aria-pressed={editing[file.path]}
                        onClick={() => setEditing({ ...editing, [file.path]: !editing[file.path] })}
                      >
                        {editing[file.path] ? 'Choose changes' : 'Edit result'}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || markers || (file.resolved && !dirty)}
                        onClick={() => onSave(file.path, value, true)}
                      >
                        Mark reviewed
                      </Button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
          <Button variant="ghost" disabled={busy} onClick={onPrepare}>
            Prepare again
          </Button>
        </div>
      ) : step.id === 'review' && plan ? (
        <>
          <div className="restack-instructions">
            <p>
              Review each branch update below. Rebasing changes commit IDs and can dismiss GitHub approvals. Tests have
              not been run locally.
            </p>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onPrepare}>
              Prepare again
            </Button>
          </div>
          {plan.branches.map((branch, index) => {
            const open = expanded[branch.url] ?? index === 0;
            return (
              <section className="restack-branch" key={branch.url} aria-label={`PR #${prNumber(branch.url)} update`}>
                <div className="restack-branch-header">
                  <button
                    type="button"
                    className="conflict-disclosure"
                    aria-expanded={open}
                    onClick={() => setExpanded({ ...expanded, [branch.url]: !open })}
                  >
                    <ArrowRight size={14} aria-hidden="true" />
                    <span>
                      #{prNumber(branch.url)} {branch.title}
                    </span>
                  </button>
                  <label className="restack-reviewed">
                    <input
                      type="checkbox"
                      checked={reviewed.includes(branch.url)}
                      disabled={busy}
                      onChange={(event) =>
                        setReview({
                          token: plan.token,
                          urls: event.target.checked
                            ? [...reviewed, branch.url]
                            : reviewed.filter((url) => url !== branch.url),
                        })
                      }
                    />
                    Reviewed
                  </label>
                </div>
                {open && (
                  <>
                    <p>
                      <PrBadge url={branch.url} number={prNumber(branch.url)} title={branch.title} />{' '}
                      <BranchBadge branch={branch.branch} repo={branch.repo} /> onto{' '}
                      <BranchBadge branch={branch.baseBranch} repo={branch.baseRepo} /> · {branch.commits} original{' '}
                      {branch.commits === 1 ? 'commit' : 'commits'}
                      {branch.reused
                        ? ` · ${branch.reused} remembered file ${branch.reused === 1 ? 'resolution' : 'resolutions'} reused`
                        : ''}
                    </p>
                    <p className="restack-revisions">
                      <code>{branch.oldSha.slice(0, 7)}</code> → <code>{branch.newSha.slice(0, 7)}</code>
                    </p>
                    {branch.files.length ? (
                      <CodeView
                        className="restack-diff selectable"
                        items={branch.files.map((fileDiff, i) => ({
                          id: `${branch.url}:${i}`,
                          type: 'diff' as const,
                          fileDiff,
                        }))}
                        options={options}
                        style={{
                          height: Math.min(
                            360,
                            Math.max(
                              100,
                              branch.files.reduce(
                                (height, file) =>
                                  height +
                                  60 +
                                  file.hunks.reduce(
                                    (lines, hunk) => lines + Math.max(hunk.additionCount, hunk.deletionCount) + 1,
                                    0
                                  ) *
                                    20,
                                0
                              )
                            )
                          ),
                          overflow: 'auto',
                        }}
                      />
                    ) : (
                      <p>File contents are unchanged. Only commit ancestry changes.</p>
                    )}
                  </>
                )}
              </section>
            );
          })}
        </>
      ) : plan ? (
        <div className="restack-confirm">
          <p>
            One atomic push updates every branch below, or none. Each branch must still be at the commit you reviewed.
          </p>
          <ul>
            {plan.branches.map((branch) => (
              <li key={branch.url}>
                <PrBadge url={branch.url} number={prNumber(branch.url)} title={branch.title} />{' '}
                <BranchBadge branch={branch.branch} repo={branch.repo} /> <code>{branch.oldSha.slice(0, 7)}</code> →{' '}
                <code>{branch.newSha.slice(0, 7)}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </StepCard>
  );
}
