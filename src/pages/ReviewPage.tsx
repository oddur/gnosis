import { watchGitHub } from '../../lib/watch-github';
import { usePrDiscussions } from '../../lib/use-pr-discussions';
import { RecentlyViewed } from '../../components/RecentlyViewed';
import { ReviewBreadcrumbProvider, useReviewBreadcrumbs } from '../../lib/review-breadcrumbs';
import { ReviewBreadcrumbs } from '../../components/ReviewBreadcrumbs';
import { SearchableSelect } from '../../components/SearchableSelect';
import { useDiffAppearance } from '../../lib/use-diff-appearance';
import { refreshDiscussion } from '../../lib/review-discussion-cache';
import { useChangesComments } from '../../components/useChangesComments';
import { useExplanationComments } from '../../lib/use-explanation-comments';
import { explanationSubject, rememberExplanation } from '../../lib/explanation-workspace';
import { rememberCommandDestination } from '../../lib/command-recents';
import { findReviewLine } from '../../components/ReviewDiff';
import { useCommandCenter, useCommandScope } from '../../lib/command-center';
import type { SearchDestination } from '../../lib/command-search';
import { useSessionDraft } from '../../lib/session-drafts';
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { type DiffAppearance } from '../../lib/review-diff';
import { ArrowLeft, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { PRSummaryBanner } from '../../components/PRSummaryBanner';
import { StaleBanner } from '../../components/StaleBanner';
import { WorkbenchOverview } from '../../components/WorkbenchOverview';
import { coverageKey, subjectForReview } from '../../lib/workbench';
import { SlideView } from '../../components/SlideView';
import { ExplainerView } from '../../components/ExplainerView';
import { toast } from '../../components/ui/toast';
import { SlideNav } from '../../components/SlideNav';
import { TocRail } from '../../components/TocRail';
import { SlideChatSheet } from '../../components/SlideChatSheet';
import { WorkbenchHelp } from '../../components/WorkbenchHelp';
import { SettingsDialog } from '../../components/SettingsDialog';
import { ShortcutOverlay } from '../../components/ShortcutOverlay';
import { CommandPalette, type Command } from '../../components/CommandPalette';
import { useViewedFiles } from '../../lib/use-viewed-files';
import { useSlideChat } from '../../lib/use-slide-chat';
import { useKeyboardShortcuts, type ShortcutMap } from '../../lib/use-keyboard-shortcuts';
import { buildFileUrlBase } from '../../lib/github-url';
import { isLocalUrl } from '../../lib/local-url';
import type { ReviewGuide, FreshnessResult, Preferences, Provider, ModelId } from '../../lib/types';
import { DEFAULT_FAST_CLAUDE_MODEL, PROVIDERS } from '../../lib/models';

interface Props {
  review: ReviewGuide;
  origin?: { name: string; reviews: { id: string; title: string }[] };
  onSelectReview?: (id: string) => void;
  embedded?: boolean;
  active?: boolean;
  initialPreferences?: Preferences;
  onOpenChanges?: () => void;
  onBack: () => void;
  onReReview: (prUrl: string) => void;
  initialSlideId?: string;
  commandDestination?: { destination: Extract<SearchDestination, { kind: 'review' }>; nonce: number };
  exploreInitially?: boolean;
  onShowActivity: () => void;
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

function ReviewPageContent({
  review: initialReview,
  onBack,
  onReReview,
  initialSlideId,
  commandDestination,
  exploreInitially,
  onShowActivity,
  embedded = false,
  active = true,
  initialPreferences,
  onOpenChanges,
  origin,
  onSelectReview,
}: Props) {
  const commandCenter = useCommandCenter();
  const [review, setReview] = useState(initialReview);
  useEffect(() => setReview(initialReview), [initialReview]);
  useEffect(() => rememberExplanation(review), [review]);
  const [consumedCommand, setConsumedCommand] = useSessionDraft('review-command', 0);
  const { viewedFiles, setFileViewed } = useViewedFiles(review);
  const [currentSlide, setCurrentSlide] = useState(() => {
    if (initialSlideId) return initialReview.slides.find((s) => s.id === initialSlideId)?.slideNumber ?? 0;
    try {
      const saved = Number(
        localStorage.getItem(`gnosis-position:${subjectForReview(initialReview)}:${initialReview.reviewId}`) ?? 0
      );
      return Number.isInteger(saved) && saved >= 0 && saved <= initialReview.slides.length ? saved : 0;
    } catch {
      return 0;
    }
  });
  const [navOpen, setNavOpen] = useSessionDraft('topics-open', false);
  const [submitUrl, setSubmitUrl] = useState(
    initialReview.snapshot?.subject.members.find((m) => !m.merged && m.state === 'open')?.url ?? initialReview.prUrl
  );
  // Discovery may be ahead of this walkthrough. Submit only the revision actually displayed;
  // GitHub submission validation rejects it if the PR has since changed.
  const submitMember = explanationSubject(review).members.find((m) => m.url === submitUrl);
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
  const [chatOpen, setChatOpen] = useSessionDraft('chat-open', false);
  const [chatFocusRequest, setChatFocusRequest] = useState(0);
  const openChat = useCallback(() => {
    setChatOpen(true);
    setChatFocusRequest((request) => request + 1);
  }, [setChatOpen]);
  const [chatQuotedCode, setChatQuotedCode] = useState<string | null>(null);
  const [chatProvider, setChatProvider] = useState<Provider>(initialPreferences?.provider ?? 'claude');
  const [chatModel, setChatModel] = useState<ModelId>(initialPreferences?.model ?? DEFAULT_FAST_CLAUDE_MODEL);
  const [diffLayout, setDiffLayout] = useState<Preferences['diffLayout']>(initialPreferences?.diffLayout ?? 'unified');
  const [slideViewMode, setSlideViewMode] = useSessionDraft<'split' | 'focus'>('slide-view', 'split');
  const [prefs, setPrefs] = useState<Preferences | null>(initialPreferences ?? null);
  const preferenceWrites = useRef(Promise.resolve());
  const pendingPreferences = useRef<Partial<Preferences>>({});
  const [preferenceError, setPreferenceError] = useState('');
  const diffAppearance = useDiffAppearance(prefs?.diffAppearance);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [exploreOpen, setExploreOpen] = useSessionDraft('explore-open', exploreInitially ?? false);
  const generatingExplainers = useRef(new Set<string>());

  function openExplainer() {
    if (currentSlide < 1) return;
    const slide = review.slides.at(currentSlide - 1);
    if (!review.reviewId || !slide) return;
    if (slide.explainer) {
      setChatOpen(false);
      setExploreOpen(true);
      return;
    }
    if (generatingExplainers.current.has(slide.id)) {
      onShowActivity();
      return;
    }
    generatingExplainers.current.add(slide.id);
    const notification = toast.add({
      title: 'Building interactive explanation',
      description: 'Keep reviewing. We’ll notify you when it’s ready.',
      actionProps: {
        children: 'View activity',
        onClick: () => {
          onShowActivity();
          toast.close(notification);
        },
      },
    });
    void window.electronAPI
      .generateExplainer({ reviewId: review.reviewId, slideId: slide.id })
      .then((artifact) => {
        setReview((previous) => ({
          ...previous,
          slides: previous.slides.map((s) => (s.id === slide.id ? { ...s, explainer: artifact } : s)),
        }));
        toast.close(notification);
      })
      .catch(() => {
        toast.close(notification);
        const failed = toast.add({
          title: 'Interactive explanation stopped',
          description: 'View Activity for details and retry options.',
          actionProps: {
            children: 'View activity',
            onClick: () => {
              onShowActivity();
              toast.close(failed);
            },
          },
        });
      })
      .finally(() => generatingExplainers.current.delete(slide.id));
  }

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
  const { comments, addComment, removeComment, editComment } = useExplanationComments(review, currentLogin ?? '');
  const sharedReview = useChangesComments({
    enabled: !isLocalUrl(review.prUrl),
    snapshot: submitMember
      ? {
          version: 1,
          url: submitMember.url,
          metadata: submitMember,
          comparisonBase: submitMember.baseSha,
          files: [],
          fetchedAt: 0,
        }
      : undefined,
    activeKey: `explanation:${submitUrl}`,
    inline: [],
    replaceThread: () => {},
    refresh: async (url) => {
      await refreshDiscussion(url).catch(() => {});
    },
    onOpenChanges,
    onSubmitted: (url, event) => {
      const next = {
        ...submissions,
        [url]:
          event === 'APPROVE'
            ? 'Approval submitted'
            : event === 'REQUEST_CHANGES'
              ? 'Changes requested'
              : 'Comments submitted',
      };
      setSubmissions(next);
      try {
        localStorage.setItem(submissionKey, JSON.stringify(next));
      } catch {
        // GitHub already accepted this review. A local marker cannot turn it into a failed submission.
      }
    },
  });
  useEffect(() => {
    if (showSubmitDialog) {
      sharedReview.openReview();
      setShowSubmitDialog(false);
    }
  }, [showSubmitDialog, submitUrl]);
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
    if (!initialPreferences) return;
    setPrefs(initialPreferences);
    setChatProvider(initialPreferences.provider);
    setChatModel(initialPreferences.model);
    setDiffLayout(initialPreferences.diffLayout);
  }, [initialPreferences]);
  useEffect(() => {
    let cancelled = false;
    const writesAtLoad = preferenceWrites.current;
    void window.electronAPI
      .loadPreferences()
      .then((p) => {
        // Parent preferences seed an instant render, but may predate changes saved
        // in a previous review. Do not let this refresh overwrite a newer edit.
        if (cancelled || writesAtLoad !== preferenceWrites.current) return;
        setPrefs(p);
        setChatProvider(p.provider);
        setChatModel(p.model);
        setDiffLayout(p.diffLayout);
      })
      .catch(() => {
        if (!cancelled)
          toast.add({
            title: 'Could not load review settings',
            description: 'Open Settings to check your saved preferences.',
          });
      });
    return () => {
      cancelled = true;
    };
  }, [initialPreferences]);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI
      .getAuthState()
      .then((state) => {
        if (!cancelled) setCurrentLogin(state.login);
      })
      .catch(() => {
        if (!cancelled) setCurrentLogin(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const isLocal = isLocalUrl(review.prUrl);
  const syncMembers = explanationSubject(review).members;
  usePrDiscussions(active && !isLocal ? syncMembers.map(member => member.url) : []);
  useEffect(() => {
    if (!active || isLocal) return;
    return watchGitHub({ kind: 'metadata', priority: 'active', targets: syncMembers.map(member => ({ url: member.url })) }, update => {
      if (update.kind !== 'metadata') return;
      const shown = syncMembers.find(member => member.url === update.url);
      if (shown && (shown.headSha !== update.value.headSha || shown.baseSha !== update.value.baseSha))
        setFreshness({ status: 'stale', aheadBy: 0, commits: [], reason: 'New commits are available. This explanation still shows its saved revision.' });
    });
  }, [active, isLocal, review.reviewId]);
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
    if (isLocal || embedded) return;
    let cancelled = false;
    void (
      review.snapshot
        ? window.electronAPI.workbenchFreshness(review.snapshot)
        : Promise.resolve({
            status: 'unknown',
            reason: 'This saved review predates revision tracking. Regenerate it to check all dependencies.',
          } as FreshnessResult)
    )
      .then((result) => {
        if (!cancelled) setFreshness(result);
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setFreshness({ status: 'unknown', reason: error instanceof Error ? error.message : String(error) });
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

  useReviewBreadcrumbs('explanation', [{ id: 'topic',
    label: currentSlide === 0 ? 'Overview' : review.slides[currentSlide - 1]?.title ?? 'Overview',
    pickerLabel: 'Review topic', value: String(currentSlide),
    options: [{ value: '0', label: 'Overview' }, ...review.slides.map(s => ({ value: String(s.slideNumber), label: s.title }))],
    select: value => handleJumpTo(Number(value)),
  }]);
  const commentCallbacks = useMemo(
    () => ({ onAddComment: addComment, onRemoveComment: removeComment, onEditComment: editComment }),
    [addComment, removeComment, editComment]
  );

  const savePreferencePatch = useCallback((patch: Partial<Preferences>) => {
    pendingPreferences.current = { ...pendingPreferences.current, ...patch };
    setPrefs((current) => (current ? { ...current, ...patch } : current));
    preferenceWrites.current = preferenceWrites.current
      .then(async () => {
        const saving = { ...pendingPreferences.current };
        if (!Object.keys(saving).length) return;
        const current = await window.electronAPI.loadPreferences();
        await window.electronAPI.savePreferences({ ...current, ...saving });
        const remaining = { ...pendingPreferences.current };
        for (const key of Object.keys(saving) as (keyof Preferences)[])
          if (remaining[key] === saving[key]) Reflect.deleteProperty(remaining, key);
        pendingPreferences.current = remaining;
        setPreferenceError('');
      })
      .catch(() => setPreferenceError('Could not save your diff settings. Your choices still apply in this view.'));
  }, []);

  const handleDiffLayoutChange = useCallback(
    (layout: Preferences['diffLayout']) => {
      setDiffLayout(layout);
      savePreferencePatch({ diffLayout: layout });
    },
    [savePreferencePatch]
  );

  const handleDiffAppearanceChange = useCallback(
    (value: DiffAppearance) => {
      savePreferencePatch({ diffAppearance: value });
    },
    [savePreferencePatch]
  );

  const handleShowInlineExplanationsChange = useCallback(
    (show: boolean) => {
      savePreferencePatch({ showInlineExplanations: show });
    },
    [savePreferencePatch]
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
      // Review progress
      r: () => {
        if (currentSlide > 0) markReviewedAndAdvance(currentSlide);
      },
      n: () => jumpToNextUnreviewed(),
      // Global
      'cmd+k': () => (commandCenter ? commandCenter.open() : setPaletteOpen(true)),
      'ctrl+k': () => (commandCenter ? commandCenter.open() : setPaletteOpen(true)),
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

  useKeyboardShortcuts(shortcutMap, { enabled: active && !exploreOpen });
  useKeyboardShortcuts({ c: openChat }, {
    enabled: active && !exploreOpen && currentSlide > 0,
    capture: true,
  });

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
          perform: openChat,
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
  }, [review.slides, currentSlide, comments.length, handleJumpTo, handleDiffLayoutChange, onBack, openChat]);

  useEffect(() => {
    if (review.reviewId && currentLogin)
      rememberCommandDestination(
        currentLogin,
        currentSlide ? `topic:${review.reviewId}:${review.slides[currentSlide - 1]?.id}` : `summary:${review.reviewId}`
      );
  }, [review.reviewId, currentSlide, currentLogin]);
  useCommandScope(
    'review',
    active
      ? [
          ...paletteCommands
            .filter((c) => ['chat', 'submit', 'unified', 'split'].includes(c.id))
            .map((c) => ({ ...c, id: `review:${c.id}` })),
          ...(currentSlide > 0
            ? [
                {
                  id: 'review:explore',
                  label: review.slides[currentSlide - 1]?.explainer
                    ? 'Open interactive explanation'
                    : 'Create interactive explanation',
                  group: 'Current topic · tracked in Activity',
                  perform: openExplainer,
                },
              ]
            : []),
          ...paletteCommands
            .filter((c) => !['chat', 'submit', 'unified', 'split'].includes(c.id))
            .map((c) => ({ ...c, id: `review:${c.id}` })),
        ]
      : []
  );
  useEffect(() => {
    const target = commandDestination?.destination;
    if (!active || !target || target.reviewId !== review.reviewId || consumedCommand === commandDestination.nonce)
      return;
    setConsumedCommand(commandDestination.nonce);
    const index =
      target.slideId === 'overview'
        ? 0
        : target.slideId
          ? review.slides.find((s) => s.id === target.slideId)?.slideNumber
          : undefined;
    if (index !== undefined) setCurrentSlide(index);
    if (target.slideId || target.filePath || target.explore !== undefined) {
      setExploreOpen(!!target.explore);
      setChatOpen(false);
    }
    if (!target.filePath) return;
    setSlideViewMode('focus');
    const filePath = target.filePath;
    let tries = 0;
    const timer = setInterval(() => {
      const file = [...document.querySelectorAll<HTMLElement>('.review-file-group[data-file-path]')].find(
        (el) => el.dataset.filePath === filePath
      );
      if (file) {
        const collapsed = file.querySelector<HTMLButtonElement>(
          '.review-file-context[data-collapsed=true] .review-file-expand'
        );
        if (collapsed) {
          collapsed.click();
          return;
        }
        let match: HTMLElement | null = target.line ? findReviewLine(file, filePath, target.line, target.side) : file;
        if (target.threadId) {
          const thread = file.querySelector<HTMLDetailsElement>(`[data-thread-id="${CSS.escape(target.threadId)}"]`);
          if (thread) {
            thread.open = true;
            match = thread;
          }
        }
        if (!match && ++tries < 30) return;
        match ??= file;
        document.querySelectorAll('.search-arrival').forEach((el) => el.classList.remove('search-arrival'));
        match.scrollIntoView({ block: 'center' });
        match.classList.add('search-arrival');
        match.tabIndex = -1;
        match.focus({ preventScroll: true });
        clearInterval(timer);
      } else if (++tries > 50) clearInterval(timer);
    }, 60);
    return () => clearInterval(timer);
  }, [commandDestination, review.reviewId, active]);

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
  const progress = review.slides.length ? Math.min(100, Math.max(0, (currentSlide / review.slides.length) * 100)) : 0;

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
      <div
        className="relative h-px w-full bg-transparent shrink-0"
        role="progressbar"
        aria-label="Review position"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
        aria-valuetext={currentSlide === 0 ? 'Overview' : `Topic ${currentSlide} of ${review.slides.length}`}
      >
        <div
          className="absolute left-0 top-0 h-px bg-[var(--ring)] loading-progress-fill"
          style={{ width: `${progress}%` }}
        />
      </div>

      {!embedded && <div className="pr-summary-toolbar"><div className="pr-summary-toolbar-inner">
        <RecentlyViewed />
        <ReviewBreadcrumbs scope="explanation" base={[
          { id: 'origin', label: origin?.name ?? 'Review queue', navigate: onBack },
          ...(isLocal ? [{ id: 'repository', label: review.prUrl.slice(6).split('#')[0].split('/').filter(Boolean).pop() ?? 'Local repository', title: review.prUrl }] : []),
          { id: 'review', label: review.prTitle, navigate: () => handleJumpTo(0),
            pickerLabel: 'Saved review', value: review.reviewId, options: origin?.reviews.map(r => ({ value: r.id, label: r.title })), select: onSelectReview },
          { id: 'tab', label: 'Explanation' },
        ]} />
      </div></div>}
      {!embedded && <PRSummaryBanner review={review} onOpenSettings={() => setSettingsOpen(true)} />}

      {!embedded && freshness && <StaleBanner freshness={freshness} onReReview={() => onReReview(review.prUrl)} />}

      {preferenceError && (
        <div className="changes-notice" role="alert">
          {preferenceError} <button onClick={() => savePreferencePatch({})}>Retry saving diff settings</button>
        </div>
      )}

      <div className="review-toolbar">
        {!embedded && (
          <>
            <button
              onClick={() => (commandCenter ? commandCenter.open() : setPaletteOpen(true))}
              title="Search and navigate (⌘K / Ctrl K)"
            >
              Search <kbd className="kbd">{window.electronAPI.platform === 'darwin' ? '⌘ K' : 'Ctrl K'}</kbd>
            </button>
            <WorkbenchHelp />
          </>
        )}
        <button onClick={() => setNavOpen((v) => !v)} aria-pressed={navOpen} title="Toggle topic navigation">
          {navOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}Topics
        </button>
        {exploreOpen && (
          <button onClick={() => setExploreOpen(false)}>
            <X size={13} />
            Close interactive explanation
          </button>
        )}
        {review.snapshot?.subject.kind === 'stack' && (
          <div className="review-submit-target ml-auto flex items-center gap-2 text-xs">
            Send feedback to
            <SearchableSelect label="PR for review submission" value={submitUrl} onValueChange={setSubmitUrl}
              options={review.snapshot.subject.members.map(m => ({ value: m.url,
                label: `#${m.number} ${m.repo} · ${m.title}${m.merged ? ' (merged)' : ''}` }))}
            />
          </div>
        )}
        {!isLocal && sharedReview.controls}
      </div>
      {!isLocal && active && sharedReview.panel}

      <div className={`review-chat-workspace flex-1 overflow-hidden flex flex-row min-h-0${chatOpen && currentSlide > 0 ? ' chat-open' : ''}`}>
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
        <div key={currentSlide} className="review-chat-content flex-1 min-w-0 overflow-hidden flex flex-col">
          {currentSlide === 0 ? (
            <WorkbenchOverview
              review={review}
              embedded={embedded}
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
              key={review.snapshot?.fingerprint ?? review.headSha ?? review.reviewId}
              review={review}
              chatOpen={chatOpen}
              viewedFiles={viewedFiles}
              onFileViewedChange={setFileViewed}
              onContinue={() => handleJumpTo(currentSlide < review.slides.length ? currentSlide + 1 : 0)}
              nextTopicTitle={nextTitle}
              showReviewSuggestions={prefs?.reviewSuggestions !== false}
              showInlineExplanations={prefs?.showInlineExplanations !== false}
              onShowInlineExplanationsChange={handleShowInlineExplanationsChange}
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
                openChat();
              }}
              onExplore={review.reviewId ? openExplainer : undefined}
              onAskAboutSelection={(code) => {
                setExploreOpen(false);
                setChatQuotedCode(code);
                openChat();
              }}
              viewMode={slideViewMode}
              fileMetadataMap={fileMetadataMap}
              gitFileUrlBase={gitFileUrlBase}
              excludedFiles={excludedFilesSet}
              isReviewed={reviewed.has(currentSlide)}
              onMarkReviewed={() => markReviewedAndAdvance(currentSlide)}
              onToggleReviewed={() => toggleReviewed(currentSlide)}
              rightSlot={
                exploreOpen && review.reviewId ? (
                  <ExplainerView
                    key={`${review.reviewId}:${review.slides[currentSlide - 1].id}`}
                    reviewId={review.reviewId}
                    slide={review.slides[currentSlide - 1]}
                    onClose={() => setExploreOpen(false)}
                    onShowActivity={onShowActivity}
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
        {chatOpen && currentSlide > 0 && (
          <SlideChatSheet
            embedded
            open={chatOpen}
            focusRequest={chatFocusRequest}
            onOpenChange={setChatOpen}
            slideId={`${review.reviewId ?? review.prUrl}:${review.snapshot?.fingerprint ?? review.headSha ?? ''}:${review.slides[currentSlide - 1].id}`}
            slideTitle={review.slides[currentSlide - 1].title}
            reviewFocus={prefs?.reviewSuggestions === false ? null : review.slides[currentSlide - 1].reviewFocus}
            messages={slideChat.getMessages(currentSlide)}
            isStreaming={slideChat.isStreaming}
            onSend={(text, selection) => void slideChat.send(currentSlide, text, selection)}
            onRetry={(id) => void slideChat.retry(currentSlide, id)}
            onStop={() => slideChat.stop(currentSlide)}
            modelLabel={PROVIDERS[chatProvider].models.find(model => model.id === chatModel)?.label ?? chatModel}
            quotedCode={chatQuotedCode}
            onQuotedCodeConsumed={() => setChatQuotedCode(null)}
          />
        )}
      </div>

      {
        <SlideNav
          compact={chatOpen}
          current={currentSlide}
          total={review.slides.length}
          reviewedCount={reviewedCount}
          prevTitle={prevTitle}
          nextTitle={nextTitle}
          onPrev={handlePrev}
          onNext={handleNext}
          commentCount={sharedReview.draftCount}
          onSubmitReview={isLocal || embedded ? undefined : () => setShowSubmitDialog(true)}
        />
      }

      <SettingsDialog
        initialSection="review"
        open={active && settingsOpen}
        onOpenChange={setSettingsOpen}
        onThemeChange={async () => {
          const updated = await window.electronAPI.reRenderHunks(review);
          setReview(updated);
        }}
      />

      <ShortcutOverlay open={active && shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      {!commandCenter && (
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={paletteCommands} />
      )}
    </div>
  );
}

export function ReviewPage(props: Props) {
  return props.embedded ? <ReviewPageContent {...props} />
    : <ReviewBreadcrumbProvider><ReviewPageContent {...props} /></ReviewBreadcrumbProvider>;
}
