import { RepositorySettingsProvider } from '../components/RepositorySettingsProvider';
import { ConflictWorkspaceHost } from '../components/ConflictWorkspaceHost';
import { RecentlyViewedContext } from '../components/RecentlyViewed';
import { createRecentlyViewed, homeVisit, reviewVisit, type RecentVisit } from '../lib/recently-viewed';
import { readReviewState, writeReviewState } from '../lib/renderer-review-state';
import { useFileFilterSync } from '../lib/use-raw-file-filters';
import { CommandCenter, type AppCommand } from '../lib/command-center';
import type { SearchDestination } from '../lib/command-search';
import { ReviewDraftScope } from '../lib/session-drafts';
import { ActivityDrawer } from '../components/ActivityDrawer';
import type { ActivityTask } from '../lib/activity';
import { useState, useEffect, useCallback, useRef } from 'react';
import { HomePage } from './pages/HomePage';
import { ReviewPage } from './pages/ReviewPage';
import { UpdateBanner } from '../components/UpdateBanner';
import { applyCodeFont } from '../components/SettingsDialog';
import { applyTheme } from '../lib/theme';
import type { ReviewGuide } from '../lib/types';
import { toast, Toaster } from '../components/ui/toast';

import { isLocalUrl } from '../lib/local-url';
import { rememberExplanation, loadExplanation, type ExplanationDestination } from '../lib/explanation-workspace';
import { createNavigationHistory, locationKey, type AppLocation, type HomeLocation, type HistoryDirection } from '../lib/navigation-history';
import { useHistoryInput } from '../lib/use-history-input';

type Page = 'home' | 'review';

