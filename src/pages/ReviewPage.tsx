import { useState, useCallback, useEffect, useMemo } from 'react';
import { ArrowLeft } from 'lucide-react';
import { PRSummaryBanner } from '../../components/PRSummaryBanner';
import { StaleBanner } from '../../components/StaleBanner';
import { OverviewSlide } from '../../components/OverviewSlide';
import { SlideView } from '../../components/SlideView';
import { SlideNav } from '../../components/SlideNav';
import { TocRail } from '../../components/TocRail';
import { SlideChatSheet } from '../../components/SlideChatSheet';
import { SubmitReviewDialog } from '../../components/SubmitReviewDialog';
import { SettingsDialog } from '../../components/SettingsDialog';
import { ShortcutOverlay } from '../../components/ShortcutOverlay';
import { CommandPalette, type Command } from '../../components/CommandPalette';
import { useReviewComments } from '../../lib/use-review-comments';
import { useSlideChat } from '../../lib/use-slide-chat';
import { useKeyboardShortcuts, type ShortcutMap } from '../../lib/use-keyboard-shortcuts';
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

// localStorage key for review progress. Keyed by prUrl + headSha so
// each review generation gets its own progress state.
function progressKey(review: ReviewGuide): string {
  return `gnosis-progress:${review.prUrl}:${review.headSha ?? 'unknown'}`;
}

function loadProgress(review: ReviewGuide): Set<number> {
  try {
    const stored = localStorage.getItem(progressKey(review));
    return stored ? new Set(JSON.parse(stored) as number[]) : new Set();
  } catch {
    return new Set();
  }
}

