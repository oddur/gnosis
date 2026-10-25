import { CommandCenter, type AppCommand } from '../lib/command-center';
import type { SearchDestination } from '../lib/command-search';
import { ReviewDraftScope } from '../lib/session-drafts';
import { ActivityDrawer } from '../components/ActivityDrawer';
import type { ActivityTask } from '../lib/activity';
import { useState, useEffect, useCallback } from 'react';
import { HomePage } from './pages/HomePage';
import { ReviewPage } from './pages/ReviewPage';
import { UpdateBanner } from '../components/UpdateBanner';
import { applyCodeFont } from '../components/SettingsDialog';
import { applyTheme } from '../lib/theme';
import type { ReviewGuide } from '../lib/types';
import { Toaster } from '../components/ui/toast';

import { isLocalUrl } from '../lib/local-url';
import { rememberExplanation, loadExplanation, type ExplanationDestination } from '../lib/explanation-workspace';

type Page = 'home' | 'review';

export function App() {
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
  const [activityOpen, setActivityOpen] = useState(false);
  const [destination, setDestination] = useState<{
    subjectId?: string;
    slideId?: string;
    explore?: boolean;
    nonce: number;
  }>({ nonce: 0 });

  useEffect(() => {
    void window.electronAPI.loadPreferences().then((prefs) => {
      if (prefs.codeFont) applyCodeFont(prefs.codeFont);
      applyTheme(prefs.theme);
    });
  }, []);

  // When a background auto-review completes, the history list will refresh itself
  // via the new-review-in-history event — handled in HomePage.
  const [review, setReview] = useState<ReviewGuide | null>(null);
  const [prefillPrUrl, setPrefillPrUrl] = useState<string | undefined>();

  const handleReviewReady = useCallback((r: ReviewGuide) => {
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
  }, []);

  async function openActivity(task: ActivityTask) {
    if (task.kind === 'briefing') {
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
    setExplanationDestination(undefined);
    setHomeCommand(undefined);
    setReviewCommand(undefined);
    setReview(null);
    setPage('home');
  }

  function handleReReview(prUrl: string) {
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
      void window.electronAPI.loadReview(reviewId).then((r) => {
        handleReviewReady(r);
      });
    });
    return () => {
      window.electronAPI.offReviewNavigate();
    };
  }, [handleReviewReady]);

  async function navigate(target: SearchDestination) {
    if (target.kind === 'activity') {
      setActivityOpen(true);
      return;
    }
    if (target.kind === 'review') {
      const loaded = review?.reviewId === target.reviewId ? review : await loadExplanation(target.reviewId);
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
      label: 'Go to work queue',
      keywords: 'home inbox all',
      perform: () => navigate({ kind: 'home', section: 'all' }),
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
    ...['queue', 'review', 'appearance', 'integrations'].map((section) => ({
      id: `nav:settings:${section}`,
      label: `Settings · ${section}`,
      keywords: 'preferences model theme account',
      perform: () => navigate({ kind: 'home', settings: section }),
    })),
  ];

  return (
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
      <div id="main-content">
        {page === 'home' && (
          <HomePage
            onReviewReady={handleReviewReady}
            prefillPrUrl={prefillPrUrl}
            initialSubjectId={destination.subjectId}
            commandDestination={homeCommand}
            explanationDestination={explanationDestination}
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
      <Toaster />
    </CommandCenter>
  );
}
