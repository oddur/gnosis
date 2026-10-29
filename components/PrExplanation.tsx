import { usePrReadVisit } from '../lib/pr-read-context';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { inspectionData } from '../lib/inspection-cache';
import { GITHUB_PR_FILE_LIMIT } from '../lib/inspection-limits';
import { ReviewPage } from '../src/pages/ReviewPage';
import { ReviewDraftScope, useSessionDraft } from '../lib/session-drafts';
import { loadExplanation, peekExplanation, type ExplanationDestination } from '../lib/explanation-workspace';
import { fingerprint, subjectForReview, type QueueItem } from '../lib/workbench';
import { PROVIDERS } from '../lib/models';
import type { Preferences, ReviewGuide, ReviewHistoryEntry } from '../lib/types';
import { Button } from './ui/button';

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
  onGenerate: () => void;
  onAiSetup?: () => void;
  onGitHubAuth?: () => void;
  onShowActivity: () => void;
  onBack: () => void;
  onOpenChanges: () => void;
}) {
  useSyncExternalStore(inspectionData.subscribe, inspectionData.getVersion);
  const limited = item.subject.members.filter(member => {
    const snapshot = inspectionData.peekChanges(member);
    return (member.changedFileCount ?? 0) > GITHUB_PR_FILE_LIMIT ||
      (snapshot?.metadata.headSha === member.headSha && snapshot.metadata.baseSha === member.baseSha && snapshot.filesTruncated);
  });
  const generate = () => { if (!limited.length) onGenerate(); };
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
  usePrReadVisit(review ? (review.snapshot?.subject.members ?? [{ url: review.prUrl, headSha: review.headSha ?? '' }]) : !wanted ? item.subject.members : [], active, !review && !wanted ? 'empty-explanation' : undefined);
  const running = starting || item.review?.status === 'generating';
  const failed = item.review?.status === 'failed';
  const newer = completed && review && completed.id !== review.reviewId;
  const changed = review && (!review.snapshot || review.snapshot.fingerprint !== fingerprint(item.subject));
  async function openUpdated() {
    if (!completed) return;
    try {
      const next = await loadExplanation(completed.id);
      let previousPosition = 0;
      try {
        previousPosition = Number(localStorage.getItem(`gnosis-position:${item.subject.id}:${review?.reviewId}`) ?? 0);
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
  return (
    <div className="pr-explanation-workspace">
      {limited.length > 0 && <div className="explanation-status" role="status">
        <span>A complete explanation is unavailable: {limited.map(m => `PR #${m.number}`).join(', ')} exceeds GitHub’s 3,000-file limit.
          {' '}Inspect the available files in Changes, open a smaller PR, or review a local checkout.</span>
        <Button variant="outline" size="sm" onClick={onOpenChanges}>Open Changes</Button>
      </div>}
      {(running || newer || changed || failed || error || loadError) && (
        <div className="explanation-status" role={error || loadError ? 'alert' : 'status'}>
          <span>
            {error ||
              loadError ||
              (running
                ? 'Generating explanation. Keep reviewing while it runs.'
                : failed
                  ? review
                    ? 'The explanation could not be completed. Your saved version is still available.'
                    : 'The explanation could not be completed. Try generating it again.'
                  : newer
                    ? 'Updated explanation ready.'
                    : 'This explanation covers an earlier version of the PR.')}
          </span>
          {running ? (
            <Button variant="outline" size="sm" onClick={onShowActivity}>
              View Activity
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
      {review && visited ? (
        <ReviewDraftScope.Provider
          value={`${review.reviewId ?? review.prUrl}:${review.snapshot?.fingerprint ?? review.headSha ?? ''}`}
        >
          <ReviewPage
            key={review.reviewId ?? review.prUrl}
            review={review}
            embedded
            active={active}
            initialPreferences={preferences ?? undefined}
            onBack={onBack}
            onReReview={generate}
            onShowActivity={onShowActivity}
            onOpenChanges={onOpenChanges}
            initialSlideId={initialSlideId}
            commandDestination={incoming?.review.reviewId === review.reviewId ? incoming?.command : undefined}
          />
        </ReviewDraftScope.Provider>
      ) : (
        !review && (
          <div className="explanation-empty">
            <h2>
              {loadError
                ? 'Saved explanation could not be opened'
                : wanted
                  ? 'Opening saved explanation'
                  : item.subject.kind === 'stack' ? `Understand this ${item.subject.members.length}-PR stack` : 'Understand the changes, step by step'}
            </h2>
            <p>
              {loadError
                ? 'Retry loading to read the explanation saved on this computer.'
                : wanted
                  ? 'Reading the explanation saved on this computer.'
                  : 'Get a guided walkthrough of what changed, why it matters, and where to focus your review. Explore the code, ask questions, and open interactive diagrams alongside it.'}
            </p>
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
            {!wanted && onAiSetup && (
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
