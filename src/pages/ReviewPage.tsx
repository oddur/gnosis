import { useState, useCallback, useEffect, useMemo } from 'react';
import { ArrowLeft } from 'lucide-react';
import { PRSummaryBanner } from '../../components/PRSummaryBanner';
import { StaleBanner } from '../../components/StaleBanner';
import { OverviewSlide } from '../../components/OverviewSlide';
import { SlideView } from '../../components/SlideView';
import { SlideNav } from '../../components/SlideNav';
import { SlideChatSheet } from '../../components/SlideChatSheet';
import { SubmitReviewDialog } from '../../components/SubmitReviewDialog';
import { SettingsDialog } from '../../components/SettingsDialog';
import { useReviewComments } from '../../lib/use-review-comments';
import { useSlideChat } from '../../lib/use-slide-chat';
import { buildFileUrlBase } from '../../lib/github-url';
import type {
  ReviewGuide,
  ReviewEvent,
  FreshnessResult,
  Preferences,
  PrStatus,
  Provider,
  ModelId,
} from '../../lib/types';

interface Props {
  review: ReviewGuide;
  onBack: () => void;
  onReReview: (prUrl: string) => void;
}

export function ReviewPage({ review: initialReview, onBack, onReReview }: Props) {
  const [review, setReview] = useState(initialReview);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [showSubmitDialog, setShowSubmitDialog] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [currentLogin, setCurrentLogin] = useState<string | null>(null);
  const [freshness, setFreshness] = useState<FreshnessResult | null>(null);
  const [prStatus, setPrStatus] = useState<PrStatus | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatProvider, setChatProvider] = useState<Provider>('claude');
  const [chatModel, setChatModel] = useState<ModelId>('claude-sonnet-4-6');
  const [diffLayout, setDiffLayout] = useState<Preferences['diffLayout']>('unified');
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const { comments, addComment, removeComment, editComment, clearAll } = useReviewComments();
  const slideChat = useSlideChat(review, chatProvider, chatModel);
  const gitFileUrlBase = useMemo(() => buildFileUrlBase(review.prUrl, review.headSha), [review.prUrl, review.headSha]);

  useEffect(() => {
    void window.electronAPI.loadPreferences().then((p) => {
      setPrefs(p);
      setChatProvider(p.provider);
      setChatModel(p.model);
      setDiffLayout(p.diffLayout);
    });
  }, []);

  useEffect(() => {
    void window.electronAPI.getAuthState().then((state) => setCurrentLogin(state.login));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.checkPrFreshness(review.prUrl, review.headSha).then((result) => {
      if (!cancelled) setFreshness(result);
    });
    void window.electronAPI
      .getPrStatus(review.prUrl)
      .then((status) => {
        if (!cancelled) setPrStatus(status);
      })
      .catch(() => {
        /* token may be missing for loaded reviews */
      });
    return () => {
      cancelled = true;
    };
  }, [review.prUrl, review.headSha]);

  const handlePrev = useCallback(() => {
    setCurrentSlide((n) => Math.max(0, n - 1));
  }, []);

  const handleNext = useCallback(() => {
    setCurrentSlide((n) => Math.min(review.slides.length, n + 1));
  }, [review.slides.length]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't navigate when typing in a textarea or input
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;

      if (e.key === 'ArrowLeft') handlePrev();
      if (e.key === 'ArrowRight') handleNext();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handlePrev, handleNext]);

  const commentCallbacks = useMemo(
    () => ({ onAddComment: addComment, onRemoveComment: removeComment, onEditComment: editComment }),
    [addComment, removeComment, editComment]
  );

  const handleDiffLayoutChange = useCallback(
    (layout: Preferences['diffLayout']) => {
      setDiffLayout(layout);
      if (prefs) {
        const updated = { ...prefs, diffLayout: layout };
        setPrefs(updated);
        void window.electronAPI.savePreferences(updated);
      }
    },
    [prefs]
  );

  async function handleSubmitReview(event: ReviewEvent, body: string) {
    const result = await window.electronAPI.submitReview({
      prUrl: review.prUrl,
      headSha: review.headSha ?? '',
      event,
      body,
      comments: comments.map((c) => ({
        path: c.filePath,
        line: c.line,
        side: c.side,
        body: c.body,
      })),
    });
    clearAll();
    return result;
  }

  if (review.slides.length === 0) {
    return (
      <main className="flex min-h-screen items-center justify-center p-8">
        <div className="flex flex-col items-center gap-4">
          <p className="text-muted-foreground">No slides were generated for this PR.</p>
          <button
            onClick={onBack}
            className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </button>
        </div>
      </main>
    );
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <PRSummaryBanner review={review} onBack={onBack} onOpenSettings={() => setSettingsOpen(true)} />

      {freshness && <StaleBanner freshness={freshness} onReReview={() => onReReview(review.prUrl)} />}

      <div key={currentSlide} className="slide-enter flex-1 overflow-hidden flex flex-row">
        <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
          {currentSlide === 0 ? (
            <OverviewSlide review={review} prStatus={prStatus} onNavigate={(n) => setCurrentSlide(n)} />
          ) : (
            <SlideView
              slide={review.slides[currentSlide - 1]}
              slideNumber={currentSlide}
              totalSlides={review.slides.length}
              pendingComments={comments}
              commentCallbacks={commentCallbacks}
              diffLayout={diffLayout}
              onDiffLayoutChange={handleDiffLayoutChange}
              onAskQuestion={() => setChatOpen(true)}
              gitFileUrlBase={gitFileUrlBase}
            />
          )}
        </div>

        {currentSlide > 0 && (
          <SlideChatSheet
            open={chatOpen}
            onOpenChange={setChatOpen}
            slideTitle={review.slides[currentSlide - 1].title}
            reviewFocus={review.slides[currentSlide - 1].reviewFocus}
            messages={slideChat.getMessages(currentSlide)}
            isStreaming={slideChat.isStreaming}
            onSend={(text) => void slideChat.send(currentSlide, text)}
          />
        )}
      </div>

      <SlideNav
        current={currentSlide}
        total={review.slides.length}
        onPrev={handlePrev}
        onNext={handleNext}
        commentCount={comments.length}
        onSubmitReview={() => setShowSubmitDialog(true)}
      />

      <SubmitReviewDialog
        open={showSubmitDialog}
        onOpenChange={setShowSubmitDialog}
        comments={comments}
        prUrl={review.prUrl}
        headSha={review.headSha}
        isOwnPr={currentLogin !== null && currentLogin === review.author}
        onSubmit={handleSubmitReview}
      />

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onThemeChange={async () => {
          const updated = await window.electronAPI.reRenderHunks(review);
          setReview(updated);
        }}
      />
    </div>
  );
}