function saveProgress(review: ReviewGuide, reviewed: Set<number>) {
  try {
    localStorage.setItem(progressKey(review), JSON.stringify([...reviewed]));
  } catch {
    /* non-fatal */
  }
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
  const [chatQuotedCode, setChatQuotedCode] = useState<string | null>(null);
  const [chatProvider, setChatProvider] = useState<Provider>('claude');
  const [chatModel, setChatModel] = useState<ModelId>('claude-sonnet-4-6');
  const [diffLayout, setDiffLayout] = useState<Preferences['diffLayout']>('unified');
  const [slideViewMode, setSlideViewMode] = useState<'split' | 'focus'>('split');
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Per-section "mark reviewed" progress. Persisted to localStorage
  // keyed by prUrl + headSha so each review generation is tracked
  // independently. Restored on mount so interrupted reviews resume
  // exactly where the user left off.
  const [reviewed, setReviewed] = useState<Set<number>>(() => loadProgress(initialReview));

  // "Hide reviewed" toggle — when active, the TocRail collapses
  // reviewed entries and slide navigation skips them.
  const [hideReviewed, setHideReviewed] = useState(false);

  const reviewedCount = reviewed.size;

  const toggleReviewed = useCallback(
    (slideNumber: number) => {
      setReviewed((prev) => {
        const next = new Set(prev);
        if (next.has(slideNumber)) {
          next.delete(slideNumber);
        } else {
          next.add(slideNumber);
        }
        saveProgress(review, next);
        return next;
      });
    },
    [review]
  );

  // Mark the current section as reviewed and auto-advance to the
  // next unreviewed section (or to submit if everything is reviewed).
  const markReviewedAndAdvance = useCallback(
    (slideNumber: number) => {
      setReviewed((prev) => {
        const next = new Set(prev);
        next.add(slideNumber);
        saveProgress(review, next);

        // Find the next unreviewed section after the current one.
        // Wraps to the beginning if needed; opens submit dialog if all done.
        let target: number | null = null;
        for (let i = slideNumber + 1; i <= review.slides.length; i++) {
          if (!next.has(i)) {
            target = i;
            break;
          }
        }
        if (target === null) {
          // Wrap from the start
          for (let i = 1; i < slideNumber; i++) {
            if (!next.has(i)) {
              target = i;
              break;
            }
          }
        }

        if (target !== null) {
          setCurrentSlide(target);
        } else if (next.size >= review.slides.length) {
          // All sections reviewed — open submit dialog
          setShowSubmitDialog(true);
        }

        return next;
      });
    },
    [review]
  );

  // Jump to the next unreviewed section from wherever the user is.
  // Used by the `n` keyboard shortcut.
  const jumpToNextUnreviewed = useCallback(() => {
    const start = currentSlide + 1;
    // Forward from current
    for (let i = start; i <= review.slides.length; i++) {
      if (!reviewed.has(i)) {
        setCurrentSlide(i);
        return;
      }
    }
    // Wrap from the beginning
    for (let i = 1; i < start; i++) {
      if (!reviewed.has(i)) {
        setCurrentSlide(i);
        return;
      }
    }
    // Everything is reviewed — go to overview
    setCurrentSlide(0);
  }, [currentSlide, review.slides.length, reviewed]);
  const { comments, addComment, removeComment, editComment, clearAll } = useReviewComments();
  const slideChat = useSlideChat(review, chatProvider, chatModel);
  const gitFileUrlBase = useMemo(() => buildFileUrlBase(review.prUrl, review.headSha), [review.prUrl, review.headSha]);
  const excludedFilesSet = useMemo(() => new Set(review.excludedFiles ?? []), [review.excludedFiles]);

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

  // Jump directly to a specific slide number, clamped to range.
  // Slide 0 is the overview, slides 1..N are the real chapters.
  const handleJumpTo = useCallback(
    (n: number) => {
      setCurrentSlide(Math.max(0, Math.min(review.slides.length, n)));
    },
    [review.slides.length]
  );

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

  // Build the keyboard shortcut map. The hook handles input
  // suppression, modifier signatures, and two-key sequences.
  // Declared after handleDiffLayoutChange so the closures land
  // on a defined function rather than the temporal dead zone.
  const shortcutMap = useMemo<ShortcutMap>(() => {
    const map: ShortcutMap = {
      // Navigation — both arrows and vim
      ArrowLeft: () => handlePrev(),
      ArrowRight: () => handleNext(),
      j: () => handleNext(),
      k: () => handlePrev(),
      // Sequences and bookends
      'g g': () => handleJumpTo(0),
      G: () => handleJumpTo(review.slides.length),
      // Diff layout — only valid on a real slide, not the overview
      u: () => {
        if (currentSlide > 0) handleDiffLayoutChange('unified');
      },
      s: () => {
        if (currentSlide > 0) handleDiffLayoutChange('split');
      },
      // View mode toggle — split (narrative + diff side by side)
      // vs focus (narrative stacked above diff, full-width)
      f: () => {
        if (currentSlide > 0) setSlideViewMode((v) => (v === 'split' ? 'focus' : 'split'));
      },
      // Open chat for the current slide
      c: () => {
        if (currentSlide > 0) setChatOpen(true);
      },
      // Review progress
      r: () => {
        if (currentSlide > 0) markReviewedAndAdvance(currentSlide);
      },
      n: () => jumpToNextUnreviewed(),
      // Global
      'cmd+k': () => setPaletteOpen(true),
      'ctrl+k': () => setPaletteOpen(true),
      '?': () => setShortcutsOpen((v) => !v),
    };
    // Numeric jump 1–9 → slide N (chapter, not overview)
    for (let n = 1; n <= 9; n++) {
      map[String(n)] = () => handleJumpTo(n);
    }
    return map;
  }, [handlePrev, handleNext, handleJumpTo, handleDiffLayoutChange, markReviewedAndAdvance, jumpToNextUnreviewed, currentSlide, review.slides.length]);

  useKeyboardShortcuts(shortcutMap);

  // Build the command palette commands. The slide jump entries
  // are generated dynamically from the review so they read like a
  // table of contents inside the palette.
  const paletteCommands = useMemo<Command[]>(() => {
    const commands: Command[] = [];

    commands.push({
      id: 'overview',
      label: 'Jump to overview',
      hint: 'g g',
      group: 'Reading',
      keywords: 'home start beginning',
      perform: () => handleJumpTo(0),
    });

    review.slides.forEach((slide, idx) => {
      const num = (idx + 1).toString().padStart(2, '0');
      commands.push({
        id: `slide-${slide.id}`,
        label: `${num}  ${slide.title}`,
        group: 'Reading',
        keywords: slide.title,
        perform: () => handleJumpTo(idx + 1),
      });
    });

    if (currentSlide > 0) {
      commands.push(
        {
          id: 'unified',
          label: 'Switch to unified diff',
          hint: 'u',
          group: 'Reviewing',
          keywords: 'diff layout combine',
          perform: () => handleDiffLayoutChange('unified'),
        },
        {
          id: 'split',
          label: 'Switch to split diff',
          hint: 's',
          group: 'Reviewing',
          keywords: 'diff layout side by side',
          perform: () => handleDiffLayoutChange('split'),
        },
        {
          id: 'chat',
          label: 'Ask about this slide',
          hint: 'c',
          group: 'Reviewing',
          keywords: 'chat question follow up',
          perform: () => setChatOpen(true),
        }
      );
    }

    commands.push(
      {
        id: 'submit',
        label: comments.length > 0 ? `Submit review (${comments.length} comments)` : 'Submit review',
        group: 'Reviewing',
        keywords: 'send post approve',
        perform: () => setShowSubmitDialog(true),
      },
      {
        id: 'shortcuts',
        label: 'Show keyboard shortcuts',
        hint: '?',
        group: 'Anywhere',
        keywords: 'help cheatsheet keys',
        perform: () => setShortcutsOpen(true),
      },
      {
        id: 'settings',
        label: 'Open settings',
        group: 'Anywhere',
        keywords: 'preferences config theme font',
        perform: () => setSettingsOpen(true),
      },
      {
        id: 'back',
        label: 'Back to home',
        group: 'Anywhere',
        keywords: 'exit close leave',
        perform: () => onBack(),
      }
    );

    return commands;
  }, [
    review.slides,
    currentSlide,
    comments.length,
    handleJumpTo,
    handleDiffLayoutChange,
    onBack,
  ]);

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
      <main className="flex min-h-screen items-start justify-center px-8 pt-[18vh]">
        <div className="w-full max-w-2xl flex flex-col gap-6">
          <div className="slide-chapter">
            <span>Empty review</span>
          </div>
          <h1 className="slide-title">No slides were generated for this PR.</h1>
          <p className="slide-prose">
            This usually happens when the diff is empty, when every file was filtered out as boilerplate, or when the
            model could not produce a structured response. You can re-run the review or pick a different PR.
          </p>
          <button
            onClick={onBack}
            className="slide-meta hover:text-foreground flex items-center gap-1.5 self-start"
          >
            <ArrowLeft className="h-3 w-3" />
            Back to home
          </button>
        </div>
      </main>
    );
  }

  // Reading progress fills a 1px hairline at the very top of the page
  // as the user advances through the deck. The previous version of
  // this lived above the bottom nav, but pulling it to the top is a
  // more honest "you are here in the book" cue and frees the bottom
  // bar to carry more visual weight.
  //
  // Formula is `currentSlide / total` rather than `(current - 1) /
  // (total - 1)` so the very first slide already shows a visible
  // sliver of progress — a small but meaningful "you've started"
  // signal. Slide 1 of 10 = 10%, slide 5 = 50%, slide 10 = 100%.
  const progress =
    currentSlide === 0
      ? 0
      : (currentSlide / review.slides.length) * 100;

  // Surface the previous and next slide titles to the bottom nav so
  // it can render them as labels — much more informative than
  // generic "Previous" / "Next" copy.
  const prevTitle =
    currentSlide === 0
      ? null
      : currentSlide === 1
        ? 'Overview'
        : (review.slides[currentSlide - 2]?.title ?? null);
  const nextTitle =
    currentSlide >= review.slides.length
      ? null
      : (review.slides[currentSlide]?.title ?? null);

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Top-of-page reading progress hairline. 1px tall, fills in
          the brand claret as the reader moves through the deck.
          Honors prefers-reduced-motion via .loading-progress-fill. */}
      <div
        className="relative h-px w-full bg-transparent shrink-0"
        role="progressbar"
        aria-valuenow={progress}
      >
        <div
          className="absolute left-0 top-0 h-px bg-[var(--ring)] loading-progress-fill"
          style={{ width: `${progress}%` }}
        />
      </div>

      <PRSummaryBanner review={review} onBack={onBack} onOpenSettings={() => setSettingsOpen(true)} />

      {freshness && <StaleBanner freshness={freshness} onReReview={() => onReReview(review.prUrl)} />}

      {/* Content area is a flex row: persistent TOC rail on the left,
          the active slide (overview or chapter) in the center, and
          the optional chat sheet on the right. */}
      <div className="flex-1 overflow-hidden flex flex-row min-h-0">
        <TocRail
          slides={review.slides}
          currentSlide={currentSlide}
          reviewed={reviewed}
          hideReviewed={hideReviewed}
          onToggleHideReviewed={() => setHideReviewed((v) => !v)}
          onNavigate={(n) => setCurrentSlide(n)}
        />

        <div key={currentSlide} className="slide-enter flex-1 min-w-0 overflow-hidden flex flex-col">
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
              onAskAboutSelection={(code) => {
                setChatQuotedCode(code);
                setChatOpen(true);
              }}
              viewMode={slideViewMode}
              gitFileUrlBase={gitFileUrlBase}
              excludedFiles={excludedFilesSet}
              isReviewed={reviewed.has(currentSlide)}
              onMarkReviewed={() => markReviewedAndAdvance(currentSlide)}
              onToggleReviewed={() => toggleReviewed(currentSlide)}
            />
          )}
        </div>

        {currentSlide > 0 && (
          <SlideChatSheet
            open={chatOpen}
            onOpenChange={(open) => {
              setChatOpen(open);
              if (!open) setChatQuotedCode(null);
            }}
            slideTitle={review.slides[currentSlide - 1].title}
            reviewFocus={review.slides[currentSlide - 1].reviewFocus}
            messages={slideChat.getMessages(currentSlide)}
            isStreaming={slideChat.isStreaming}
            onSend={(text) => void slideChat.send(currentSlide, text)}
            quotedCode={chatQuotedCode}
            onQuotedCodeConsumed={() => setChatQuotedCode(null)}
          />
        )}
      </div>

      <SlideNav
        current={currentSlide}
        total={review.slides.length}
        reviewedCount={reviewedCount}
        prevTitle={prevTitle}
        nextTitle={nextTitle}
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

      <ShortcutOverlay open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={paletteCommands} />
    </div>
  );
}
