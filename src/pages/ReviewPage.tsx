import { activeWorkspaceRoot } from '../../lib/workspace-navigation';
import { useSettingsShortcut } from '../../lib/use-settings-shortcut';
import { watchGitHub } from '../../lib/watch-github';
import { usePrDiscussions } from '../../lib/use-pr-discussions';
import { WorkspaceMenu } from '../../components/AppTitlebar';
import { normalizeEffort } from '../../lib/effort';
import { ReviewBreadcrumbProvider, useReviewBreadcrumbs } from '../../lib/review-breadcrumbs';
import { ReviewBreadcrumbs } from '../../components/ReviewBreadcrumbs';
import { SearchableSelect } from '../../components/SearchableSelect';
import { useDiffAppearance } from '../../lib/use-diff-appearance';
import { publishDiffLayout, useDiffLayout, useDiffLayoutTarget } from '../../lib/use-diff-layout';
import { DIFF_LAYOUT_KEYS } from '../../lib/diff-layout';
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
import { ArrowLeft, X } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Markdown } from '../../components/Markdown';
import { DiffAppearanceMenu } from '../../components/DiffAppearanceMenu';
import { WorkbenchIcon } from '../../components/WorkbenchIcon';
import { workbenchIcons, workspaceSections } from '../../lib/interface-icons';
import { PRSummaryBanner } from '../../components/PRSummaryBanner';
import { StaleBanner } from '../../components/StaleBanner';
import { ExplanationReader, type ExplanationReaderHandle } from '../../components/ExplanationReader';
import { readReviewState, writeReviewState } from '../../lib/renderer-review-state';
import { explanationPositionKey } from '../../lib/use-explanation-scroll';
import { subjectForReview } from '../../lib/workbench';
import { SlideView } from '../../components/SlideView';
import { ExplainerView } from '../../components/ExplainerView';
import { toast } from '../../components/ui/toast';
import { SlideChatSheet } from '../../components/SlideChatSheet';
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

export interface ChangesFileTarget {
  url: string;
  headSha?: string;
  path: string;
  line?: number;
  endLine?: number;
  side?: 'before' | 'after';
}

