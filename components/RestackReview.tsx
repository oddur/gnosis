import { LoadingIndicator } from './LoadingState';
import { PrStateIcon } from './PrStateIcon';
import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { CodeView } from '@pierre/diffs/react';
import { ArrowRight, CheckCheck, RotateCcw } from 'lucide-react';
import { Button } from './ui/button';
import { ConflictDiff } from './ConflictDiff';
import { conflictLabels, savedBlockEdits, type BlockEdits, type BlockPick } from '../lib/conflict-blocks';
import { fileWriter, resolverBaseline } from '../lib/conflict-diff';
import type { Preferences } from '../lib/types';
import { StepCard } from './StepCard';
import { BranchBadge, PrBadge } from './EntityBadge';
import type { ConflictRequest, ConflictSession, SavedBlockEdit } from '../lib/conflict-resolution';
import { markersLeft } from '../lib/conflict-carry';
import { preparedDraft, unchosenConflicts, waitingHint } from '../lib/conflict-verify';
import { verdictKey } from '../lib/conflict-verdict-key';
import { useDisabledLanguages } from '../lib/use-syntax-contents';
import { restackSteps } from '../lib/action-steps';

const prNumber = (url: string) => Number(url.split('/').pop());
/** A paused draft and your in-place edits made with it (#509). */
interface DraftEdits {
  text: string;
  edits: BlockEdits;
}
/** Your new edits of a paused file; the drafts they go with are added as the draft changes (update). */
const editsEntry = (
  entry: { original: string; drafts: DraftEdits[] } | undefined,
  original: string,
  edits: BlockEdits
) => ({ original, edits, drafts: entry?.original === original ? entry.drafts : [] });
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
/** Why no update needs a tick: each replayed cleanly, or the checks merged every conflict in it, or some of each. */
function noReviewSummary(branches: { merged?: number }[]) {
  const checked = branches.filter((branch) => branch.merged).length;
  const clean = branches.length - checked;
  if (!checked) return `${clean === 1 ? 'The update' : `All ${clean} updates`} replayed cleanly`;
  if (!clean) return 'The checks merged every conflict';
  const others = checked === 1 ? 'the other' : `the other ${checked}`;
  return `${plural(clean, 'update')} replayed cleanly, and the checks merged every conflict in ${others}`;
}
/** A paused file whose proposals have no verdict: the checks could not run, and the restack does not run them again. */
const UNCHECKED = { merged: false, note: 'Gnosis couldn’t check this result. Check it yourself.' };

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
  preferences,
}: {
  session: ConflictSession;
  busy: boolean;
  onPrepare: () => void;
  onPublish: (token: string, reviewed: string[]) => void;
  onContinue: () => void;
  onSave: (
    path: string,
    contents: string,
    resolved: boolean,
    picks?: ('ours' | 'theirs' | 'both' | 'proposal' | null)[],
    edits?: (SavedBlockEdit | null)[]
  ) => void;
  onDrafts: (drafts: Record<string, string>) => void;
  /** Reads the branches again. Used after a failed push, which is never resent automatically. */
  onRecheck?: () => void;
  /** Restacking is optional; skipping leaves the dependent PRs unchanged. */
  onSkip?: () => void;
  error?: string;
  failedKind?: ConflictRequest['kind'];
  options: ComponentProps<typeof CodeView>['options'];
  /** The reader's diff preferences: a paused file shows in the Conflicts view's diff (#445 item 11). */
  preferences?: Preferences | null;
}) {
  const plan = session.restack;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // The same languages the main workspace keys its verdicts with (lib/use-syntax-contents.ts).
  const disabled = useDisabledLanguages(preferences);
  // Your Keep choices per paused file, so one whose text equals the proposal reads as yours, not Merged.
  const [picks, setPicks] = useState<Partial<Record<string, (BlockPick | undefined)[]>>>({});
  // Your in-place edits per paused file (#445 item 11), kept across saves while the file's conflict is the same, so an
  // edited conflict keeps its card and its Undo. Edits belong to the draft they were made with (#509): the last few
  // drafts are kept with theirs, so a save of another file, which drops unsaved text, shows the saved draft with its own
  // edits. A draft none of them was made with shows the edits saved with it.
  const [edits, setEdits] = useState<
    Partial<Record<string, { original: string; edits: BlockEdits; drafts: DraftEdits[] }>>
  >({});
  const [wholeShown, setWholeShown] = useState<Partial<Record<string, boolean>>>({});
  useEffect(() => {
    setDrafts({});
    onDrafts({});
    setPicks({});
  }, [session.version]);
  // One pause: the commit being replayed in one PR. Continue reuses the plan's token, so the pause is named by its commit
  // and PR too: the next pause starts with no editor open, no unsaved text and no edits of the last one.
  const pause = plan?.blocked ? `${plan.token}:${plan.blocked.url}:${plan.blocked.commit ?? ''}` : '';
  useEffect(() => {
    setEdits({});
    setWholeShown({});
  }, [pause]);
  const [review, setReview] = useState<{ token: string; urls: string[] }>({ token: '', urls: [] });
  const [confirming, setConfirming] = useState('');
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
  // An update whose replay the checks merged whole, or replayed without a conflict, needs no tick (#445 item 21).
  const needsReview = plan?.branches.filter((branch) => branch.review !== false) ?? [];
  const allReviewed = needsReview.every((branch) => reviewed.includes(branch.url));
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
              continueDisabled: !plan || !allReviewed,
            }
          : {
              onContinue: () => plan && onPublish(plan.token, reviewed),
              continueLabel: running ? 'Updating branches…' : `Push ${plan?.branches.length ?? 0} PR updates`,
              continueDisabled: !plan || !allReviewed || failedKind === 'restack-publish',
            };
  return (
    <StepCard
      className="restack-review"
      compactSteps={!!plan}
      diffScroller
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
          ? !needsReview.length
            ? `${noReviewSummary(plan.branches)} · Nothing pushed yet`
            : allReviewed
              ? `${needsReview.length === plan.branches.length ? 'All ' : ''}${plural(needsReview.length, 'PR update')} reviewed · Nothing pushed yet`
              : `${needsReview.filter((branch) => reviewed.includes(branch.url)).length} of ${plural(needsReview.length, 'PR update')} reviewed · Mark each update reviewed to continue`
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
          Restack {count} dependent {count === 1 ? 'PR' : 'PRs'} in order onto the resolved branch. Resolutions you
          saved for the same conflicts are reused. Preparing pushes nothing.
        </p>
      ) : step.id === 'resolve' && plan?.blocked ? (
        <div className="restack-blocked">
          <div className="restack-blocked-lead">
            <h3>New resolution needed · #{prNumber(plan.blocked.url)}</h3>
            <p>{plan.blocked.reason}</p>
          </div>
          {plan.blocked.files.map((file) => {
            const value = drafts[file.path] ?? file.result;
            const dirty = value !== file.result;
            const markers = markersLeft(file, value);
            const update = (text: string) => {
              const next = { ...drafts, [file.path]: text };
              setDrafts(next);
              onDrafts(next);
              // Your edits go with this draft (#509).
              setEdits((previous) => {
                const entry = previous[file.path];
                if (!entry) return previous;
                const drafts = [{ text, edits: entry.edits }, ...entry.drafts.filter((d) => d.text !== text)].slice(0, 4);
                return { ...previous, [file.path]: { ...entry, drafts } };
              });
            };
            const filePicks = picks[file.path] ?? file.picks?.map((pick) => pick ?? undefined);
            const whole = file.wholeFile;
            const savedPicks = filePicks && Array.from(filePicks, (pick) => pick ?? null);
            const entry = edits[file.path];
            // Your edits as you make them, while the draft on screen is the one they were made with; else the ones saved
            // with the paused draft (#509).
            const fileEdits =
              (entry?.original === file.original ? entry.drafts.find((d) => d.text === value)?.edits : undefined) ??
              file.edits;
            // Reset file returns to what the replay proposed, as in the main workspace: after Use this result too.
            // Only the proposals nobody has to choose (the checks' Merged ones) are in place; the rest wait on their cards.
            const resetTarget = preparedDraft(file, file.verdict?.verdict);
            // Mark reviewed waits for a choice on every conflict in Check, as in the main workspace (fail closed).
            // Only a verdict made for this draft counts, as in the service's guard; a stale one Merges nothing.
            const current =
              file.verdict?.key === verdictKey({ ...file, result: value }, disabled)
                ? file.verdict.verdict
                : undefined;
            const unchosen = unchosenConflicts(file, value, current, filePicks, fileEdits);
            const reset = () => {
              setPicks((previous) => ({ ...previous, [file.path]: [] }));
              setEdits((previous) => ({ ...previous, [file.path]: editsEntry(previous[file.path], file.original, []) }));
              setWholeShown((previous) => ({ ...previous, [file.path]: false }));
              update(resetTarget);
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
                          ? 'Conflicts left'
                          : 'Resolved · needs review'}
                  </span>
                </h4>
                {file.unsupported ? (
                  <p role="alert">{file.unsupported}</p>
                ) : (
                  <>
                    {/* The same view as the main resolution: Changes' diff with each conflict's card under its
                        lines, Compare with, the resolver's marks and Edit in place (#445 items 8 to 11). */}
                    <ConflictDiff
                      key={`${file.path}:${pause}`}
                      kind="restack"
                      name={file.path}
                      ours={file.ours}
                      theirs={file.theirs}
                      fileKey={`restack:${session.id}:${plan.token}:${file.path}`}
                      preferences={preferences}
                      original={file.original}
                      contents={value}
                      labels={labels}
                      disabled={busy}
                      onChange={update}
                      proposals={file.proposals}
                      verdict={file.verdict?.verdict ?? (file.proposals || file.wholeFile ? UNCHECKED : undefined)}
                      note={file.structuralNote}
                      picks={filePicks}
                      onPick={(index, choice) => {
                        const next = [...(filePicks ?? [])];
                        next[index] = choice;
                        setPicks((previous) => ({ ...previous, [file.path]: next }));
                      }}
                      edits={fileEdits}
                      onEdits={(next) =>
                        setEdits((previous) => ({
                          ...previous,
                          [file.path]: editsEntry(previous[file.path], file.original, next),
                        }))
                      }
                      resolverText={resolverBaseline(file, value)}
                      writer={fileWriter(file)}
                      wholeFile={
                        whole && value === file.original
                          ? {
                              proposal: whole,
                              ours: file.ours,
                              theirs: file.theirs,
                              // The whole-file result replaces every choice in the file, as in the main workspace.
                              onUse: () => {
                                setPicks((previous) => ({ ...previous, [file.path]: [] }));
                                setEdits((previous) => ({ ...previous, [file.path]: undefined }));
                                update(whole.text);
                              },
                              shown: wholeShown[file.path] === true,
                              onShow: () => setWholeShown((previous) => ({ ...previous, [file.path]: true })),
                            }
                          : undefined
                      }
                    />
                    <div className="restack-conflict-actions">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || markers || unchosen.length > 0 || (file.resolved && !dirty)}
                        onClick={() => onSave(file.path, value, true, savedPicks, savedBlockEdits(fileEdits))}
                      >
                        Mark reviewed
                      </Button>
                      {unchosen.length > 0 && (
                        <span className="restack-conflict-hint" role="status" data-restack-unchosen="">
                          {waitingHint(file, value, unchosen.length)}
                        </span>
                      )}
                      {value !== resetTarget && (
                        <Button size="sm" variant="ghost" disabled={busy} data-restack-reset="" onClick={reset}>
                          <RotateCcw aria-hidden="true" />
                          Reset file
                        </Button>
                      )}
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
              Review each branch update below. Restacking changes commit IDs and can dismiss GitHub approvals. Gnosis
              didn’t run your tests.
            </p>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onPrepare}>
              Prepare again
            </Button>
          </div>
          {plan.branches.map((branch, index) => {
            const open = expanded[branch.url] ?? index === 0;
            const merged = branch.review === false;
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
                    <PrStateIcon pr={{ url: branch.url }} size={14} />
                    <span>
                      #{prNumber(branch.url)} {branch.title}
                    </span>
                  </button>
                  {merged ? (
                    <span className="restack-merged conflict-bucket" data-bucket="merged">
                      <CheckCheck size={13} aria-hidden="true" />
                      {branch.merged ? 'Merged and checked · No review needed' : 'Replayed cleanly · No review needed'}
                    </span>
                  ) : (
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
                  )}
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
                      {branch.merged ? ` · ${plural(branch.merged, 'conflict')} merged and checked` : ''}
                      {branch.yours ? ` · ${plural(branch.yours, 'conflict')} resolved by you` : ''}
                    </p>
                    {branch.merges ? (
                      <p className="restack-merges">
                        Recreated {plural(branch.merges, 'merge commit')}; check that nothing they added was lost.
                      </p>
                    ) : null}
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
                <PrStateIcon pr={{ url: branch.url }} size={14} className="restack-confirm-state" />
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
