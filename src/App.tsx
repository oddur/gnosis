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

type Page = 'home' | 'review';

export function App() {
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
    setDestination((d) => ({ nonce: d.nonce + 1 }));
    setPrefillPrUrl(undefined);
    setReview(r);
    setPage('review');
  }, []);

  async function openActivity(task: ActivityTask) {
    if (task.kind === 'briefing') {
      setDestination((d) => ({ subjectId: task.subjectId, nonce: d.nonce + 1 }));
      setReview(null);
      setPage('home');
      setActivityOpen(false);
      return;
    }
    if (!task.reviewId) throw new Error('This task has no saved review.');
    const loaded = await window.electronAPI.loadReview(task.reviewId);
    setReview(loaded);
    setPage('review');
    setDestination((d) => ({ slideId: task.slideId, explore: task.kind === 'exploration', nonce: d.nonce + 1 }));
    setActivityOpen(false);
  }

  function handleBack() {
    setReview(null);
    setPage('home');
  }

  function handleReReview(prUrl: string) {
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

  return (
    <>
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
            key={destination.nonce}
            onReviewReady={handleReviewReady}
            prefillPrUrl={prefillPrUrl}
            initialSubjectId={destination.subjectId}
          />
        )}
        {page === 'review' && review && (
          <ReviewPage
            key={destination.nonce}
            review={review}
            onBack={handleBack}
            onReReview={handleReReview}
            initialSlideId={destination.slideId}
            exploreInitially={destination.explore}
            onShowActivity={() => setActivityOpen(true)}
          />
        )}
      </div>
      <ActivityDrawer onOpen={openActivity} open={activityOpen} onOpenChange={setActivityOpen} />
      <Toaster />
    </>
  );
}
