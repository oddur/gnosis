import { LoadingState, LoadingIndicator } from './LoadingState';
import { WorkspaceIcon } from './WorkspaceIcon';
import { usePrReadVisit } from '../lib/pr-read-context';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ExplanationBuild, taskSteps, type ExplanationRowActions } from './ExplanationBuild';
import { inspectionData } from '../lib/inspection-cache';
import { GITHUB_PR_FILE_LIMIT } from '../lib/inspection-limits';
import { ReviewPage } from '../src/pages/ReviewPage';
import { ReviewDraftBoundary, useSessionDraft } from '../lib/session-drafts';
import { loadExplanation, peekExplanation, type ExplanationDestination } from '../lib/explanation-workspace';
import { fingerprint, subjectForReview, type QueueItem } from '../lib/workbench';
import { PROVIDERS } from '../lib/models';
import type { Preferences, ReviewGuide, ReviewHistoryEntry } from '../lib/types';
import { Button } from './ui/button';
import { readReviewState } from '../lib/renderer-review-state';
import { explanationPositionKey } from '../lib/use-explanation-scroll';
import { isActiveTask, type ActivityTask } from '../lib/activity';
import { countRender } from '../lib/render-count';

export function PrExplanation({
  item,
  entries,
  destination,
  preferences,
  active,
  starting,
  error,
  onGenerate,
  onAiSetup,
  onGitHubAuth,
  onShowActivity,
  onBack,
  onOpenChanges,
}: {
  item: QueueItem;
  entries: ReviewHistoryEntry[];
  destination?: ExplanationDestination;
  preferences: Preferences | null;
  active: boolean;
  starting: boolean;
  error: string;
  onGenerate: (previousReviewId?: string) => void;
  onAiSetup?: () => void;
  onGitHubAuth?: () => void;
  onShowActivity: () => void;
  onBack: () => void;
  onOpenChanges: () => void;
}) {
  countRender('PrExplanation');
  useSyncExternalStore(inspectionData.subscribe, inspectionData.getVersion);
  const limited = item.subject.members.filter((member) => {
    const snapshot = inspectionData.peekChanges(member);
    return (
      (member.changedFileCount ?? 0) > GITHUB_PR_FILE_LIMIT ||
      (snapshot?.metadata.headSha === member.headSha &&
        snapshot.metadata.baseSha === member.baseSha &&
        snapshot.filesTruncated)
    );
  });
  const generate = () => {
    if (!limited.length && !starting && item.review?.status !== 'generating') onGenerate(review?.reviewId ?? item.review?.id);
  };
  const completed =
    entries.find((e) => !e.status || e.status === 'completed') ??
    (item.review?.status === 'completed' ? item.review : undefined);
  const incoming = destination && subjectForReview(destination.review) === item.subject.id ? destination : undefined;
  const [handledDestination, setHandledDestination] = useSessionDraft(`explanation-arrival:${item.subject.id}`, 0);
  const freshIncoming = incoming && incoming.command.nonce !== handledDestination ? incoming : undefined;
  const [selectedId, setSelectedId] = useSessionDraft<string | undefined>(
    `explanation-version:${item.subject.id}`,
    freshIncoming?.review.reviewId ?? completed?.id
  );
  const [review, setReview] = useState<ReviewGuide | undefined>(
    () => freshIncoming?.review ?? peekExplanation(selectedId ?? completed?.id)
  );
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  const [visited, setVisited] = useState(active);
  const [initialSlideId, setInitialSlideId] = useState<string>();
  useEffect(() => {
    if (active) setVisited(true);
  }, [active]);
  useEffect(() => {
    if (!incoming || incoming.command.nonce === handledDestination) return;
    setHandledDestination(incoming.command.nonce);
    setInitialSlideId(undefined);
    setSelectedId(incoming.review.reviewId);
    setReview(incoming.review);
    setLoadError('');
  }, [incoming?.command.nonce]);
  const wanted = selectedId ?? completed?.id;
  useEffect(() => {
    if (!wanted || review?.reviewId === wanted) return;
    let cancelled = false;
    setLoadError('');
    void loadExplanation(wanted)
      .then((next) => {
        if (cancelled) return;
        setReview(next);
        setSelectedId(wanted);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [wanted, retry]);
  usePrReadVisit(
    review
      ? (review.snapshot?.subject.members ?? [{ url: review.prUrl, headSha: review.headSha ?? '' }])
      : !wanted
        ? item.subject.members
        : [],
    active,
    !review && !wanted ? 'empty-explanation' : undefined
  );
  const running = starting || item.review?.status === 'generating';
  const [generationTask, setGenerationTask] = useState<ActivityTask>();
  const [progressUnavailable, setProgressUnavailable] = useState(false);
  const [progressRetry, setProgressRetry] = useState(0);
  const generatingId = item.review?.status === 'generating' ? item.review.id : undefined;
  // A failed build keeps its rows while Activity still has them, so each error shows where it happened.
  const failedId = item.review?.status === 'failed' ? item.review.id : undefined;
  const trackedId = generatingId ?? failedId;
  useEffect(() => {
    // Keep the last rows while retrying progress for the same build, so they do not flash.
    setGenerationTask((previous) => (previous?.reviewId === trackedId ? previous : undefined));
    setProgressUnavailable(false);
    if (!active || !trackedId || (generatingId && !running)) return;
    let alive = true;
    let inFlight = false;
    let dirty = false;
    const refresh = () => {
      if (!alive || document.hidden) return;
      if (inFlight) {
        dirty = true;
        return;
      }
      inFlight = true;
      dirty = false;
      void window.electronAPI
        .listActivity()
        .then((tasks) => {
          if (!alive || dirty) return;
          const next = tasks.find(
            (task) =>
              task.kind === 'review' && task.reviewId === trackedId && (generatingId ? isActiveTask(task) : task.status === 'failed')
          );
          setGenerationTask((previous) =>
            previous === next || (previous && next && JSON.stringify(previous) === JSON.stringify(next)) ? previous : next
          );
          setProgressUnavailable(false);
        })
        .catch(() => {
          if (alive) setProgressUnavailable(true);
        })
        .finally(() => {
          inFlight = false;
          if (dirty) refresh();
        });
    };
    const subscription = window.electronAPI.onActivityChanged?.(() => refresh());
    const stop = typeof subscription === 'function' ? subscription : undefined;
    const resume = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener('visibilitychange', resume);
    refresh();
    const timer = setInterval(() => refresh(), stop ? 30_000 : 2000);
    return () => {
      alive = false;
      stop?.();
      document.removeEventListener('visibilitychange', resume);
      clearInterval(timer);
    };
  }, [running, active, generatingId, trackedId, progressRetry]);
  const currentTask = generationTask && generationTask.reviewId === generatingId ? generationTask : undefined;
  const failedTask = generationTask && generationTask.reviewId === failedId ? generationTask : undefined;
  // Before the first read, show the stages from the saved entry rather than a blank pane.
  const buildTask = useMemo<ActivityTask | undefined>(() => {
    const task = currentTask ?? failedTask;
    if (task) return task.startedAt ? task : { ...task, startedAt: item.review?.savedAt };
    if (!running) return undefined;
    return {
      id: `review:${generatingId ?? 'starting'}`,
      kind: 'review',
      title: item.subject.title,
      detail: 'Preparing review',
      status: 'running',
      reviewId: generatingId,
      startedAt: item.review?.status === 'generating' ? item.review.savedAt : undefined,
      updatedAt: new Date().toISOString(),
      canCancel: false,
      canRetry: false,
    };
  }, [currentTask, failedTask, running, generatingId, item.review?.status, item.review?.savedAt, item.subject.title]);
  const [taskPending, setTaskPending] = useState(false);
  const [taskError, setTaskError] = useState('');
  const taskAction = useCallback(
    (action: 'cancel' | 'retry') => {
      if (!buildTask || taskPending) return;
      setTaskPending(true);
      setTaskError('');
      window.electronAPI
        .activityAction(buildTask.id, action)
        .catch((e: unknown) => setTaskError(e instanceof Error ? e.message : String(e)))
        .finally(() => {
          setTaskPending(false);
          setProgressRetry((n) => n + 1);
        });
    },
    [buildTask, taskPending]
  );
  // Read early: finished topics open in the reader while the rest are written.
  const [reading, setReading] = useState<{ slideId: string; nonce: number }>();
  const [draft, setDraft] = useState<ReviewGuide>();
  const [showProgress, setShowProgress] = useState(false);
  const writtenTopics = currentTask
    ? (taskSteps(currentTask)
        .find((step) => step.id === 'topics')
        ?.subtasks?.filter((topic) => topic.status === 'done').length ?? 0)
    : 0;
  useEffect(() => {
    if (!reading || !generatingId) return;
    let cancelled = false;
    window.electronAPI
      .loadDraftReview(generatingId)
      .then((next) => {
        if (!cancelled && next) setDraft(next);
      })
      .catch((e: unknown) => {
        if (!cancelled) setTaskError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [!!reading, generatingId, writtenTopics]);
  // The finished explanation replaces the draft in place, keeping the reader and its position.
  useEffect(() => {
    if (!draft?.reviewId || item.review?.id !== draft.reviewId) return;
    if (item.review.status === 'completed') {
      let cancelled = false;
      void loadExplanation(draft.reviewId)
        .then((next) => {
          if (cancelled) return;
          setSelectedId(next.reviewId);
          setReview(next);
          setDraft(undefined);
          setReading(undefined);
        })
        .catch((e: unknown) => {
          if (!cancelled) setLoadError(String(e));
        });
      return () => {
        cancelled = true;
      };
    }
    if (item.review.status === 'failed') {
      setDraft(undefined);
      setReading(undefined);
    }
  }, [item.review?.status, item.review?.id, draft?.reviewId]);
  const rowActions = useMemo<ExplanationRowActions>(
    () => ({
      onRead: (slideId) => {
        setShowProgress(false);
        setReading({ slideId, nonce: Date.now() });
      },
      onRetry: () => taskAction('retry'),
      pending: taskPending,
    }),
    [taskAction, taskPending]
  );
  const subject =
    item.subject.kind === 'stack'
      ? item.subject.title
      : `#${item.subject.members[0]?.number ?? ''} ${item.subject.members[0]?.title ?? item.subject.title}`;
  const generationStage = progressUnavailable
    ? 'Progress unavailable'
    : currentTask?.detail || 'Generating explanation…';
  const topicProgress =
    !progressUnavailable &&
    currentTask?.detail === 'Writing topics' &&
    currentTask.progress &&
    currentTask.progress.total > 0
      ? `${currentTask.progress.completed} of ${currentTask.progress.total} ${currentTask.progress.total === 1 ? 'topic' : 'topics'} complete`
      : undefined;
  const generationStatus = [generationStage, topicProgress].filter(Boolean).join(' · ');
  // Stays on the draft until the saved explanation replaces it, so the reader is never remounted.
  const readingDraft = !!(reading && draft && draft.reviewId === item.review?.id);
  const shownReview = readingDraft ? draft : review;
  const emptyGeneration = running && !shownReview && !error && !loadError;
  const failed = item.review?.status === 'failed';
  const failureMessage = item.review?.error?.trim();
  // A failed first build shows its stages and each error inline, while Activity still has them.
  const failedBuild = failed && !review && !error && !loadError && !!failedTask;
  const newer = completed && review && completed.id !== review.reviewId;
  const changed = review && (!review.snapshot || review.snapshot.fingerprint !== fingerprint(item.subject));
  async function openUpdated() {
    if (!completed) return;
    try {
      const next = await loadExplanation(completed.id);
      let previousPosition = 0;
      try {
        previousPosition = Number(
          readReviewState(
            explanationPositionKey(
              `${review?.reviewId ?? review?.prUrl}:${review?.snapshot?.fingerprint ?? review?.headSha ?? ''}`,
              'inspected'
            )
          ) ??
            localStorage.getItem(`gnosis-position:${item.subject.id}:${review?.reviewId}`) ??
            0
        );
      } catch {
        // Optional reading position must not prevent opening a successfully loaded explanation.
      }
      const previous = review?.slides.find((s) => s.slideNumber === previousPosition);
      const corresponding = previous && next.slides.find((s) => s.id === previous.id || s.title === previous.title);
      setInitialSlideId(corresponding?.id ?? 'overview');
      setSelectedId(completed.id);
      setReview(next);
      setLoadError('');
    } catch (e) {
      setLoadError(String(e));
    }
  }
  const provider = preferences && PROVIDERS[preferences.provider];
  const model = provider?.models.find((m) => m.id === preferences?.model)?.label ?? preferences?.model;
  const unavailableNotice = progressUnavailable && (
    <p className="explanation-build-notice" role="status">
      Progress unavailable. Generation may still be running; retry to check its progress.
    </p>
  );
  const buildControls = (task: ActivityTask) => (
    <>
      {progressUnavailable && (
        <Button size="sm" onClick={() => setProgressRetry((n) => n + 1)}>
          Retry progress
        </Button>
      )}
      {task.canRetry && (
        <Button size="sm" disabled={taskPending} onClick={() => taskAction('retry')}>
          Retry explanation
        </Button>
      )}
      {failed && !task.canRetry && (
        <Button size="sm" onClick={generate} disabled={limited.length > 0}>
          Retry generation
        </Button>
      )}
      {task.canCancel && (
        <Button variant="ghost" size="sm" disabled={taskPending} onClick={() => taskAction('cancel')}>
          Cancel
        </Button>
      )}
      <Button variant="outline" size="sm" onClick={onShowActivity}>
        View activity
      </Button>
      {taskError && (
        <span className="explanation-build-error" role="alert">
          {taskError}
        </span>
      )}
    </>
  );
  return (
    <div className="pr-explanation-workspace">
      {limited.length > 0 && (
        <div className="explanation-status" role="status">
          <span>
            A complete explanation is unavailable: {limited.map((m) => `PR #${m.number}`).join(', ')} exceeds GitHub’s
            3,000-file limit. Inspect the available files in Changes, open a smaller PR, or review a local checkout.
          </span>
          <Button variant="outline" size="sm" onClick={onOpenChanges}>
            <WorkspaceIcon tab="changes" />
            Open Changes
          </Button>
        </div>
      )}
      {!emptyGeneration && !failedBuild && (running || newer || changed || failed || error || loadError) && (
        <div className="explanation-status" role={error || loadError ? 'alert' : 'status'}>
          <span>
            {error ||
              loadError ||
              (running ? (
                <LoadingIndicator announce={false}>
                  {readingDraft ? `Reading early · ${generationStatus}` : generationStatus}
                </LoadingIndicator>
              ) : failed ? (
                failureMessage ? (
                  `The explanation failed: ${failureMessage}${review ? ' Your saved version is still available.' : ''}`
                ) : review ? (
                  'The explanation stopped before it finished. Your saved version is still available.'
                ) : (
                  'The explanation stopped before it finished. Try generating it again.'
                )
              ) : newer ? (
                'Updated explanation ready.'
              ) : (
                'This explanation covers an earlier version of the PR.'
              ))}
          </span>
          {running && progressUnavailable && (
            <Button size="sm" onClick={() => setProgressRetry((n) => n + 1)}>
              Retry progress
            </Button>
          )}
          {running && buildTask && (
            <Button
              variant="outline"
              size="sm"
              aria-expanded={showProgress}
              aria-controls="explanation-build-inline"
              onClick={() => setShowProgress((open) => !open)}
            >
              {showProgress ? 'Hide progress' : 'Show progress'}
            </Button>
          )}
          {running ? (
            <Button variant="outline" size="sm" onClick={onShowActivity}>
              View activity
            </Button>
          ) : loadError ? (
            <Button variant="outline" size="sm" onClick={() => (newer ? void openUpdated() : setRetry((n) => n + 1))}>
              Retry loading
            </Button>
          ) : newer ? (
            <Button size="sm" onClick={() => void openUpdated()}>
              Open updated explanation
            </Button>
          ) : (
            <Button size="sm" onClick={generate} disabled={limited.length > 0}>
              {failed || error ? 'Retry generation' : 'Update explanation'}
            </Button>
          )}
          {error && onGitHubAuth && /GitHub|token|access/i.test(error) && (
            <Button variant="ghost" size="sm" onClick={onGitHubAuth}>
              Check GitHub access
            </Button>
          )}
        </div>
      )}
      {running && showProgress && !emptyGeneration && buildTask && (
        <div className="explanation-build-inline" id="explanation-build-inline">
          <ExplanationBuild task={buildTask} subject={subject} actions={rowActions} notice={unavailableNotice}>
            {buildControls(buildTask)}
          </ExplanationBuild>
        </div>
      )}
      {(emptyGeneration || failedBuild) && buildTask ? (
        <div className="explanation-generating">
          <ExplanationBuild task={buildTask} subject={subject} actions={rowActions} notice={unavailableNotice}>
            {buildControls(buildTask)}
          </ExplanationBuild>
        </div>
      ) : shownReview && visited ? (
        <ReviewDraftBoundary
          value={`${shownReview.reviewId ?? shownReview.prUrl}:${shownReview.snapshot?.fingerprint ?? shownReview.headSha ?? ''}`}
        >
          <ReviewPage
            key={shownReview.reviewId ?? shownReview.prUrl}
            review={shownReview}
            embedded
            active={active}
            initialPreferences={preferences ?? undefined}
            onBack={onBack}
            onReReview={generate}
            regenerating={running}
            onShowDraftProgress={readingDraft ? () => setShowProgress(true) : undefined}
            onShowActivity={onShowActivity}
            onOpenChanges={onOpenChanges}
            initialSlideId={readingDraft ? reading.slideId : initialSlideId}
            commandDestination={
              readingDraft && draft.reviewId
                ? { destination: { kind: 'review', reviewId: draft.reviewId, slideId: reading.slideId }, nonce: reading.nonce }
                : incoming?.review.reviewId === shownReview.reviewId
                  ? incoming?.command
                  : undefined
            }
          />
        </ReviewDraftBoundary>
      ) : (
        !shownReview && (
          <div className="explanation-empty">
            {wanted && !loadError ? (
              <LoadingState title="Opening saved explanation…" />
            ) : loadError ? (
              <>
                <h2>Saved explanation could not be opened</h2>
                <p>Retry loading to open the saved explanation.</p>
              </>
            ) : (
              !running &&
              !failed &&
              !error && (
                <>
                  <h2>No explanation yet</h2>
                  <p>
                    {item.subject.kind === 'stack'
                      ? `Read the changes across all ${item.subject.members.length} PRs, with each topic beside its code.`
                      : 'Read the changes by topic, with the relevant code beside each explanation.'}
                  </p>
                </>
              )
            )}
            {!wanted && !running && !failed && !error && (
              <div className="explanation-empty-actions">
                <Button onClick={generate} disabled={!preferences || limited.length > 0}>
                  Generate explanation
                </Button>
                <span>
                  {provider?.label} · {model}
                </span>
              </div>
            )}
            {!wanted && !running && onAiSetup && (
              <button className="workbench-help-link" onClick={onAiSetup}>
                AI setup
              </button>
            )}
          </div>
        )
      )}
    </div>
  );
}
