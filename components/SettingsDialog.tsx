import { useState, useEffect, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { CODE_THEMES, CODE_FONTS } from '@/lib/constants';
import type { CodeTheme, CodeFont } from '@/lib/constants';
import { applyTheme, type ThemeChoice } from '@/lib/theme';
import type { ModelId, Preferences, Provider, RepoSearchResult } from '@/lib/types';

// Renderer-safe catalog of providers and their selectable models. Kept here
// rather than imported from lib/providers/* because those modules pull in
// Node APIs (child_process, fs) that can't run in the renderer.
const PROVIDER_MODELS: Record<Provider, { label: string; models: { id: ModelId; label: string }[] }> = {
  claude: {
    label: 'Claude',
    models: [
      { id: 'claude-opus-4-7', label: 'Opus 4.7' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    ],
  },
  gemini: {
    label: 'Gemini',
    models: [
      { id: 'gemini-3.1-pro-preview', label: '3.1 Pro' },
      { id: 'gemini-3-pro-preview', label: '3 Pro' },
      { id: 'gemini-3-flash-preview', label: '3 Flash' },
      { id: 'gemini-2.5-pro', label: '2.5 Pro' },
      { id: 'gemini-2.5-flash', label: '2.5 Flash' },
    ],
  },
};

function modelLabel(provider: Provider, id: ModelId): string {
  return PROVIDER_MODELS[provider].models.find((m) => m.id === id)?.label ?? id;
}

const SECTIONS = [
  { id: 'appearance', num: '01', label: 'Appearance' },
  { id: 'review', num: '02', label: 'Review' },
  { id: 'proactive', num: '03', label: 'Proactive' },
  { id: 'system', num: '04', label: 'System' },
  { id: 'advanced', num: '05', label: 'Advanced' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onThemeChange?: (theme: string) => void;
  // Resets the first-run welcome, the keyboard hint, and any
  // localStorage onboarding flags so the user can re-experience the
  // first-time path. Owned by HomePage because HomePage holds the
  // firstRunOpen / hasEverHadPendingReviews / keyboardHintDismissed
  // state slots that need to be reset together.
  onReplayOnboarding?: () => void;
}

export function applyCodeFont(fontId: string) {
  const font = CODE_FONTS.find((f) => f.id === fontId);
  if (font) {
    document.documentElement.style.setProperty('--font-mono', `${font.family}, ui-monospace, monospace`);
  }
}

// Quiet toggle switch — ink-on-paper active state, flat thumb. Keeps
// brand claret reserved as punctuation (focus, active TOC marker, the
// override rail) rather than coating every "on" control.
function Toggle({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: () => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={onChange}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]/50 focus-visible:ring-offset-2 focus-visible:ring-offset-card ${
        checked ? 'bg-foreground border-foreground' : 'bg-transparent border-border'
      }`}
    >
      <span
        className={`pointer-events-none block h-3.5 w-3.5 rounded-full transition-transform translate-y-px ${
          checked ? 'bg-background translate-x-[1.125rem]' : 'bg-muted-foreground translate-x-[2px]'
        }`}
      />
    </button>
  );
}

// Quiet text-only chip. Active option gets a hairline brand-claret
// underline. Used inside radiogroups — the group provides the label,
// arrow-key traversal, and roving tabindex; each chip just reports
// aria-checked so screen readers announce the current selection.
function Chip({
  active,
  onClick,
  children,
  style,
  ariaLabel,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  style?: React.CSSProperties;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={ariaLabel}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      style={style}
      className={`text-sm pb-0.5 border-b transition-colors focus-visible:outline-none focus-visible:text-foreground ${
        active
          ? 'text-foreground border-[var(--ring)]'
          : 'border-transparent text-muted-foreground hover:text-foreground focus-visible:border-[var(--ring)]/50'
      }`}
    >
      {children}
    </button>
  );
}

// Radiogroup with W3C keyboard nav: ←/→/↑/↓ moves focus AND activates
// the next/prev chip (wrapping at ends); Home/End jump to first/last.
// Matches the roving-tabindex pattern — only the selected chip is in
// the tab order, and arrow keys move BOTH focus and selection, which
// is what screen readers announce as "radio group, Paper, 1 of 3."
function ChipGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const groupRef = useRef<HTMLDivElement | null>(null);

  function move(delta: number | 'home' | 'end') {
    const root = groupRef.current;
    if (!root) return;
    const chips = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    if (chips.length === 0) return;
    const active = document.activeElement;
    const currentIdx = chips.findIndex((c) => c === active);
    const anchor = currentIdx === -1 ? chips.findIndex((c) => c.getAttribute('aria-checked') === 'true') : currentIdx;
    const from = anchor === -1 ? 0 : anchor;
    let next: number;
    if (delta === 'home') next = 0;
    else if (delta === 'end') next = chips.length - 1;
    else next = (from + delta + chips.length) % chips.length;
    const target = chips[next];
    target.focus();
    target.click();
  }

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={label}
      className="flex flex-wrap gap-x-4 gap-y-2"
      onKeyDown={(e) => {
        switch (e.key) {
          case 'ArrowLeft':
          case 'ArrowUp':
            e.preventDefault();
            move(-1);
            break;
          case 'ArrowRight':
          case 'ArrowDown':
            e.preventDefault();
            move(1);
            break;
          case 'Home':
            e.preventDefault();
            move('home');
            break;
          case 'End':
            e.preventDefault();
            move('end');
            break;
        }
      }}
    >
      {children}
    </div>
  );
}

// Single setting row — label + description on the left, control on the right.
function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-1">
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {description && <span className="slide-meta">{description}</span>}
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

// Editorial section header: "01  Appearance" in the content pane.
function SectionHeader({ num, title, sub }: { num: string; title: string; sub?: string }) {
  return (
    <header className="flex flex-col gap-1">
      <div className="flex items-baseline gap-3">
        <span className="slide-chapter text-muted-foreground">{num}</span>
        <h2 className="editorial-heading text-foreground">{title}</h2>
      </div>
      {sub && <p className="slide-meta">{sub}</p>}
    </header>
  );
}

export function SettingsDialog({ open, onOpenChange, onThemeChange, onReplayOnboarding }: Props) {
  const [appTheme, setAppTheme] = useState<ThemeChoice>('system');
  const [codeTheme, setCodeTheme] = useState<CodeTheme>('aurora-x');
  const [codeFont, setCodeFont] = useState<CodeFont>('jetbrains-mono');
  const [enableTools, setEnableTools] = useState(false);
  const [proactiveMode, setProactiveMode] = useState(false);
  const [watchedRepos, setWatchedRepos] = useState<string[]>([]);
  const [watchedRepoInput, setWatchedRepoInput] = useState('');
  const [repoSuggestions, setRepoSuggestions] = useState<RepoSearchResult[]>([]);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const showSuggestions = repoSuggestions.length > 0 && !suggestionsDismissed;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [notifications, setNotifications] = useState(true);
  const [trayEnabled, setTrayEnabled] = useState(true);
  const [maxPrsPerRepo, setMaxPrsPerRepo] = useState(10);
  const [parallelReview, setParallelReview] = useState(false);
  const [analytics, setAnalytics] = useState(true);
  const [analyticsExpanded, setAnalyticsExpanded] = useState(false);
  const [manualProvider, setManualProvider] = useState<Provider>('claude');
  const [manualModel, setManualModel] = useState<ModelId>('claude-opus-4-7');
  const [proactiveReviewOverrides, setProactiveReviewOverrides] = useState(false);
  const [proactiveProvider, setProactiveProvider] = useState<Provider>('claude');
  const [proactiveModel, setProactiveModel] = useState<ModelId>('claude-sonnet-4-6');
  const [proactiveThinking, setProactiveThinking] = useState(false);
  const [claudePath, setClaudePath] = useState('');
  const [geminiPath, setGeminiPath] = useState('');
  const [claudeDetected, setClaudeDetected] = useState('');
  const [geminiDetected, setGeminiDetected] = useState('');

  const [activeSection, setActiveSection] = useState<SectionId>(() => {
    // Remember which section the user last visited. Power users
    // returning to tweak the same setting shouldn't have to scroll.
    try {
      const stored = localStorage.getItem('gnosis-settings-last-section');
      if (stored && SECTIONS.some((s) => s.id === stored)) return stored as SectionId;
    } catch { /* localStorage unavailable — fine, default */ }
    return 'appearance';
  });
  const [saveStatus, setSaveStatus] = useState<{ tick: number; state: 'saved' | 'error' }>({ tick: 0, state: 'saved' });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Record<SectionId, HTMLElement | null>>({
    appearance: null,
    review: null,
    proactive: null,
    system: null,
    advanced: null,
  });

  // Clean up debounce timer on unmount
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  useEffect(() => {
    if (!open) return;
    void window.electronAPI.loadPreferences().then(applyLoadedPrefs);
    void window.electronAPI.detectBinaryPath('claude').then(setClaudeDetected);
    void window.electronAPI.detectBinaryPath('gemini').then(setGeminiDetected);
  }, [open]);

  // Remember the last-visited section across opens.
  useEffect(() => {
    try { localStorage.setItem('gnosis-settings-last-section', activeSection); } catch { /* non-fatal */ }
  }, [activeSection]);

  // Intersection-based TOC highlight. Picks the section whose top edge is
  // closest to (but not past) the scroll container's top. Only runs while
  // the dialog is open.
  useEffect(() => {
    if (!open) return;
    const root = scrollRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // Pick the topmost entry that's currently intersecting. If multiple
        // sections are visible, the one highest in the viewport wins.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) {
          setActiveSection(visible[0].target.getAttribute('data-section') as SectionId);
        }
      },
      { root, rootMargin: '0px 0px -65% 0px', threshold: 0 }
    );
    SECTIONS.forEach((s) => {
      const el = sectionRefs.current[s.id];
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [open]);

  function handleSelectAppTheme(theme: ThemeChoice) {
    setAppTheme(theme);
    saveField({ theme });
    applyTheme(theme);
  }

  function saveField(overrides: Partial<Preferences>) {
    void window.electronAPI
      .loadPreferences()
      .then((prefs) => window.electronAPI.savePreferences({ ...prefs, ...overrides }))
      .then(() => {
        setSaveStatus((s) => ({ tick: s.tick + 1, state: 'saved' }));
      })
      .catch(() => {
        setSaveStatus((s) => ({ tick: s.tick + 1, state: 'error' }));
        // Reconcile optimistic UI with actually-persisted prefs so the
        // user doesn't see a setting "stick" that never saved.
        void window.electronAPI.loadPreferences().then(applyLoadedPrefs);
      });
  }

  function applyLoadedPrefs(prefs: Preferences) {
    setAppTheme(prefs.theme);
    if (prefs.codeTheme) setCodeTheme(prefs.codeTheme as CodeTheme);
    if (prefs.codeFont) setCodeFont(prefs.codeFont as CodeFont);
    setEnableTools(prefs.enableTools);
    setProactiveMode(prefs.proactiveMode);
    setWatchedRepos(prefs.watchedRepos);
    setNotifications(prefs.notifications);
    setTrayEnabled(prefs.trayEnabled);
    setMaxPrsPerRepo(prefs.maxPrsPerRepo);
    setParallelReview(prefs.parallelReview);
    setAnalytics(prefs.analytics);
    setManualProvider(prefs.provider);
    setManualModel(prefs.model);
    setProactiveReviewOverrides(prefs.proactiveReviewOverrides);
    setProactiveProvider(prefs.proactiveProvider);
    setProactiveModel(prefs.proactiveModel);
    setProactiveThinking(prefs.proactiveThinking);
    setClaudePath(prefs.claudePath || '');
    setGeminiPath(prefs.geminiPath || '');
  }

  function addWatchedRepo(name: string) {
    if (!name || watchedRepos.includes(name)) return;
    const next = [...watchedRepos, name];
    setWatchedRepos(next);
    setWatchedRepoInput('');
    setRepoSuggestions([]);
    saveField({ watchedRepos: next });
  }

  function handleSelectTheme(theme: CodeTheme) {
    setCodeTheme(theme);
    saveField({ codeTheme: theme });
    onThemeChange?.(theme);
  }

  function handleSelectFont(font: CodeFont) {
    setCodeFont(font);
    saveField({ codeFont: font });
    applyCodeFont(font);
  }

  function scrollTo(id: SectionId, behavior: ScrollBehavior = 'smooth') {
    const el = sectionRefs.current[id];
    const root = scrollRef.current;
    if (!el || !root) return;
    // rect math is robust to positioned-ancestor quirks that offsetTop
    // doesn't handle.
    const top = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
    root.scrollTo({ top: top - 4, behavior });
  }

  // Restore scroll to the remembered section when the dialog opens.
  useEffect(() => {
    if (!open) return;
    // Defer one tick so the section refs are mounted.
    const t = setTimeout(() => scrollTo(activeSection, 'auto'), 0);
    return () => clearTimeout(t);
    // Intentionally only re-runs on `open`. Reading `activeSection`
    // here captures the value at open-time, which is what we want —
    // we don't want to re-scroll every time the user navigates.
  }, [open]);

  // Keyboard shortcuts: digits 1-5 jump to the matching section when
  // focus isn't inside a text input. Typed digits inside the repo
  // search or CLI path inputs still work normally.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      const n = Number(e.key);
      if (!Number.isNaN(n) && n >= 1 && n <= SECTIONS.length) {
        e.preventDefault();
        const id = SECTIONS[n - 1].id;
        setActiveSection(id);
        scrollTo(id);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* `zoom-in-100` + `zoom-out-100` cancel the default pop-zoom
          entrance from the shadcn dialog primitive so the dialog just
          fades in. Editorial motion — page-turn register, not SaaS. */}
      <DialogContent className="bg-card p-0 sm:max-w-3xl overflow-hidden data-[state=open]:zoom-in-100 data-[state=closed]:zoom-out-100">
        <div className="grid grid-cols-[168px_1fr] max-h-[min(85vh,720px)]">
          {/* Left rail — editorial TOC */}
          <nav
            aria-label="Settings sections"
            className="flex flex-col gap-5 pl-6 pr-3 py-8 border-r border-border/60"
          >
            <DialogHeader className="mb-2 space-y-0.5">
              <DialogTitle
                asChild
                className="slide-title !text-[1.65rem] !leading-none text-foreground"
              >
                <h1>Settings</h1>
              </DialogTitle>
              <DialogDescription className="sr-only">
                Appearance, review behaviour, proactive mode, system, and advanced options. Press 1 through 5 to jump sections.
              </DialogDescription>
            </DialogHeader>
            <ul className="flex flex-col gap-2">
              {SECTIONS.map((s, i) => {
                const active = activeSection === s.id;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => { setActiveSection(s.id); scrollTo(s.id); }}
                      aria-current={active ? 'location' : undefined}
                      title={`Jump to ${s.label} (${i + 1})`}
                      className={`w-full text-left flex items-baseline gap-2 text-sm transition-colors ${
                        active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <span
                        className={`font-mono text-[0.7rem] tracking-wider ${
                          active ? 'text-[var(--ring)]' : ''
                        }`}
                      >
                        {s.num}
                      </span>
                      <span
                        className={`pb-0.5 border-b transition-colors ${
                          active ? 'border-[var(--ring)]' : 'border-transparent'
                        }`}
                      >
                        {s.label}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="slide-meta mt-auto pr-1 leading-relaxed">
              Press <kbd className="kbd">1</kbd>–<kbd className="kbd">5</kbd> to jump.
            </p>
          </nav>

          {/* Right pane — scrollable content */}
          <div className="relative">
            <div
              ref={scrollRef}
              className="overflow-y-auto max-h-[min(85vh,720px)] px-7 py-8"
            >
              <div className="flex flex-col gap-10">
                {/* ── 01 Appearance ── */}
                <section
                  ref={(el) => { sectionRefs.current.appearance = el; }}
                  data-section="appearance"
                  className="flex flex-col gap-5 scroll-mt-2"
                >
                  <SectionHeader num="01" title="Appearance" sub="How the interface looks while you read." />

                  <div className="flex flex-col gap-3">
                    <span className="text-sm font-medium text-foreground">Palette</span>
                    <ChipGroup label="Palette">
                      {(['light', 'dark', 'system'] as const).map((t) => (
                        <Chip
                          key={t}
                          active={appTheme === t}
                          onClick={() => handleSelectAppTheme(t)}
                          ariaLabel={t === 'light' ? 'Paper (light)' : t === 'dark' ? 'Study (dark)' : 'Match system'}
                        >
                          {t === 'light' ? 'Paper' : t === 'dark' ? 'Study' : 'Match system'}
                        </Chip>
                      ))}
                    </ChipGroup>
                  </div>

                  <div className="flex flex-col gap-3">
                    <span className="text-sm font-medium text-foreground">Code font</span>
                    <ChipGroup label="Code font">
                      {CODE_FONTS.map((f) => (
                        <Chip
                          key={f.id}
                          active={codeFont === f.id}
                          onClick={() => handleSelectFont(f.id)}
                          style={{ fontFamily: `${f.family}, monospace` }}
                          ariaLabel={f.label}
                        >
                          {f.label}
                        </Chip>
                      ))}
                    </ChipGroup>
                  </div>

                  <div className="flex flex-col gap-3">
                    <span className="text-sm font-medium text-foreground">Code theme</span>
                    <ChipGroup label="Code theme">
                      {CODE_THEMES.map((t) => (
                        <Chip
                          key={t.id}
                          active={codeTheme === t.id}
                          onClick={() => handleSelectTheme(t.id)}
                          ariaLabel={t.label}
                        >
                          {t.label}
                        </Chip>
                      ))}
                    </ChipGroup>
                  </div>
                </section>

                {/* ── 02 Review ── */}
                <section
                  ref={(el) => { sectionRefs.current.review = el; }}
                  data-section="review"
                  className="flex flex-col gap-5 scroll-mt-2"
                >
                  <SectionHeader num="02" title="Review" sub="How reviews are generated." />

                  <SettingRow
                    label="Web search and context"
                    description="Let the model search the web and fetch GitHub context. More thorough, slower."
                  >
                    <Toggle
                      checked={enableTools}
                      ariaLabel="Enable AI tools"
                      onChange={() => {
                        const next = !enableTools;
                        setEnableTools(next);
                        saveField({ enableTools: next });
                      }}
                    />
                  </SettingRow>

                  <SettingRow
                    label="Parallel review"
                    description="Split generation into a planner step, then parallel writers per topic. Faster on large PRs."
                  >
                    <Toggle
                      checked={parallelReview}
                      ariaLabel="Parallel review"
                      onChange={() => {
                        const next = !parallelReview;
                        setParallelReview(next);
                        saveField({ parallelReview: next });
                      }}
                    />
                  </SettingRow>
                </section>

                {/* ── 03 Proactive ── */}
                <section
                  ref={(el) => { sectionRefs.current.proactive = el; }}
                  data-section="proactive"
                  className="flex flex-col gap-5 scroll-mt-2"
                >
                  <SectionHeader
                    num="03"
                    title="Proactive"
                    sub="The reviews Gnosis prepares for you in the background."
                  />

                  <SettingRow
                    label="Proactive mode"
                    description="Review your PRs, assigned reviews, and watched repos automatically. Checks every 5 minutes; re-generates when a PR updates."
                  >
                    <Toggle
                      checked={proactiveMode}
                      ariaLabel="Proactive mode"
                      onChange={() => {
                        const next = !proactiveMode;
                        setProactiveMode(next);
                        saveField({ proactiveMode: next });
                      }}
                    />
                  </SettingRow>

                  {proactiveMode && (
                    <div className="flex flex-col gap-5 pl-4 border-l border-border/70">
                      <div className="flex flex-col gap-2">
                        <span className="text-sm font-medium text-foreground">Watched repos</span>
                        <span className="slide-meta">All open PRs in these repos are reviewed automatically.</span>
                        <WatchedRepoInput
                          value={watchedRepoInput}
                          setValue={setWatchedRepoInput}
                          suggestions={showSuggestions ? repoSuggestions : []}
                          setSuggestions={setRepoSuggestions}
                          setSuggestionsDismissed={setSuggestionsDismissed}
                          debounceRef={debounceRef}
                          watchedRepos={watchedRepos}
                          addWatchedRepo={addWatchedRepo}
                        />
                        {watchedRepos.length > 0 && (
                          <ul className="flex flex-col gap-1 mt-2">
                            {watchedRepos.map((repo) => (
                              <li key={repo} className="flex items-center justify-between gap-2 text-sm text-foreground">
                                <span className="font-mono text-xs">{repo}</span>
                                <button
                                  type="button"
                                  onClick={() => {
                                    const next = watchedRepos.filter((r) => r !== repo);
                                    setWatchedRepos(next);
                                    saveField({ watchedRepos: next });
                                  }}
                                  className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                                  aria-label={`Stop watching ${repo}`}
                                >
                                  Remove
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      <div className="flex flex-col gap-3">
                        <span className="text-sm font-medium text-foreground">Max PRs per repo</span>
                        <span className="slide-meta">How many recent open PRs to review in each watched repo.</span>
                        <ChipGroup label="Max PRs per repo">
                          {[5, 10, 15, 20, 30, 50].map((n) => (
                            <Chip
                              key={n}
                              active={maxPrsPerRepo === n}
                              onClick={() => {
                                setMaxPrsPerRepo(n);
                                saveField({ maxPrsPerRepo: n });
                              }}
                              ariaLabel={`${n} PRs`}
                            >
                              {n}
                            </Chip>
                          ))}
                        </ChipGroup>
                      </div>

                      <SettingRow
                        label="Use different model for background reviews"
                        description={
                          <>
                            Run proactive reviews on a faster or cheaper model while keeping your manual default.{' '}
                            <span className="font-mono">
                              Manual: {PROVIDER_MODELS[manualProvider].label} · {modelLabel(manualProvider, manualModel)}
                            </span>
                          </>
                        }
                      >
                        <Toggle
                          checked={proactiveReviewOverrides}
                          ariaLabel="Use different model for background reviews"
                          onChange={() => {
                            const next = !proactiveReviewOverrides;
                            setProactiveReviewOverrides(next);
                            saveField({ proactiveReviewOverrides: next });
                          }}
                        />
                      </SettingRow>

                      {proactiveReviewOverrides && (
                        <div className="flex flex-col gap-4 pl-4 border-l border-[var(--ring)]/40">
                          <p className="slide-meta">For background runs only — manual reviews keep your main settings.</p>
                          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                            <span className="text-sm text-muted-foreground">Provider</span>
                            <ChipGroup label="Background provider">
                              {(['claude', 'gemini'] as const).map((p) => (
                                <Chip
                                  key={p}
                                  active={proactiveProvider === p}
                                  onClick={() => {
                                    const firstModel = PROVIDER_MODELS[p].models[0].id;
                                    setProactiveProvider(p);
                                    setProactiveModel(firstModel);
                                    saveField({ proactiveProvider: p, proactiveModel: firstModel });
                                  }}
                                  ariaLabel={`Background provider ${PROVIDER_MODELS[p].label}`}
                                >
                                  {PROVIDER_MODELS[p].label}
                                </Chip>
                              ))}
                            </ChipGroup>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                            <span className="text-sm text-muted-foreground">Model</span>
                            <ChipGroup label="Background model">
                              {PROVIDER_MODELS[proactiveProvider].models.map((m) => (
                                <Chip
                                  key={m.id}
                                  active={proactiveModel === m.id}
                                  onClick={() => {
                                    setProactiveModel(m.id);
                                    saveField({ proactiveModel: m.id });
                                  }}
                                  ariaLabel={`Background model ${m.label}`}
                                >
                                  {m.label}
                                </Chip>
                              ))}
                            </ChipGroup>
                          </div>
                          <SettingRow
                            label="Extended thinking"
                            description="Off is usually faster and cheaper for background runs."
                          >
                            <Toggle
                              checked={proactiveThinking}
                              ariaLabel="Background extended thinking"
                              onChange={() => {
                                const next = !proactiveThinking;
                                setProactiveThinking(next);
                                saveField({ proactiveThinking: next });
                              }}
                            />
                          </SettingRow>
                        </div>
                      )}
                    </div>
                  )}
                </section>

                {/* ── 04 System ── */}
                <section
                  ref={(el) => { sectionRefs.current.system = el; }}
                  data-section="system"
                  className="flex flex-col gap-5 scroll-mt-2"
                >
                  <SectionHeader num="04" title="System" sub="How Gnosis shows up on your machine." />

                  <SettingRow label="Desktop notifications" description="Notify when a review completes.">
                    <Toggle
                      checked={notifications}
                      ariaLabel="Desktop notifications"
                      onChange={() => {
                        const next = !notifications;
                        setNotifications(next);
                        saveField({ notifications: next });
                      }}
                    />
                  </SettingRow>

                  <SettingRow label="Menu bar icon" description="Review status and quick actions in the menu bar.">
                    <Toggle
                      checked={trayEnabled}
                      ariaLabel="Menu bar icon"
                      onChange={() => {
                        const next = !trayEnabled;
                        setTrayEnabled(next);
                        saveField({ trayEnabled: next });
                      }}
                    />
                  </SettingRow>

                  <SettingRow
                    label="Anonymous usage analytics"
                    description={
                      <>
                        Anonymous event counts help us decide what to build next.{' '}
                        <button
                          type="button"
                          onClick={() => setAnalyticsExpanded((v) => !v)}
                          className="underline decoration-dotted decoration-muted-foreground/60 underline-offset-2 hover:text-foreground transition-colors"
                        >
                          {analyticsExpanded ? 'Hide details' : 'What we send'}
                        </button>
                        {analyticsExpanded && (
                          <span className="block mt-1 text-muted-foreground/90">
                            Events like launches and feature usage go to{' '}
                            <a
                              href="https://aptabase.com"
                              onClick={(e) => {
                                e.preventDefault();
                                void window.electronAPI.openExternal('https://aptabase.com');
                              }}
                              className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                            >
                              Aptabase
                            </a>
                            , an open-source privacy-first service. No personal data, no IP, no PRs, no source code.
                          </span>
                        )}
                      </>
                    }
                  >
                    <Toggle
                      checked={analytics}
                      ariaLabel="Anonymous usage analytics"
                      onChange={() => {
                        const next = !analytics;
                        setAnalytics(next);
                        saveField({ analytics: next });
                      }}
                    />
                  </SettingRow>
                </section>

                {/* ── 05 Advanced ── */}
                <section
                  ref={(el) => { sectionRefs.current.advanced = el; }}
                  data-section="advanced"
                  className="flex flex-col gap-5 scroll-mt-2 pb-4"
                >
                  <SectionHeader num="05" title="Advanced" sub="You probably don't need to touch these." />

                  <div className="flex flex-col gap-4 pl-4 border-l border-border/60">
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="claude-cli-path" className="text-sm font-medium text-foreground">Claude CLI path</label>
                      <input
                        id="claude-cli-path"
                        type="text"
                        value={claudePath}
                        placeholder={claudeDetected || 'auto-detect'}
                        onChange={(e) => setClaudePath(e.target.value)}
                        onBlur={() => saveField({ claudePath })}
                        className="bg-transparent border-0 border-b border-border px-0 py-1 text-sm text-foreground placeholder:text-muted-foreground/60 transition-colors focus:outline-none focus:border-[var(--ring)]"
                      />
                      <p className="slide-meta">Leave empty to auto-detect.</p>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="gemini-cli-path" className="text-sm font-medium text-foreground">Gemini CLI path</label>
                      <input
                        id="gemini-cli-path"
                        type="text"
                        value={geminiPath}
                        placeholder={geminiDetected || 'auto-detect'}
                        onChange={(e) => setGeminiPath(e.target.value)}
                        onBlur={() => saveField({ geminiPath })}
                        className="bg-transparent border-0 border-b border-border px-0 py-1 text-sm text-foreground placeholder:text-muted-foreground/60 transition-colors focus:outline-none focus:border-[var(--ring)]"
                      />
                      <p className="slide-meta">Leave empty to auto-detect.</p>
                    </div>

                    <div className="flex flex-col gap-2 pt-2 items-start">
                      {onReplayOnboarding && (
                        <button
                          type="button"
                          onClick={() => {
                            onReplayOnboarding();
                            onOpenChange(false);
                          }}
                          className="slide-meta hover:text-foreground transition-colors"
                        >
                          Replay first-time welcome →
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void window.electronAPI.openLogsDirectory()}
                        className="slide-meta hover:text-foreground transition-colors"
                      >
                        Open logs directory →
                      </button>
                    </div>
                  </div>
                </section>
              </div>
            </div>

            {/* Unobtrusive save acknowledgement — fades in for ~1s after each write.
               Re-keyed on tick so rapid saves reset the animation. Reports
               failures in the same slot so the user isn't left guessing. */}
            <SaveIndicator status={saveStatus} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Small save acknowledgement bottom-right of the content pane. Fades in
// for ~1.1s after each save, then fades out. Uses a keyed remount so
// rapid consecutive saves reliably restart the animation. Error state
// uses --destructive so failures read as failures, not brand accent.
function SaveIndicator({ status }: { status: { tick: number; state: 'saved' | 'error' } }) {
  if (status.tick === 0) return null;
  return (
    <span
      key={status.tick}
      role="status"
      aria-live="polite"
      className={`pointer-events-none absolute bottom-3 right-5 slide-meta opacity-0 saved-flash ${
        status.state === 'saved' ? 'text-muted-foreground' : 'text-destructive'
      }`}
    >
      {status.state === 'saved' ? 'Saved.' : "Couldn't save."}
    </span>
  );
}

// Repo search with a proper combobox/listbox a11y contract. Typing
// debounces to the backend; ArrowDown from the input moves focus into
// the suggestion list; ArrowUp/Down cycle within the list; Enter
// activates; Escape dismisses. Keyboard-only users can reach a
// suggestion without ever touching the mouse.
function WatchedRepoInput({
  value,
  setValue,
  suggestions,
  setSuggestions,
  setSuggestionsDismissed,
  debounceRef,
  watchedRepos,
  addWatchedRepo,
}: {
  value: string;
  setValue: (v: string) => void;
  suggestions: RepoSearchResult[];
  setSuggestions: (s: RepoSearchResult[]) => void;
  setSuggestionsDismissed: (b: boolean) => void;
  debounceRef: React.RefObject<ReturnType<typeof setTimeout> | null>;
  watchedRepos: string[];
  addWatchedRepo: (name: string) => void;
}) {
  const listRef = useRef<HTMLUListElement | null>(null);
  const trimmed = value.trim();
  const hasSlash = trimmed.includes('/');
  const hasError = trimmed.length > 0 && !hasSlash && suggestions.length === 0;

  function focusOption(index: number) {
    const list = listRef.current;
    if (!list) return;
    const options = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    if (options.length === 0) return;
    const clamped = (index + options.length) % options.length;
    options[clamped]?.focus();
  }

  return (
    <>
      <div className="relative mt-1">
        <input
          type="text"
          value={value}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={suggestions.length > 0}
          aria-controls="watched-repo-suggestions"
          placeholder="owner/repo — or search by name"
          onChange={(e) => {
            const val = e.target.value;
            setValue(val);
            setSuggestionsDismissed(false);
            if (debounceRef.current) clearTimeout(debounceRef.current);
            if (val.trim().length >= 2) {
              debounceRef.current = setTimeout(() => {
                void window.electronAPI.searchRepos(val.trim()).then((results) => {
                  setSuggestions(results.filter((r) => !watchedRepos.includes(r.fullName)));
                });
              }, 300);
            } else {
              setSuggestions([]);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (hasSlash) addWatchedRepo(trimmed);
            } else if (e.key === 'ArrowDown' && suggestions.length > 0) {
              e.preventDefault();
              focusOption(0);
            } else if (e.key === 'Escape') {
              setSuggestionsDismissed(true);
            }
          }}
          onFocus={() => setSuggestionsDismissed(false)}
          onBlur={(e) => {
            // Don't dismiss when focus moves into the suggestion list.
            const next = e.relatedTarget as HTMLElement | null;
            if (next && listRef.current?.contains(next)) return;
            setSuggestionsDismissed(true);
          }}
          className="w-full bg-transparent border-0 border-b border-border px-0 py-1 text-sm text-foreground placeholder:text-muted-foreground/60 transition-colors focus:outline-none focus:border-[var(--ring)]"
        />
        {suggestions.length > 0 && (
          <ul
            ref={listRef}
            id="watched-repo-suggestions"
            role="listbox"
            className="absolute z-50 top-full left-0 right-0 mt-1 bg-popover border border-border rounded-md shadow-md max-h-48 overflow-y-auto"
          >
            {suggestions.map((repo, i) => (
              <li key={repo.fullName}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  tabIndex={-1}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-accent focus:bg-accent focus:outline-none transition-colors flex flex-col gap-0.5"
                  onMouseDown={(e) => { e.preventDefault(); addWatchedRepo(repo.fullName); }}
                  onClick={() => addWatchedRepo(repo.fullName)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown') { e.preventDefault(); focusOption(i + 1); }
                    else if (e.key === 'ArrowUp') { e.preventDefault(); focusOption(i - 1); }
                    else if (e.key === 'Escape') { setSuggestionsDismissed(true); }
                  }}
                >
                  <span className="font-mono text-xs text-foreground">{repo.fullName}</span>
                  {repo.description && (
                    <span className="text-xs text-muted-foreground truncate">{repo.description}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <span className={`slide-meta ${hasError ? 'text-destructive' : ''}`}>
        {hasError
          ? 'Needs `owner/repo` format, or pick from suggestions.'
          : 'Tip: ↓ into suggestions · Enter to add · `owner/repo` format.'}
      </span>
    </>
  );
}
