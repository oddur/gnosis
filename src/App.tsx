import { useState, useEffect } from 'react';
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

  useEffect(() => {
    window.electronAPI.onAutoReviewReady((review) => {
      setReview(review);
      setPage('review');
    });
    return () => {
      window.electronAPI.offAutoReviewReady();
    };
  }, []);
  const [review, setReview] = useState<ReviewGuide | null>(null);
  const [prefillPrUrl, setPrefillPrUrl] = useState<string | undefined>();

  function handleReviewReady(r: ReviewGuide) {
    setPrefillPrUrl(undefined);
    setReview(r);
    setPage('review');
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