export function App() {
  useFileFilterSync();
  const [recentlyViewed] = useState(() => createRecentlyViewed(readReviewState, writeReviewState));
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
  const recordHome = useCallback((home: HomeLocation, mutedUrls?: Set<string>) => {
    const location: AppLocation = { page: 'home', home };
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
  }, [navigationHistory, recentlyViewed]);
  useEffect(() => {
    const failed = (event: Event) => {
      const {message,retry} = (event as CustomEvent<{message:string;retry:()=>Promise<void>}>).detail;
      toast.add({type:'error',title:'Could not save review progress',description:message,
        actionProps:{children:'Retry',onClick:()=>{void retry().catch(()=>toast.add({type:'error',title:'Progress still could not be saved',description:'Check available disk space and try again.'}));}}});
    };
    window.addEventListener('gnosis-storage-error',failed);
    return () => window.removeEventListener('gnosis-storage-error',failed);
  }, []);
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
  const [reviewOrigin, setReviewOrigin] = useState<{ name: string; reviews: { id: string; title: string }[] }>({ name: 'Review queue', reviews: [] });
  const navigationVersion = useRef(0);
  const [activityOpen, setActivityOpen] = useState(false);
  const [destination, setDestination] = useState<{
    subjectId?: string;
    slideId?: string;
    explore?: boolean;
    nonce: number;
  }>({ nonce: 0 });

  useEffect(() => {
    let cancelled = false;
    const loadAppearance = async () => {
      try {
        const prefs = await window.electronAPI.loadPreferences();
        if (cancelled) return;
        if (prefs.codeFont) applyCodeFont(prefs.codeFont);
        applyTheme(prefs.theme);
      } catch {
        // HomePage owns account/settings recovery and applies appearance after a retry.
      }
    };
    void loadAppearance();
    return () => {
      cancelled = true;
      navigationVersion.current++;
    };
  }, []);

  // When a background auto-review completes, the history list will refresh itself
  // via the new-review-in-history event — handled in HomePage.
  const [review, setReview] = useState<ReviewGuide | null>(null);
  const [prefillPrUrl, setPrefillPrUrl] = useState<string | undefined>();
  useEffect(() => {
    if (page !== 'review' || !review?.reviewId) return;
    const location: AppLocation = { page: 'review', reviewId: review.reviewId };
    if (pendingHistory.current) return;
    navigationHistory.record(location);
    displayedLocation.current = location;
    const visit = reviewVisit(review);
    if (visit) recentlyViewed.record(visit);
  }, [navigationHistory, recentlyViewed, page, review]);

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
      setDestination(d => ({ nonce: d.nonce + 1 }));
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
      toast.add({ type: 'error', title: 'Could not open history item', description: error instanceof Error ? error.message : String(error) });
    }
  }
  async function openRecent(visit: RecentVisit) {
    if (visit.location.page === 'home' && visit.location.home.account !== historyAccount.current)
      throw new Error('This item belongs to a different GitHub account.');
    await openHistoryLocation(visit.location, false);
  }
  useHistoryInput(direction => { void moveHistory(direction); });

  const handleReviewReady = useCallback((r: ReviewGuide) => {
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
  }, [cancelHistoryLoad]);

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

  function handleReReview(prUrl: string) {
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
  const commands: AppCommand[] = [
    {
      id: 'nav:queue',
      label: 'Go to review queue',
      keywords: 'home inbox all',
      perform: () => navigate({ kind: 'home', section: 'all' }),
    },
    {
      id: 'nav:starred',
      label: 'Go to starred PRs',
      keywords: 'favorites bookmarks pinned',
      perform: () => navigate({ kind: 'home', section: 'starred' }),
    },
    {
      id: 'nav:muted',
      label: 'Manage muted PRs',
      keywords: 'hidden ignored unmute restore',
      perform: () => navigate({ kind: 'home', section: 'muted' }),
    },
    {
      id: 'nav:requested',
      label: 'Go to review requests',
      keywords: 'assigned me',
      perform: () => navigate({ kind: 'home', section: 'requested' }),
    },
    {
      id: 'nav:updated',
      label: 'Go to updated PRs',
      keywords: 'changed new changes',
      perform: () => navigate({ kind: 'home', section: 'updated' }),
    },
    {
      id: 'nav:stacks',
      label: 'Go to stacks',
      keywords: 'dependencies',
      perform: () => navigate({ kind: 'home', section: 'stacks' }),
    },
    {
      id: 'nav:saved',
      label: 'Go to saved reviews',
      keywords: 'history archive',
      perform: () => navigate({ kind: 'home', section: 'saved' }),
    },
    {
      id: 'nav:activity',
      label: 'Show Activity',
      keywords: 'background progress tasks jobs',
      perform: () => navigate({ kind: 'activity' }),
    },
    {
      id: 'nav:local',
      label: 'Review local changes',
      keywords: 'git working tree branch',
      perform: () => navigate({ kind: 'home', local: true }),
    },
    { id: 'nav:setup', label: 'Run setup again', keywords: 'onboarding tutorial first run', perform: () => navigate({ kind: 'home', onboarding: 'setup' }) },
    { id: 'nav:walkthrough', label: 'Show walkthrough', keywords: 'tour tutorial onboarding help', perform: () => navigate({ kind: 'home', onboarding: 'tour' }) },
    ...['queue', 'repositories', 'review', 'appearance', 'integrations'].map((section) => ({
      id: `nav:settings:${section}`,
      label: `Settings · ${section}`,
      keywords: 'preferences model theme account',
      perform: () => navigate({ kind: 'home', settings: section }),
    })),
  ];

  return (
    <RepositorySettingsProvider><RecentlyViewedContext.Provider value={{ store: recentlyViewed, open: openRecent }}>
    <CommandCenter navigate={navigate} commands={commands}>
      {/* Skip-to-content link — visually hidden until focused. Lets
          keyboard users jump straight to the slide/page content
          without tabbing through the persistent header chrome. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100] focus:bg-background focus:text-foreground focus:px-3 focus:py-2 focus:border focus:border-[var(--ring)] focus:text-sm"
      >
        Skip to content
      </a>
      {/* Update banner shows on the review page. On the home page,
          the newspaper "Extra" notice handles it instead. */}
      {page !== 'home' && <UpdateBanner />}
      <div id="main-content" tabIndex={-1}>
        {page === 'home' && (
          <HomePage
            onReviewReady={handleReviewReady}
            onReviewOriginChange={setReviewOrigin}
            prefillPrUrl={prefillPrUrl}
            initialSubjectId={destination.subjectId}
            commandDestination={homeCommand}
            explanationDestination={explanationDestination}
            navigationRestoration={homeRestoration}
            onNavigationChange={recordHome}
            onShowActivity={() => setActivityOpen(true)}
          />
        )}
        {page === 'review' && review && (
          <ReviewDraftScope.Provider
            value={`${review.reviewId ?? review.prUrl}:${review.snapshot?.fingerprint ?? review.headSha ?? ''}`}
          >
            <ReviewPage
              key={`${review.reviewId ?? review.prUrl}:${review.snapshot?.fingerprint ?? review.headSha ?? ''}`}
              review={review}
              origin={reviewOrigin}
              onSelectReview={id => void navigate({ kind: 'review', reviewId: id })}
              commandDestination={reviewCommand}
              onBack={handleBack}
              onReReview={handleReReview}
              initialSlideId={destination.slideId}
              exploreInitially={destination.explore}
              onShowActivity={() => setActivityOpen(true)}
            />
          </ReviewDraftScope.Provider>
        )}
      </div>
      <ActivityDrawer onOpen={openActivity} open={activityOpen} onOpenChange={setActivityOpen} />
      <ConflictWorkspaceHost />
      <Toaster />
    </CommandCenter>
    </RecentlyViewedContext.Provider></RepositorySettingsProvider>
  );
}
