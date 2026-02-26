import { useState, useEffect, useCallback } from 'react';
import { TooltipProvider } from '../components/ui/tooltip';
import { HomePage } from './pages/HomePage';
import { ReviewPage } from './pages/ReviewPage';
import { UpdateBanner } from '../components/UpdateBanner';
import { applyCodeFont } from '../components/SettingsDialog';
import type { ReviewGuide } from '../lib/types';

type Page = 'home' | 'review';

export function App() {
  const [page, setPage] = useState<Page>('home');

  useEffect(() => {
    void window.electronAPI.loadPreferences().then((prefs) => {
      if (prefs.codeFont) applyCodeFont(prefs.codeFont);
    });
  }, []);

  // When a background auto-review completes, the history list will refresh itself
  // via the new-review-in-history event — handled in HomePage.
  const [review, setReview] = useState<ReviewGuide | null>(null);
  const [prefillPrUrl, setPrefillPrUrl] = useState<string | undefined>();

  const handleReviewReady = useCallback((r: ReviewGuide) => {
    setPrefillPrUrl(undefined);
    setReview(r);
    setPage('review');
  }, []);

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
      <UpdateBanner />
      <TooltipProvider>
        {page === 'home' && <HomePage onReviewReady={handleReviewReady} prefillPrUrl={prefillPrUrl} />}
        {page === 'review' && review && <ReviewPage review={review} onBack={handleBack} onReReview={handleReReview} />}
      </TooltipProvider>
    </>
  );
}