interface Props {
  review: ReviewGuide;
  origin?: { name: string; reviews: { id: string; title: string }[] };
  onSelectReview?: (id: string) => void;
  embedded?: boolean;
  active?: boolean;
  initialPreferences?: Preferences;
  onOpenChanges?: () => void;
  /** Opens one file, optionally at a line range, in the PR's Changes view. */
  onOpenChangesFile?: (target: ChangesFileTarget) => void;
  onBack: () => void;
  /** Opens a queue destination in this workspace; the title bar uses it for home, setup and account actions. */
  onNavigateHome?: (target: Extract<SearchDestination, { kind: 'home' }>) => void;
  onReReview: (prUrl: string, previousReviewId?: string) => void;
  regenerating?: boolean;
  initialSlideId?: string;
  commandDestination?: { destination: Extract<SearchDestination, { kind: 'review' }>; nonce: number };
  exploreInitially?: boolean;
  onShowActivity: () => void;
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
  onNavigateHome,
  onReReview,
  regenerating = false,
  initialSlideId,
  commandDestination,
  exploreInitially,
  onShowActivity,
  embedded = false,
  active = true,
  initialPreferences,
  onOpenChanges,
  onOpenChangesFile,
  origin,
  onSelectReview,
}: Props) {
  const commandCenter = useCommandCenter();
  const [review, setReview] = useState(initialReview);
  const appliedReview = useRef(initialReview);
  useEffect(() => {
    if (appliedReview.current !== initialReview) {
      appliedReview.current = initialReview;
      setReview(initialReview);
    }
  }, [initialReview]);
  useEffect(() => rememberExplanation(review), [review]);
  const [consumedCommand, setConsumedCommand] = useSessionDraft('review-command', 0);
  const { viewedFiles, setFileViewed } = useViewedFiles(review);
  const reader = useRef<ExplanationReaderHandle>(null);
  const reviewRoot = useRef<HTMLDivElement>(null);
  const [inlineExplanationNotice, setInlineExplanationNotice] = useState('');
  const readingSection = useRef(0);
  const positionId = `${review.reviewId ?? review.prUrl}:${review.snapshot?.fingerprint ?? review.headSha ?? ''}`;
  const [currentSlide, setCurrentSlide] = useState(() => {
    try {
      const saved = readReviewState(explanationPositionKey(positionId, 'inspected'));
      if (!initialSlideId && typeof saved === 'number' && saved > 0 && saved <= initialReview.slides.length)
        return saved;
    } catch {
      /* Older reviews use their previous topic position. */
    }
    if (initialSlideId) return initialReview.slides.find((s) => s.id === initialSlideId)?.slideNumber ?? 1;
    try {
      const saved = Number(
        localStorage.getItem(`gnosis-position:${subjectForReview(initialReview)}:${initialReview.reviewId}`) ?? 0
      );
      return Number.isInteger(saved) && saved >= 0 && saved <= initialReview.slides.length ? Math.max(1, saved) : 1;
    } catch {
      return 1;
    }
  });
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
  useSettingsShortcut(() => setSettingsOpen(true), active && !embedded);
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
  const [savedDiffLayout, setDiffLayout] = useState<Preferences['diffLayout']>(
    initialPreferences?.diffLayout ?? 'unified'
  );
  const diffLayout = useDiffLayout(savedDiffLayout);
  const [prefs, setPrefs] = useState<Preferences | null>(initialPreferences ?? null);
  const preferenceWrites = useRef(Promise.resolve());
  const pendingPreferences = useRef<Partial<Preferences>>({});
  const [preferenceError, setPreferenceError] = useState('');
  const diffAppearance = useDiffAppearance(prefs?.diffAppearance);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [exploreOpen, setExploreOpen] = useSessionDraft('explore-open', exploreInitially ?? false);
  const generatingExplainers = useRef(new Set<string>());

  function openExplainer(section = Math.max(1, currentSlide)) {
    setCurrentSlide(section);
    reader.current?.showCode(section);
    const slide = review.slides.at(section - 1);
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
  const slideChat = useSlideChat(review, chatProvider, chatModel, prefs?.effort);
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
  usePrDiscussions(active && !isLocal ? syncMembers.map((member) => member.url) : []);
  useEffect(() => {
    if (!active || isLocal) return;
    return watchGitHub(
      { kind: 'metadata', priority: 'active', targets: syncMembers.map((member) => ({ url: member.url })) },
      (update) => {
        if (update.kind !== 'metadata') return;
        const shown = syncMembers.find((member) => member.url === update.url);
        if (shown && (shown.headSha !== update.value.headSha || shown.baseSha !== update.value.baseSha))
          setFreshness({
            status: 'stale',
            aheadBy: 0,
            commits: [],
            reason: 'New commits are available. This explanation still shows its saved revision.',
          });
      }
    );
  }, [active, isLocal, review.reviewId]);
  useEffect(() => {
    void writeReviewState(explanationPositionKey(positionId, 'inspected'), currentSlide).catch(() => {});
  }, [positionId, currentSlide]);
  useEffect(() => {
    if (chatOpen || exploreOpen) {
      if (!focusBeforeTool.current) focusBeforeTool.current = document.activeElement as HTMLElement;
    } else {
      focusBeforeTool.current?.focus({ preventScroll: true });
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

  const handleJumpTo = useCallback(
    (n: number) => {
      const section = Math.max(0, Math.min(review.slides.length, n));
      reader.current?.navigate(section);
    },
    [review.slides.length]
  );
  const handlePrev = useCallback(() => handleJumpTo(readingSection.current - 1), [handleJumpTo]);
  const handleNext = useCallback(() => handleJumpTo(readingSection.current + 1), [handleJumpTo]);
  useReviewBreadcrumbs('explanation', []);
  function inspectCode(section: number, filePath?: string, line?: number) {
    setCurrentSlide(section);
    setExploreOpen(false);
    reader.current?.showCode(section);
    if (!filePath) return;
    setCodeTarget({ section, filePath, line, nonce: Date.now() });
  }
  const [codeTarget, setCodeTarget] = useState<{ section: number; filePath: string; line?: number; nonce: number }>();
  const inspectedTarget = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!codeTarget || inspectedTarget.current === codeTarget.nonce) return;
    let tries = 0;
    const timer = setInterval(() => {
      const file = activeWorkspaceRoot().querySelector<HTMLElement>(
        `[data-explanation-section="${codeTarget.section}"] .review-file-group[data-file-path="${CSS.escape(codeTarget.filePath)}"]`
      );
      if (file) {
        const collapsed = file.querySelector<HTMLButtonElement>(
          '.review-file-context[data-collapsed=true] .review-file-expand'
        );
        if (collapsed) {
          collapsed.click();
          return;
        }
        const target = codeTarget.line ? findReviewLine(file, codeTarget.filePath, codeTarget.line) : file;
        if (target) {
          inspectedTarget.current = codeTarget.nonce;
          target.scrollIntoView({ block: 'center' });
          target.classList.remove('check-highlight');
          void target.offsetWidth;
          target.classList.add('check-highlight');
          target.tabIndex = -1;
          target.focus({ preventScroll: true });
          clearInterval(timer);
        }
      }
      if (++tries > 40) clearInterval(timer);
    }, 50);
    return () => clearInterval(timer);
  }, [codeTarget]);
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
      publishDiffLayout(layout);
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
      const draft = reviewRoot.current?.querySelector<HTMLTextAreaElement>(
        '.explanation-document .review-code textarea'
      );
      if (draft) {
        draft.scrollIntoView({ block: 'center' });
        draft.focus({ preventScroll: true });
        setInlineExplanationNotice('Finish or cancel your comment before changing inline explanations.');
        return;
      }
      setInlineExplanationNotice('');
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
      // Diff layout keys (d, u, s) work in every diff view; see use-diff-layout-shortcuts.
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
  }, [handlePrev, handleNext, handleJumpTo, review.slides.length]);

  useKeyboardShortcuts(shortcutMap, { enabled: active && !exploreOpen });
  useDiffLayoutTarget(reviewRoot, handleDiffLayoutChange);
  useKeyboardShortcuts(
    {
      c: () => {
        const focusedSection = document.activeElement?.closest<HTMLElement>('[data-explanation-section]');
        setCurrentSlide(Number(focusedSection?.dataset.explanationSection) || readingSection.current || 1);
        openChat();
      },
    },
    {
      enabled: active && !exploreOpen && review.slides.length > 0,
      capture: true,
    }
  );

  const appliedSlide = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (initialSlideId && initialSlideId !== 'overview' && appliedSlide.current !== initialSlideId) {
      appliedSlide.current = initialSlideId;
      const index = review.slides.findIndex((s) => s.id === initialSlideId);
      if (index >= 0) reader.current?.navigate(index + 1);
    }
  }, [initialSlideId]);

  // Build the command palette commands. The slide jump entries
  // are generated dynamically from the review so they read like a
  // table of contents inside the palette.
  const paletteCommands = useMemo<Command[]>(() => {
    const commands: Command[] = [];

    commands.push({
      id: 'overview',
      icon: workspaceSections.summary.icon,
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
        icon: workspaceSections.explanation.icon,
        label: `${num}  ${slide.title}`,
        group: 'Reading',
        keywords: slide.title,
        perform: () => handleJumpTo(idx + 1),
      });
    });

    if (currentSlide > 0) {
      commands.push(
        {
          id: 'diff-layout',
          icon: workspaceSections.changes.icon,
          label: 'Switch between split and unified diff',
          hint: DIFF_LAYOUT_KEYS.toggle,
          group: 'Reviewing',
          keywords: 'toggle diff layout split unified side by side inline',
          perform: () => handleDiffLayoutChange(diffLayout === 'split' ? 'unified' : 'split'),
        },
        {
          id: 'unified',
          icon: workspaceSections.changes.icon,
          label: 'Switch to unified diff',
          hint: DIFF_LAYOUT_KEYS.unified,
          group: 'Reviewing',
          keywords: 'diff layout combine',
          perform: () => handleDiffLayoutChange('unified'),
        },
        {
          id: 'split',
          icon: workspaceSections.changes.icon,
          label: 'Switch to split diff',
          hint: DIFF_LAYOUT_KEYS.split,
          group: 'Reviewing',
          keywords: 'diff layout side by side',
          perform: () => handleDiffLayoutChange('split'),
        },
        {
          id: 'chat',
          icon: workbenchIcons.chat,
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
        icon: workbenchIcons.review,
        label: comments.length > 0 ? `Submit to GitHub (${comments.length} comments)` : 'Submit to GitHub',
        group: 'Reviewing',
        keywords: 'send post approve',
        perform: () => setShowSubmitDialog(true),
      },
      {
        id: 'shortcuts',
        icon: workbenchIcons.help,
        label: 'Show keyboard shortcuts',
        hint: '?',
        group: 'Anywhere',
        keywords: 'help cheatsheet keys',
        perform: () => setShortcutsOpen(true),
      },
      {
        id: 'settings',
        icon: workbenchIcons.settings,
        label: 'Open settings',
        group: 'Anywhere',
        keywords: 'preferences config theme font',
        perform: () => setSettingsOpen(true),
      },
      {
        id: 'back',
        icon: ArrowLeft,
        label: 'Back to home',
        group: 'Anywhere',
        keywords: 'exit close leave',
        perform: () => onBack(),
      }
    );

    return commands;
  }, [review.slides, currentSlide, comments.length, handleJumpTo, handleDiffLayoutChange, diffLayout, onBack, openChat]);

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
            // The app registers diff layout commands for every diff view.
            .filter((c) => ['chat', 'submit'].includes(c.id))
            .map((c) => ({ ...c, id: `review:${c.id}` })),
          ...(currentSlide > 0
            ? [
                {
                  id: 'review:explore',
                  icon: workbenchIcons.diagram,
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
    if (index !== undefined) {
      setCurrentSlide(Math.max(1, index));
      handleJumpTo(index);
    }
    if (target.slideId || target.filePath || target.explore !== undefined) {
      setExploreOpen(!!target.explore);
      setChatOpen(false);
    }
    if (!target.filePath) return;
    const matchedSection =
      index || review.slides.findIndex((s) => s.diffHunks.some((h) => h.filePath === target.filePath)) + 1;
    reader.current?.showCode(matchedSection || 1);
    const filePath = target.filePath;
    let tries = 0;
    const timer = setInterval(() => {
      const file = [
        ...activeWorkspaceRoot().querySelectorAll<HTMLElement>(
          `[data-explanation-section="${matchedSection || 1}"] .review-file-group[data-file-path]`
        ),
      ].find((el) => el.dataset.filePath === filePath);
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
        activeWorkspaceRoot().querySelectorAll('.search-arrival').forEach((el) => el.classList.remove('search-arrival'));
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
      <div className="explanation-empty explanation-no-topics">
        <h2>No explanation sections were generated</h2>
        {review.summary.trim() && <Markdown className="reading-prose">{review.summary}</Markdown>}
        <p>
          {onOpenChanges
            ? 'Try generating again, or inspect the files in Changes.'
            : 'Try generating again to create explanation sections.'}
        </p>
        <div className="explanation-empty-actions">
          <Button disabled={regenerating} onClick={() => onReReview(review.prUrl, review.reviewId)}>
            {regenerating ? 'Generating…' : 'Generate again'}
          </Button>
          {onOpenChanges && (
            <Button variant="outline" onClick={onOpenChanges}>
              Open Changes
            </Button>
          )}
          {!embedded && (
            <Button variant="ghost" onClick={onBack}>
              Back to review queue
            </Button>
          )}
        </div>
      </div>
    );
  }

  const inspected = Math.min(review.slides.length, Math.max(1, currentSlide));
  const inspectedSlide = review.slides[inspected - 1];
  const sharedSlideProps = {
    review,
    showDiffControls: false,
    viewedFiles,
    onFileViewedChange: setFileViewed,
    showReviewSuggestions: prefs?.reviewSuggestions !== false,
    showInlineExplanations: prefs?.showInlineExplanations !== false,
    onShowInlineExplanationsChange: handleShowInlineExplanationsChange,
    totalSlides: review.slides.length,
    prUrl: review.prUrl,
    checkedChecks,
    onToggleCheck: toggleCheck,
    pendingComments: comments,
    commentCallbacks,
    diffLayout,
    diffAppearance,
    onDiffAppearanceChange: handleDiffAppearanceChange,
    onDiffLayoutChange: handleDiffLayoutChange,
    fileMetadataMap,
    gitFileUrlBase,
    excludedFiles: excludedFilesSet,
  };
  const readerActions = (
    <div className="review-toolbar">
      <div className="explanation-diff-controls" role="group" aria-label="Diff display">
        <label className="inline-explanations-toggle">
          <input
            type="checkbox"
            checked={prefs?.showInlineExplanations !== false}
            onChange={(event) => handleShowInlineExplanationsChange(event.target.checked)}
          />
          Inline explanations
        </label>
        <DiffAppearanceMenu
          layout={diffLayout}
          onLayoutChange={handleDiffLayoutChange}
          value={diffAppearance}
          onChange={handleDiffAppearanceChange}
        />
      </div>
      <Button
        variant="outline"
        size="sm"
        title="Ask a question (C)"
        onClick={() => {
          if (!chatOpen) {
            setCurrentSlide(readingSection.current || 1);
            setExploreOpen(false);
          }
          openChat();
        }}
      >
        <WorkbenchIcon name="chat" /> Ask a question
      </Button>
      {exploreOpen && (
        <button onClick={() => setExploreOpen(false)}>
          <X size={13} />
          Close interactive explanation
        </button>
      )}
      {review.snapshot?.subject.kind === 'stack' && (
        <div className="review-submit-target ml-auto flex items-center gap-2 text-xs">
          <SearchableSelect
            label="PR for review submission"
            value={submitUrl}
            onValueChange={setSubmitUrl}
            options={review.snapshot.subject.members.map((m) => ({
              value: m.url,
              label: `#${m.number} ${m.repo} · ${m.title}${m.merged ? ' (merged)' : ''}`,
            }))}
          />
        </div>
      )}
      {!isLocal && sharedReview.controls}
    </div>
  );
  return (
    <div
      ref={reviewRoot}
      className="workbench-review flex flex-col h-full overflow-hidden"
      data-diff-layout={review.slides.length > 0 ? diffLayout : undefined}
    >
      {!embedded && (
        <WorkspaceMenu
          onHome={() => (onNavigateHome ? onNavigateHome({ kind: 'home', section: 'all' }) : onBack())}
          model={
            prefs
              ? {
                  provider: prefs.provider,
                  model: prefs.model,
                  effort: normalizeEffort(prefs.provider, prefs.model, prefs.effort, prefs.thinking),
                  onChange: (selection) => savePreferencePatch(selection),
                }
              : undefined
          }
          onSearch={() => (commandCenter ? commandCenter.open() : setPaletteOpen(true))}
          onGettingStarted={onNavigateHome && (() => onNavigateHome({ kind: 'home', onboarding: 'setup' }))}
          onWalkthrough={onNavigateHome && (() => onNavigateHome({ kind: 'home', onboarding: 'tour' }))}
          onSettings={() => setSettingsOpen(true)}
          account={{
            login: currentLogin,
            onClick: () =>
              onNavigateHome ? onNavigateHome({ kind: 'home', account: true }) : setSettingsOpen(true),
          }}
        />
      )}
      {!embedded && (
        <div className="pr-summary-toolbar">
          <div className="pr-summary-toolbar-inner">
            <ReviewBreadcrumbs
              scope="explanation"
              base={[
                { id: 'origin', label: origin?.name ?? 'Review queue', navigate: onBack },
                ...(isLocal
                  ? [
                      {
                        id: 'repository',
                        kind: 'repository' as const,
                        label:
                          review.prUrl.slice(6).split('#')[0].split('/').filter(Boolean).pop() ?? 'Local repository',
                        title: review.prUrl,
                      },
                    ]
                  : []),
                {
                  id: 'review',
                  kind: isLocal ? undefined : review.snapshot?.subject.kind === 'stack' ? 'stack' : 'pr',
                  label: review.prTitle,
                  navigate: () => handleJumpTo(0),
                  pickerLabel: 'Saved review',
                  value: review.reviewId,
                  options: origin?.reviews.map((r) => ({ value: r.id, label: r.title })),
                  select: onSelectReview,
                },
                { id: 'tab', workspaceTab: 'explanation', label: 'Explanation' },
              ]}
            />
          </div>
        </div>
      )}
      {!embedded && <PRSummaryBanner review={review} onOpenSettings={() => setSettingsOpen(true)} />}

      {!embedded && freshness && <StaleBanner freshness={freshness} onReReview={() => onReReview(review.prUrl, review.reviewId)} />}

      {preferenceError && (
        <div className="changes-notice" role="alert">
          {preferenceError} <button onClick={() => savePreferencePatch({})}>Retry saving diff settings</button>
        </div>
      )}

      {inlineExplanationNotice && (
        <p className="changes-notice" role="status">
          {inlineExplanationNotice}
        </p>
      )}
      {!isLocal && active && sharedReview.panel}

      <div
        className={`review-chat-workspace flex-1 overflow-hidden flex flex-row min-h-0${chatOpen && currentSlide > 0 ? ' chat-open' : ''}`}
      >
        <div className="review-chat-content flex-1 min-w-0 overflow-hidden flex flex-col">
          <ExplanationReader
            ref={reader}
            active={active}
            review={review}
            inspected={inspected}
            chatOpen={chatOpen}
            actions={readerActions}
            viewedFiles={viewedFiles}
            onReadingSection={(index) => {
              readingSection.current = index;
              if (!chatOpen && !exploreOpen) setCurrentSlide(index || 1);
            }}
            onOpenChanges={onOpenChanges}
            onReview={isLocal ? undefined : () => setShowSubmitDialog(true)}
            renderSection={(slide, index) => (
              <SlideView
                {...sharedSlideProps}
                presentation="narrative"
                slide={slide}
                slideNumber={index}
                onInspectCode={(path, line) => inspectCode(index, path, line)}
                onExplore={review.reviewId ? () => openExplainer(index) : undefined}
              />
            )}
            renderCode={(slide, index) => (
              <SlideView
                {...sharedSlideProps}
                presentation="code"
                slide={slide}
                slideNumber={index}
                onAskAboutSelection={(code) => {
                  setCurrentSlide(index);
                  setExploreOpen(false);
                  setChatQuotedCode(code);
                  openChat();
                }}
              />
            )}
            tool={
              exploreOpen && review.reviewId ? (
                <ExplainerView
                  key={`${review.reviewId}:${inspectedSlide.id}`}
                  reviewId={review.reviewId}
                  slide={inspectedSlide}
                  onClose={() => setExploreOpen(false)}
                  onShowActivity={onShowActivity}
                  onSaved={(artifact) =>
                    setReview((prev) => ({
                      ...prev,
                      slides: prev.slides.map((s) => (s.id === inspectedSlide.id ? { ...s, explainer: artifact } : s)),
                    }))
                  }
                />
              ) : undefined
            }
          />
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
            onOpenTraceStep={
              onOpenChangesFile &&
              ((step) =>
                step.path &&
                onOpenChangesFile({
                  url: review.prUrl,
                  headSha: review.headSha,
                  path: step.path,
                  line: step.startLine,
                  endLine: step.endLine,
                  side: step.side,
                }))
            }
            modelLabel={PROVIDERS[chatProvider].models.find((model) => model.id === chatModel)?.label ?? chatModel}
            quotedCode={chatQuotedCode}
            onQuotedCodeConsumed={() => setChatQuotedCode(null)}
          />
        )}
      </div>

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
  return props.embedded ? (
    <ReviewPageContent {...props} />
  ) : (
    <ReviewBreadcrumbProvider>
      <ReviewPageContent {...props} />
    </ReviewBreadcrumbProvider>
  );
}
