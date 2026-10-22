import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { DEFAULT_DIFF_APPEARANCE, type DiffAppearance } from '../../lib/review-diff';
import { ArrowLeft, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { PRSummaryBanner } from '../../components/PRSummaryBanner';
import { StaleBanner } from '../../components/StaleBanner';
import { WorkbenchOverview } from '../../components/WorkbenchOverview';
import { coverageKey, sourceForPath, subjectForReview } from '../../lib/workbench';
import { SlideView } from '../../components/SlideView';
import { ExplainerView } from '../../components/ExplainerView';
import { SlideNav } from '../../components/SlideNav';
import { TocRail } from '../../components/TocRail';
import { SlideChatSheet } from '../../components/SlideChatSheet';
import { SubmitReviewDialog } from '../../components/SubmitReviewDialog';
import { WorkbenchHelp } from '../../components/WorkbenchHelp';
import { SettingsDialog } from '../../components/SettingsDialog';
import { ShortcutOverlay } from '../../components/ShortcutOverlay';
import { CommandPalette, type Command } from '../../components/CommandPalette';
import { useReviewComments } from '../../lib/use-review-comments';
import { useSlideChat } from '../../lib/use-slide-chat';
import { useKeyboardShortcuts, type ShortcutMap } from '../../lib/use-keyboard-shortcuts';
import { buildFileUrlBase } from '../../lib/github-url';
import { isLocalUrl } from '../../lib/local-url';
import type { ReviewGuide, ReviewEvent, FreshnessResult, Preferences, Provider, ModelId } from '../../lib/types';
import { DEFAULT_FAST_CLAUDE_MODEL } from '../../lib/models';

interface Props {
  review: ReviewGuide;
  onBack: () => void;
  onReReview: (prUrl: string) => void;
  initialSlideId?: string;
  exploreInitially?: boolean;
}

// localStorage key for review progress. Keyed by prUrl + headSha so
// each review generation gets its own progress state.
function progressKey(review: ReviewGuide): string {
  return review.snapshot
    ? `gnosis-progress:${subjectForReview(review)}`
    : `gnosis-progress:${review.prUrl}:${review.headSha ?? 'unknown'}`;
}

function loadProgress(review: ReviewGuide): Set<number> {
  try {
    const stored = JSON.parse(localStorage.getItem(progressKey(review)) ?? '[]') as (string | number)[];
    return new Set(
      review.slides
        .filter((s) => stored.includes(coverageKey(review, s)) || (!review.snapshot && stored.includes(s.slideNumber)))
        .map((s) => s.slideNumber)
    );
  } catch {
    return new Set();
  }
}
function saveProgress(review: ReviewGuide, reviewed: Set<number>) {
  try {
    localStorage.setItem(
      progressKey(review),
      JSON.stringify(review.slides.filter((s) => reviewed.has(s.slideNumber)).map((s) => coverageKey(review, s)))
    );
  } catch {
    /* storage is optional */
  }
}

// Per-check "done" marks inside the "What to check" callout. Same
// keying scheme as slide progress so one review's marks don't leak
// into another review of the same PR. Each entry is
// `${slideId}:${hash(check.text)}` — stable across re-renders and
// robust to bullet-vs-inline layout choice.
function checksKey(review: ReviewGuide): string {
  return `gnosis-checks:${subjectForReview(review)}:${review.snapshot?.fingerprint ?? review.headSha ?? 'unknown'}`;
}

function loadChecks(review: ReviewGuide): Set<string> {
  try {
    const stored = localStorage.getItem(checksKey(review));
    return stored ? new Set(JSON.parse(stored) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function saveChecks(review: ReviewGuide, checked: Set<string>) {
  try {
    localStorage.setItem(checksKey(review), JSON.stringify([...checked]));
  } catch {
    /* non-fatal */
  }
}

export function ReviewPage({ review: initialReview, onBack, onReReview, initialSlideId, exploreInitially }: Props) {
  const [review, setReview] = useState(initialReview);
  const [currentSlide, setCurrentSlide] = useState(() => {
    if (initialSlideId) return initialReview.slides.find((s) => s.id === initialSlideId)?.slideNumber ?? 0;
    const saved = Number(
      localStorage.getItem(`gnosis-position:${subjectForReview(initialReview)}:${initialReview.reviewId}`) ?? 0
    );
    return Number.isInteger(saved) && saved >= 0 && saved <= initialReview.slides.length ? saved : 0;
  });
  const [navOpen, setNavOpen] = useState(false);
  const [submitUrl, setSubmitUrl] = useState(
    initialReview.snapshot?.subject.members.find((m) => !m.merged && m.state === 'open')?.url ?? initialReview.prUrl
  );
  const submitMember = review.snapshot?.subject.members.find((m) => m.url === submitUrl);
  const focusBeforeTool = useRef<HTMLElement | null>(null);

  const [showSubmitDialog, setShowSubmitDialog] = useState(false);
  const submissionKey = `gnosis-submissions:${review.snapshot?.fingerprint ?? review.prUrl}`;
  const [submissions, setSubmissions] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem(submissionKey) ?? '{}') as Record<string, string>;
    } catch {
      return {};
    }
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [currentLogin, setCurrentLogin] = useState<string | null>(null);
  const [freshness, setFreshness] = useState<FreshnessResult | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatQuotedCode, setChatQuotedCode] = useState<string | null>(null);
  const [chatProvider, setChatProvider] = useState<Provider>('claude');
  const [chatModel, setChatModel] = useState<ModelId>(DEFAULT_FAST_CLAUDE_MODEL);
  const [diffLayout, setDiffLayout] = useState<Preferences['diffLayout']>('unified');
  const [slideViewMode, setSlideViewMode] = useState<'split' | 'focus'>('split');
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const diffAppearance = useMemo(
    () => ({ ...DEFAULT_DIFF_APPEARANCE, ...prefs?.diffAppearance }),
    [prefs?.diffAppearance]
  );
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [exploreOpen, setExploreOpen] = useState(exploreInitially ?? false);

  // Per-section "mark reviewed" progress. Persisted to localStorage
  // keyed by prUrl + headSha so each review generation is tracked
  // independently. Restored on mount so interrupted reviews resume
  // exactly where the user left off.
  const [reviewed, setReviewed] = useState<Set<number>>(() => loadProgress(initialReview));

  // Per-check done marks (the "What to check" checkboxes). Same
  // keying scheme as reviewed, but keyed by `slideId:hash(check.text)`.
  const [checkedChecks, setCheckedChecks] = useState<Set<string>>(() => loadChecks(initialReview));
  const toggleCheck = useCallback(
    (key: string) => {
      setCheckedChecks((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        saveChecks(review, next);
        return next;
      });
    },
    [review]
  );

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
  const { comments, addComment, removeComment, editComment } = useReviewComments(
    `gnosis-drafts:${subjectForReview(review)}:${review.snapshot?.fingerprint ?? review.headSha}`
  );
  const selectedComments = comments.filter(
    (c) => (sourceForPath(review, c.filePath).member?.url ?? review.prUrl) === submitUrl
  );
  const slideChat = useSlideChat(review, chatProvider, chatModel);
  const gitFileUrlBase = useMemo(
    () => (review.snapshot?.subject.kind === 'stack' ? undefined : buildFileUrlBase(review.prUrl, review.headSha)),
    [review.prUrl, review.headSha]
  );
  const excludedFilesSet = useMemo(() => new Set(review.excludedFiles ?? []), [review.excludedFiles]);

  // Build a filename → FileMetadata lookup for diff file headers.
  // Only populated for reviews generated after the metadata feature
  // was added; older reviews from disk won't have changedFiles.
  const fileMetadataMap = useMemo(() => {
    const map = new Map<string, import('../../lib/types').FileMetadata>();
    for (const fm of review.changedFiles ?? []) {
      map.set(fm.filename, fm);
    }
    return map;
  }, [review.changedFiles]);

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

  const isLocal = isLocalUrl(review.prUrl);
  useEffect(() => {
    try {
      localStorage.setItem(`gnosis-position:${subjectForReview(review)}:${review.reviewId}`, String(currentSlide));
    } catch {
      /* optional */
    }
  }, [currentSlide, review]);
  useEffect(() => {
    if (chatOpen || exploreOpen) {
      if (!focusBeforeTool.current) focusBeforeTool.current = document.activeElement as HTMLElement;
    } else {
      focusBeforeTool.current?.focus();
      focusBeforeTool.current = null;
    }
  }, [chatOpen, exploreOpen]);

  useEffect(() => {
    // Local reviews have no remote PR to poll or describe — skip both calls.
    if (isLocal) return;
    let cancelled = false;
    void (
      review.snapshot
        ? window.electronAPI.workbenchFreshness(review.snapshot)
        : Promise.resolve({
            status: 'unknown',
            reason: 'This saved review predates revision tracking. Regenerate it to check all dependencies.',
          } as FreshnessResult)
    ).then((result) => {
      if (!cancelled) setFreshness(result);
    });
    return () => {
      cancelled = true;
    };
  }, [review.prUrl, review.headSha, isLocal]);

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
      setExploreOpen(false);
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

  const handleDiffAppearanceChange = useCallback((value: DiffAppearance) => {
    setPrefs((current) => (current ? { ...current, diffAppearance: value } : current));
    // Read current settings so appearance changes cannot revert unrelated preferences.
    void window.electronAPI
      .loadPreferences()
      .then((current) => window.electronAPI.savePreferences({ ...current, diffAppearance: value }));
  }, []);

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
  }, [
    handlePrev,
    handleNext,
    handleJumpTo,
    handleDiffLayoutChange,
    markReviewedAndAdvance,
    jumpToNextUnreviewed,
    currentSlide,
    review.slides.length,
  ]);

  useKeyboardShortcuts(shortcutMap, { enabled: !exploreOpen });

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
          label: 'Ask about this topic',
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
        label: comments.length > 0 ? `Submit to GitHub (${comments.length} comments)` : 'Submit to GitHub',
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
  }, [review.slides, currentSlide, comments.length, handleJumpTo, handleDiffLayoutChange, onBack]);

  async function handleSubmitReview(event: ReviewEvent, body: string) {
    const result = await window.electronAPI.submitReview({
      prUrl: submitUrl,
      headSha: submitMember?.headSha ?? review.headSha ?? '',
      baseSha: submitMember?.baseSha,
      baseBranch: submitMember?.baseBranch,
      event,
      body,
      comments: selectedComments.map((c) => ({
        path: sourceForPath(review, c.filePath).path,
        line: c.line,
        side: c.side,
        body: c.body,
      })),
    });
    const next = {
      ...submissions,
      [submitUrl]:
        event === 'APPROVE'
          ? 'Approval submitted'
          : event === 'REQUEST_CHANGES'
            ? 'Changes requested'
            : 'Comments submitted',
    };
    setSubmissions(next);
    localStorage.setItem(submissionKey, JSON.stringify(next));
    selectedComments.forEach((c) => removeComment(c.id));
    return result;
  }

  if (review.slides.length === 0) {
    return (
      <main className="flex min-h-full items-start justify-center px-10 lg:px-12 pt-[18vh]">
        <div className="w-full max-w-2xl flex flex-col gap-6">
          <div className="slide-chapter">
            <span>Empty review</span>
          </div>
          <h1 className="slide-title">No review topics were generated for this PR.</h1>
          <p className="slide-prose">
            This happens when the diff is empty, every file was filtered as boilerplate, or the model couldn't parse the
            change structure. Try re-running with different settings or a different model.
          </p>
          <button onClick={onBack} className="slide-meta hover:text-foreground flex items-center gap-1.5 self-start">
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
  const progress = currentSlide === 0 ? 0 : (currentSlide / review.slides.length) * 100;

  // Surface the previous and next slide titles to the bottom nav so
  // it can render them as labels — much more informative than
  // generic "Previous" / "Next" copy.
  const prevTitle =
    currentSlide === 0 ? null : currentSlide === 1 ? 'Overview' : (review.slides[currentSlide - 2]?.title ?? null);
  const nextTitle = currentSlide >= review.slides.length ? null : (review.slides[currentSlide]?.title ?? null);

  return (
    <div className="workbench-review flex flex-col h-full overflow-hidden">
      {/* Top-of-page reading progress hairline. 1px tall, fills in
          the brand claret as the reader moves through the deck.
          Honors prefers-reduced-motion via .loading-progress-fill. */}
      <div className="relative h-px w-full bg-transparent shrink-0" role="progressbar" aria-valuenow={progress}>
        <div
          className="absolute left-0 top-0 h-px bg-[var(--ring)] loading-progress-fill"
          style={{ width: `${progress}%` }}
        />
      </div>

      <PRSummaryBanner review={review} onBack={onBack} onOpenSettings={() => setSettingsOpen(true)} />

      {freshness && <StaleBanner freshness={freshness} onReReview={() => onReReview(review.prUrl)} />}

      <div className="review-toolbar">
        <WorkbenchHelp />
        <button onClick={() => setNavOpen((v) => !v)} aria-pressed={navOpen} title="Toggle topic navigation">
          {navOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}Topics
        </button>
        <select aria-label="Review topic" value={currentSlide} onChange={(e) => handleJumpTo(Number(e.target.value))}>
          <option value={0}>Overview</option>
          {review.slides.map((s) => (
            <option key={s.id} value={s.slideNumber}>
              {reviewed.has(s.slideNumber) ? '✓ ' : ''}
              {s.title}
            </option>
          ))}
        </select>
        {chatOpen && (
          <button onClick={() => setChatOpen(false)}>
            <X size={13} />
            Close chat
          </button>
        )}
        {exploreOpen && (
          <button onClick={() => setExploreOpen(false)}>
            <X size={13} />
            Close interactive explanation
          </button>
        )}
        {review.snapshot?.subject.kind === 'stack' && (
          <label className="ml-auto flex items-center gap-2 text-xs">
            Send feedback to
            <select
              aria-label="PR for review submission"
              value={submitUrl}
              onChange={(e) => setSubmitUrl(e.target.value)}
            >
              {review.snapshot.subject.members.map((m) => (
                <option key={m.url} value={m.url}>
                  #{m.number} {m.title}
                  {m.merged ? ' (merged)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="flex-1 overflow-hidden flex flex-row min-h-0">
        {navOpen && (
          <TocRail
            slides={review.slides}
            currentSlide={currentSlide}
            reviewed={reviewed}
            hideReviewed={hideReviewed}
            onToggleHideReviewed={() => setHideReviewed((v) => !v)}
            onNavigate={handleJumpTo}
          />
        )}
        <div key={currentSlide} className="flex-1 min-w-0 overflow-hidden flex flex-col">
          {currentSlide === 0 ? (
            <WorkbenchOverview
              review={review}
              reviewed={reviewed}
              onNavigate={handleJumpTo}
              submissions={submissions}
              onSubmit={(url) => {
                setSubmitUrl(url);
                setShowSubmitDialog(true);
              }}
            />
          ) : (
            <SlideView
              review={review}
              slide={review.slides[currentSlide - 1]}
              slideNumber={currentSlide}
              totalSlides={review.slides.length}
              prUrl={review.prUrl}
              checkedChecks={checkedChecks}
              onToggleCheck={toggleCheck}
              pendingComments={comments}
              commentCallbacks={commentCallbacks}
              diffLayout={diffLayout}
              diffAppearance={diffAppearance}
              onDiffAppearanceChange={handleDiffAppearanceChange}
              onDiffLayoutChange={handleDiffLayoutChange}
              onAskQuestion={() => {
                setExploreOpen(false);
                setChatOpen(true);
              }}
              onExplore={
                review.reviewId
                  ? () => {
                      setChatOpen(false);
                      setExploreOpen(true);
                    }
                  : undefined
              }
              onAskAboutSelection={(code) => {
                setExploreOpen(false);
                setChatQuotedCode(code);
                setChatOpen(true);
              }}
              viewMode={slideViewMode}
              fileMetadataMap={fileMetadataMap}
              gitFileUrlBase={gitFileUrlBase}
              excludedFiles={excludedFilesSet}
              isReviewed={reviewed.has(currentSlide)}
              onMarkReviewed={() => markReviewedAndAdvance(currentSlide)}
              onToggleReviewed={() => toggleReviewed(currentSlide)}
              leftSlot={
                chatOpen ? (
                  <SlideChatSheet
                    embedded
                    open={chatOpen}
                    onOpenChange={setChatOpen}
                    slideTitle={review.slides[currentSlide - 1].title}
                    reviewFocus={review.slides[currentSlide - 1].reviewFocus}
                    messages={slideChat.getMessages(currentSlide)}
                    isStreaming={slideChat.isStreaming}
                    onSend={(text) => void slideChat.send(currentSlide, text)}
                    quotedCode={chatQuotedCode}
                    onQuotedCodeConsumed={() => setChatQuotedCode(null)}
                  />
                ) : undefined
              }
              rightSlot={
                exploreOpen && review.reviewId ? (
                  <ExplainerView
                    key={`${review.reviewId}:${review.slides[currentSlide - 1].id}`}
                    reviewId={review.reviewId}
                    slide={review.slides[currentSlide - 1]}
                    onClose={() => setExploreOpen(false)}
                    onSaved={(artifact) =>
                      setReview((prev) => ({
                        ...prev,
                        slides: prev.slides.map((s, i) => (i === currentSlide - 1 ? { ...s, explainer: artifact } : s)),
                      }))
                    }
                  />
                ) : undefined
              }
            />
          )}
        </div>
      </div>

      {
        <SlideNav
          current={currentSlide}
          total={review.slides.length}
          reviewedCount={reviewedCount}
          prevTitle={prevTitle}
          nextTitle={nextTitle}
          onPrev={handlePrev}
          onNext={handleNext}
          commentCount={comments.length}
          onSubmitReview={isLocal ? undefined : () => setShowSubmitDialog(true)}
        />
      }

      {!isLocal && (
        <SubmitReviewDialog
          open={showSubmitDialog}
          onOpenChange={setShowSubmitDialog}
          comments={selectedComments.map((c) => ({ ...c, filePath: sourceForPath(review, c.filePath).path }))}
          prUrl={submitUrl}
          headSha={submitMember?.headSha ?? review.headSha}
          isOwnPr={currentLogin !== null && currentLogin === (submitMember?.author ?? review.author)}
          onSubmit={handleSubmitReview}
        />
      )}

      <SettingsDialog
        initialSection="review"
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
