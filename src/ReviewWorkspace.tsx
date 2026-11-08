import type { GitHubSyncStatusProps } from '../components/GitHubSyncStatus';
import { subjectIcons, workbenchIcons, workspaceSections } from '../lib/interface-icons';

import { homeVisit, reviewVisit, type RecentVisit } from '../lib/recently-viewed';

import { useCommandScope, type AppCommand } from '../lib/command-center';
import type { SearchDestination } from '../lib/command-search';
import { ReviewDraftBoundary } from '../lib/session-drafts';

import type { ActivityTask } from '../lib/activity';
import { memo, useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { HomePage } from './pages/HomePage';
import { ReviewPage } from './pages/ReviewPage';
import { UpdateBanner } from '../components/UpdateBanner';
import type { ReviewGuide } from '../lib/types';
import { toast } from '../components/ui/toast';

import { focusStackPr } from '../lib/stack-workspace';
import { normalizeQueueFilters } from '../lib/queue-filters';
import { isLocalUrl } from '../lib/local-url';
import { rememberExplanation, loadExplanation, type ExplanationDestination } from '../lib/explanation-workspace';
import {
  createNavigationHistory,
  locationKey,
  type AppLocation,
  type HomeLocation,
  type HistoryDirection,
} from '../lib/navigation-history';
import { useHistoryInput } from '../lib/use-history-input';

type Page = 'home' | 'review';

export interface WorkspaceController {
  navigate: (target: SearchDestination) => Promise<void>;
  openRecent: (visit: RecentVisit) => Promise<void>;
  openActivity: (task: ActivityTask) => Promise<void>;
}
interface Props {
  id: string;
  initial?: import('../lib/workspace-tabs').WorkspaceTarget;
  recentlyViewed: ReturnType<typeof import('../lib/recently-viewed').createRecentlyViewed>;
  register: (id: string, controller: WorkspaceController) => () => void;
  onLocation: (id: string, location: AppLocation, title?: string) => void;
  onAccount: (account: string) => void;
  setActivityOpen: (open: boolean) => void;
  onSyncStatus: (status: GitHubSyncStatusProps | undefined) => void;
}
export const ReviewWorkspace = memo(function ReviewWorkspace({
  id,
  initial,
  recentlyViewed,
  register,
  onLocation,
  onAccount,
  setActivityOpen,
  onSyncStatus,
}: Props) {
  const [navigationHistory] = useState(() => createNavigationHistory<AppLocation>(locationKey));
  const [homeRestoration, setHomeRestoration] = useState<{ location: HomeLocation; nonce: number }>();
  const lastHome = useRef<HomeLocation | undefined>(undefined);
  const historyAccount = useRef<string | undefined>(undefined);
  const restorationNonce = useRef(0);
  const pendingHistory = useRef<string | undefined>(undefined);
  const displayedLocation = useRef<AppLocation | undefined>(undefined);
  const cancelHistoryLoad = useCallback(() => {
    if (pendingHistory.current && displayedLocation.current) navigationHistory.restore(displayedLocation.current);
    pendingHistory.current = undefined;
  }, [navigationHistory]);
  const initialRecorded = useRef(false);
  const recordHome = useCallback(
    (home: HomeLocation, mutedUrls?: Set<string>) => {
      if (initial && !initialRecorded.current) {
        const expectsSubject =
          initial.kind === 'review' ||
          (initial.kind === 'home' && (initial.subject || initial.url)) ||
          (initial.kind === 'restore' &&
            (initial.saved.reviewId || initial.saved.home?.subjectId || initial.saved.destination?.url)) ||
          (initial.kind === 'location' && initial.location.page === 'home' && initial.location.home.item);
        if (expectsSubject && !home.item) return;
        initialRecorded.current = true;
      }
      const location: AppLocation = { page: 'home', home };
      onLocation(id, location);
      if (pendingHistory.current) {
        // A new user destination supersedes an in-flight saved-review load.
        if (!displayedLocation.current || locationKey(location) === locationKey(displayedLocation.current)) return;
        navigationVersion.current++;
        pendingHistory.current = undefined;
        navigationHistory.restore(displayedLocation.current);
      }
      if (historyAccount.current !== home.account) {
        navigationHistory.clear();
        historyAccount.current = home.account;
      }
      recentlyViewed.scope(home.account);
      if (mutedUrls) recentlyViewed.hide(mutedUrls);
      recentlyViewed.record(homeVisit(home));
      lastHome.current = home;
      navigationHistory.record(location);
      displayedLocation.current = location;
    },
    [navigationHistory, recentlyViewed, id, onLocation]
  );
  const [homeCommand, setHomeCommand] = useState<{
    destination: Extract<SearchDestination, { kind: 'home' }>;
    nonce: number;
  }>();
  const [reviewCommand, setReviewCommand] = useState<{
    destination: Extract<SearchDestination, { kind: 'review' }>;
    nonce: number;
  }>();
  const [explanationDestination, setExplanationDestination] = useState<ExplanationDestination>();
  const [page, setPage] = useState<Page>('home');
  const [reviewOrigin, setReviewOrigin] = useState<{ name: string; reviews: { id: string; title: string }[] }>({
    name: 'Review queue',
    reviews: [],
  });
  const navigationVersion = useRef(0);

  const [destination, setDestination] = useState<{
    subjectId?: string;
    slideId?: string;
    explore?: boolean;
    nonce: number;
  }>({ nonce: 0 });

  // When a background auto-review completes, the history list will refresh itself
  // via the new-review-in-history event — handled in HomePage.
  const [review, setReview] = useState<ReviewGuide | null>(null);
  const [prefillPrUrl, setPrefillPrUrl] = useState<string | undefined>();
  const [prefillReviewId, setPrefillReviewId] = useState<string>();
  useEffect(() => {
    if (page !== 'review' || !review?.reviewId) return;
    const location: AppLocation = { page: 'review', reviewId: review.reviewId };
    if (pendingHistory.current) return;
    navigationHistory.record(location);
    displayedLocation.current = location;
    onLocation(id, location, review.prTitle);
    const visit = reviewVisit(review);
    if (visit) recentlyViewed.record(visit);
  }, [navigationHistory, recentlyViewed, page, review, id, onLocation]);

  async function moveHistory(direction: HistoryDirection) {
    const target = navigationHistory.move(direction);
    if (!target) return;
    await openHistoryLocation(target);
  }
  async function openHistoryLocation(target: AppLocation, reportError = true) {
    pendingHistory.current = locationKey(target);
    const version = ++navigationVersion.current;
    try {
      // Resolve before replacing the screen, so a missing saved review cannot strand the user.
      const loaded = target.page === 'review' ? await loadExplanation(target.reviewId) : undefined;
      if (version !== navigationVersion.current) return;
      pendingHistory.current = undefined;
      setHomeCommand(undefined);
      setReviewCommand(undefined);
      setExplanationDestination(undefined);
      setPrefillPrUrl(undefined);
      setDestination((d) => ({ nonce: d.nonce + 1 }));
      setActivityOpen(false);
      if (target.page === 'home') {
        setHomeRestoration({ location: target.home, nonce: ++restorationNonce.current });
        setReview(null);
        setPage('home');
      } else if (loaded) {
        setReview(loaded);
        setPage('review');
      }
    } catch (error) {
      if (version !== navigationVersion.current) return;
      pendingHistory.current = undefined;
      if (displayedLocation.current) navigationHistory.restore(displayedLocation.current);
      if (!reportError) throw error;
      toast.add({
        type: 'error',
        title: 'Could not open history item',
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }
  async function openRecent(visit: RecentVisit) {
    if (visit.location.page === 'home' && visit.location.home.account !== historyAccount.current)
      throw new Error('This item belongs to a different GitHub account.');
    await openHistoryLocation(visit.location, false);
  }
  useHistoryInput((direction) => {
    void moveHistory(direction);
  });

  const handleReviewReady = useCallback(
    (r: ReviewGuide) => {
      navigationVersion.current++;
      cancelHistoryLoad();
      setHomeRestoration(undefined);
      setReviewCommand(undefined);
      setHomeCommand(undefined);
      setDestination((d) => ({ nonce: d.nonce + 1 }));
      setPrefillPrUrl(undefined);
      rememberExplanation(r);
      if (isLocalUrl(r.prUrl)) {
        setExplanationDestination(undefined);
        setReview(r);
        setPage('review');
      } else {
        setExplanationDestination({
          review: r,
          command: { destination: { kind: 'review', reviewId: r.reviewId ?? '' }, nonce: Date.now() },
        });
        setPage('home');
      }
    },
    [cancelHistoryLoad]
  );

  async function openActivity(task: ActivityTask) {
    if (task.kind === 'briefing') {
      navigationVersion.current++;
      cancelHistoryLoad();
      setHomeRestoration(undefined);
      setHomeCommand(undefined);
      setDestination((d) => ({ subjectId: task.subjectId, nonce: d.nonce + 1 }));
      setReview(null);
      setPage('home');
      setActivityOpen(false);
      return;
    }
    if (!task.reviewId) throw new Error('This task has no saved review.');
    await navigate({
      kind: 'review',
      reviewId: task.reviewId,
      slideId: task.slideId,
      explore: task.kind === 'exploration',
    });
    setActivityOpen(false);
  }

  function handleBack() {
    navigationVersion.current++;
    cancelHistoryLoad();
    setExplanationDestination(undefined);
    setHomeCommand(undefined);
    setReviewCommand(undefined);
    setReview(null);
    if (lastHome.current) setHomeRestoration({ location: lastHome.current, nonce: ++restorationNonce.current });
    setPage('home');
  }

  function handleReReview(prUrl: string, previousReviewId?: string) {
    setPrefillReviewId(previousReviewId);
    navigationVersion.current++;
    cancelHistoryLoad();
    setHomeRestoration(undefined);
    setExplanationDestination(undefined);
    setHomeCommand(undefined);
    setReviewCommand(undefined);
    setPrefillPrUrl(prUrl);
    setReview(null);
    setPage('home');
  }

  // Navigate to a completed review when notification is clicked
  useEffect(() => {
    window.electronAPI.onReviewNavigate((reviewId) => {
      const open = async () => {
        const version = ++navigationVersion.current;
        try {
          const loaded = await loadExplanation(reviewId);
          if (version === navigationVersion.current) handleReviewReady(loaded);
        } catch (error) {
          if (version !== navigationVersion.current) return;
          const id = toast.add({
            type: 'error',
            title: 'Could not open saved review',
            description: error instanceof Error ? error.message : String(error),
            actionProps: {
              children: 'Retry',
              onClick: () => {
                toast.close(id);
                void open();
              },
            },
          });
        }
      };
      void open();
    });
    return () => {
      window.electronAPI.offReviewNavigate();
    };
  }, [handleReviewReady]);

  async function navigate(target: SearchDestination) {
    const version = ++navigationVersion.current;
    cancelHistoryLoad();
    setHomeRestoration(undefined);
    if (target.kind === 'activity') {
      setActivityOpen(true);
      return;
    }
    if (target.kind === 'review') {
      const loaded = review?.reviewId === target.reviewId ? review : await loadExplanation(target.reviewId);
      if (version !== navigationVersion.current) return;
      setHomeCommand(undefined);
      if (isLocalUrl(loaded.prUrl)) {
        setExplanationDestination(undefined);
        setReview(loaded);
        setPage('review');
        setReviewCommand({ destination: target, nonce: Date.now() });
      } else {
        setExplanationDestination({ review: loaded, command: { destination: target, nonce: Date.now() } });
        setPage('home');
      }
      return;
    }
    let resolved = target;
    if (target.url) {
      const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(target.url);
      if (!match) throw Error('Enter a GitHub pull request URL.');
      const canonical = `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`;
      const meta = await window.electronAPI.getPrMetadata(canonical),
        repo = `${match[1]}/${match[2]}`;
      if (version !== navigationVersion.current) return;
      resolved = {
        kind: 'home',
        subject: {
          attention: 'other',
          subject: {
            id: canonical,
            kind: 'pr',
            title: meta.title,
            edges: [],
            warnings: [],
            members: [
              {
                ...meta,
                number: Number(match[3]),
                repo,
                headRepo: meta.headRepo ?? repo,
                baseRepo: meta.baseRepo ?? repo,
                role: 'watched',
              },
            ],
          },
        },
      };
    }
    setHomeCommand({ destination: resolved, nonce: Date.now() });
    setPage('home');
  }
  useLayoutEffect(() => register(id, { navigate, openRecent, openActivity }));
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !initial) return;
    started.current = true;
    const restore = async () => {
      if (initial.kind === 'location') return openHistoryLocation(initial.location);
      if (initial.kind !== 'restore') return navigate(initial);
      const saved = initial.saved;
      if (saved.reviewId) return navigate({ kind: 'review', reviewId: saved.reviewId });
      if (!saved.home) return saved.destination ? navigate(saved.destination) : undefined;
      const queue = await window.electronAPI.workbenchSnapshot();
      const { subjectId, url, ...home } = saved.home;
      const items = [...queue.items, ...(queue.starredItems ?? [])];
      let item = items.find((i) => i.subject.id === subjectId);
      if (!item && subjectId) {
        const parent = items.find((i) => i.subject.members.some((m) => m.url === subjectId));
        const member = parent?.subject.members.find((m) => m.url === subjectId);
        if (parent && member) item = focusStackPr(parent, member);
      }
      if (subjectId && !item && url) return navigate({ kind: 'home', url });
      return openHistoryLocation({
        page: 'home',
        home: { ...home, account: initial.account, filters: normalizeQueueFilters(home.filters), item: item ?? null },
      });
    };
    void restore().catch((error: unknown) =>
      toast.add({ type: 'error', title: 'Could not open tab', description: String(error) })
    );
  }, [initial]);
  const commands: AppCommand[] = [
    {
      id: 'nav:queue',
      icon: workbenchIcons.queue,
      label: 'Go to review queue',
      keywords: 'home inbox all',
      perform: () => navigate({ kind: 'home', section: 'all' }),
    },
    {
      id: 'nav:starred',
      icon: workbenchIcons.starred,
      label: 'Go to starred PRs',
      keywords: 'favorites bookmarks pinned',
      perform: () => navigate({ kind: 'home', section: 'starred' }),
    },
    {
      id: 'nav:muted',
      icon: workbenchIcons.muted,
      label: 'Manage muted PRs',
      keywords: 'hidden ignored unmute restore',
      perform: () => navigate({ kind: 'home', section: 'muted' }),
    },
    {
      id: 'nav:requested',
      icon: subjectIcons.pr,
      label: 'Go to review requests',
      keywords: 'assigned me',
      perform: () => navigate({ kind: 'home', section: 'requested' }),
    },
    {
      id: 'nav:response',
      icon: workspaceSections.feedback.icon,
      label: 'Go to needs my response',
      keywords: 'feedback changes requested unresolved my PRs',
      perform: () => navigate({ kind: 'home', section: 'response' }),
    },
    {
      id: 'nav:updated',
      icon: workbenchIcons.refresh,
      label: 'Go to updated PRs',
      keywords: 'changed new changes',
      perform: () => navigate({ kind: 'home', section: 'updated' }),
    },
    {
      id: 'nav:stacks',
      icon: subjectIcons.stack,
      label: 'Go to stacks',
      keywords: 'dependencies',
      perform: () => navigate({ kind: 'home', section: 'stacks' }),
    },
    {
      id: 'nav:saved',
      icon: workbenchIcons.history,
      label: 'Go to saved reviews',
      keywords: 'history archive',
      perform: () => navigate({ kind: 'home', section: 'saved' }),
    },
    {
      id: 'nav:activity',
      icon: workbenchIcons.activity,
      label: 'Show Activity',
      keywords: 'background progress tasks jobs',
      perform: () => navigate({ kind: 'activity' }),
    },
    {
      id: 'nav:local',
      icon: workbenchIcons.localChanges,
      label: 'Review local changes',
      keywords: 'git working tree branch',
      perform: () => navigate({ kind: 'home', local: true }),
    },
    {
      id: 'nav:setup',
      icon: workbenchIcons.setup,
      label: 'Run setup again',
      keywords: 'onboarding tutorial first run',
      perform: () => navigate({ kind: 'home', onboarding: 'setup' }),
    },
    {
      id: 'nav:walkthrough',
      icon: workbenchIcons.help,
      label: 'Show walkthrough',
      keywords: 'tour tutorial onboarding help',
      perform: () => navigate({ kind: 'home', onboarding: 'tour' }),
    },
    ...['queue', 'repositories', 'review', 'appearance', 'integrations'].map((section) => ({
      id: `nav:settings:${section}`,
      icon: workbenchIcons.settings,
      label: `Settings · ${section}`,
      keywords: 'preferences model theme account',
      perform: () => navigate({ kind: 'home', settings: section }),
    })),
  ];

  useCommandScope('workspace', commands);
  return (
    <>
      {/* Update banner shows on the review page. On the home page,
          the newspaper "Extra" notice handles it instead. */}
      {page !== 'home' && <UpdateBanner />}
      <div className="workspace-content">
        {page === 'home' && (
          <HomePage
            onSyncStatus={onSyncStatus}
            onAccount={onAccount}
            onReviewReady={handleReviewReady}
            onReviewOriginChange={setReviewOrigin}
            prefillPrUrl={prefillPrUrl}
            prefillReviewId={prefillReviewId}
            initialSubjectId={destination.subjectId}
            commandDestination={homeCommand}
            explanationDestination={explanationDestination}
            navigationRestoration={homeRestoration}
            onNavigationChange={recordHome}
            onShowActivity={() => setActivityOpen(true)}
          />
        )}
        {page === 'review' && review && (
          <ReviewDraftBoundary
            value={`${review.reviewId ?? review.prUrl}:${review.snapshot?.fingerprint ?? review.headSha ?? ''}`}
          >
            <ReviewPage
              key={`${review.reviewId ?? review.prUrl}:${review.snapshot?.fingerprint ?? review.headSha ?? ''}`}
              review={review}
              origin={reviewOrigin}
              onSelectReview={(id) => void navigate({ kind: 'review', reviewId: id })}
              commandDestination={reviewCommand}
              onBack={handleBack}
              onReReview={handleReReview}
              initialSlideId={destination.slideId}
              exploreInitially={destination.explore}
              onShowActivity={() => setActivityOpen(true)}
            />
          </ReviewDraftBoundary>
        )}
      </div>
    </>
  );
});
