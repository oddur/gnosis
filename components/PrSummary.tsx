import { hasVisibleNavigationOverlay } from '../lib/workspace-navigation';
import { feedbackCodeContext, type FeedbackRequest, type ResponseIntent } from '../lib/feedback';
import { PrFeedbackView } from './PrFeedbackView';
import { WorkspaceIcon, workspaceTabs } from './WorkspaceIcon';
import { SubjectIcon } from './SubjectIcon';
import { stackMergePlan } from '../lib/stack-merge-plan';
import { ReviewEvidence } from './ReviewEvidence';
import { StackChecksFreshness } from './StackMergePlan';
import { StackChangesView } from './StackChangesView';
import { StackBriefing } from './StackBriefing';
import { StackContext } from './StackContext';
import { StackOverview } from './StackOverview';
import { SearchableSelect } from './SearchableSelect';
import { stackScopeChoices } from '../lib/stack-workspace';
import { Button } from './ui/button';
import { PrChecksView, type CheckFocus } from './PrChecksView';
import { usePrChecks } from '../lib/use-pr-checks';
import { checkCounts, type PrChecks } from '../lib/pr-checks';
import { RepositoryBadge, PrBadge } from './EntityBadge';
import { usePrReadVisit } from '../lib/pr-read-context';
import { PrActions } from './PrActions';
import { ReviewBreadcrumbProvider, useReviewBreadcrumbs } from '../lib/review-breadcrumbs';
import { ReviewBreadcrumbs } from './ReviewBreadcrumbs';
import { Activity, type ComponentProps, type ReactNode, type Ref, type UIEvent } from 'react';
import { PrEntryActions, PrStarMarker, type PrGenerationActionsFor } from './PrEntryActions';
import { PrExplanation } from './PrExplanation';
import type { ExplanationDestination } from '../lib/explanation-workspace';
import type { ReviewHistoryEntry } from '../lib/types';
import { Tabs } from 'radix-ui';
import { PrCommitsView } from './PrCommitsView';
import { PrChangesView, type ChangesInitialFile } from './PrChangesView';
import { AgentBriefView } from './AgentBriefView';
import { useAgentBrief, type AgentBriefComment } from '../lib/agent-brief';
import type { WorkspaceTab } from '../lib/navigation-history';
import type { Preferences } from '../lib/types';
import { GitHubAuthor } from './GitHubAuthor';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, Layers, Pencil, RefreshCw } from 'lucide-react';
import { Markdown } from './Markdown';
import { PrSubjectDetails } from './PrSubjectDetails';
import { type QueueItem, type ReviewSubject } from '../lib/workbench';
import type { QueueSignals } from '../lib/queue-signals';
import { statusClock, useStatusNow } from '../lib/status-clock';
import { countRender } from '../lib/render-count';
import type { PrStatus } from '../lib/types';
import { timeAgo } from '../lib/utils';
import { useQueueSignals } from '../lib/use-queue-signals';
import { stackMergeStatus } from '../lib/stack-merge-status';
import { subjectReadiness } from '../lib/merge-readiness';
import { ReadinessBadge, ReadinessCheckedAt } from './MergeReadiness';
import { SubjectReviewStatus } from './PrReviewStatus';
import { useChangesComments } from './useChangesComments';
import { ArrivalProbe, contentMarkers } from '../lib/use-predictions';
import type { ReviewMember } from '../lib/workbench';

/**
 * Restores scroll positions inside a kept tab. Hidden content has no layout, so Chromium can reset
 * its scroll offsets; positions are recorded as the reader scrolls and reapplied on reveal.
 */
/** Elements under `root` that are scrolled, including inside open shadow roots. */
function scrolledWithin(root: Element | ShadowRoot): Element[] {
  const found: Element[] = [];
  for (const element of root.querySelectorAll('*')) {
    if (element.scrollTop > 0 || element.scrollLeft > 0) found.push(element);
    if (element.shadowRoot) found.push(...scrolledWithin(element.shadowRoot));
  }
  if (root instanceof Element && (root.scrollTop > 0 || root.scrollLeft > 0)) found.push(root);
  return found;
}

function ScrollKeeper() {
  const marker = useRef<HTMLSpanElement>(null);
  const positions = useRef(new Map<Element, [number, number]>());
  useLayoutEffect(() => {
    const panel = marker.current?.closest<HTMLElement>('[role="tabpanel"]');
    if (!panel) return;
    const saved = [...positions.current].filter(([element]) => panel.contains(element));
    // Content can lay out again after it is shown, so keep applying the saved offsets for a moment
    // until they hold, unless the reader scrolls first.
    let restoring = saved.length > 0;
    const apply = () => {
      if (!restoring) return;
      let held = true;
      for (const [element, [top, left]] of saved) {
        if (element.scrollTop !== top) element.scrollTop = top;
        if (element.scrollLeft !== left) element.scrollLeft = left;
        held &&= Math.abs(element.scrollTop - top) < 1 && Math.abs(element.scrollLeft - left) < 1;
      }
      return held;
    };
    let frames = 0;
    let frame = 0;
    const settle = () => {
      if (apply() && ++frames >= 2) restoring = false;
      else if (restoring) frame = requestAnimationFrame(settle);
    };
    apply();
    if (restoring) frame = requestAnimationFrame(settle);
    const timer = setTimeout(() => { restoring = false; }, 1000);
    const stop = () => { restoring = false; };
    const record = (event: Event) => {
      const element = event.target;
      if (!restoring && element instanceof Element) positions.current.set(element, [element.scrollTop, element.scrollLeft]);
    };
    panel.addEventListener('scroll', record, { capture: true, passive: true });
    panel.addEventListener('wheel', stop, { capture: true, passive: true });
    panel.addEventListener('pointerdown', stop, { capture: true });
    panel.addEventListener('keydown', stop, { capture: true });
    return () => {
      // Scroll events inside shadow roots do not reach the panel, so also read offsets as the tab hides.
      // React runs this cleanup before Activity applies display:none, while offsets are still readable.
      if (!restoring) for (const element of scrolledWithin(panel)) positions.current.set(element, [element.scrollTop, element.scrollLeft]);
      restoring = false;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      panel.removeEventListener('scroll', record, { capture: true });
      panel.removeEventListener('wheel', stop, { capture: true });
      panel.removeEventListener('pointerdown', stop, { capture: true });
      panel.removeEventListener('keydown', stop, { capture: true });
    };
  }, []);
  return <span ref={marker} hidden />;
}

/**
 * A PR tab that stays mounted after its first visit. While another tab is shown, Activity hides it
 * and pauses its effects, including polling.
 */
function KeptTab({ value, tab, visited, className, children, ref, onScroll, arrival }: {
  value: WorkspaceTab;
  tab: WorkspaceTab;
  visited: ReadonlySet<WorkspaceTab>;
  className: string;
  children: ReactNode;
  ref?: Ref<HTMLDivElement>;
  onScroll?: (event: UIEvent<HTMLDivElement>) => void;
  /** Measures time to content for each visit. The first visit of the PR's first tab is the PR open. */
  arrival?: { subjectId: string; opened: boolean };
}) {
  if (!visited.has(value)) return null;
  const tabKey = arrival && `pr-tab:${value}:${arrival.subjectId}`;
  return (
    <Tabs.Content value={value} className={className} forceMount ref={ref} onScroll={onScroll}>
      <Activity mode={tab === value ? 'visible' : 'hidden'}>
        <ScrollKeeper />
        {children}
        {arrival && tabKey && value in contentMarkers && (
          <ArrivalProbe firstKey={arrival.opened ? `pr-open:${arrival.subjectId}` : tabKey} revisitKey={tabKey} marker={value} />
        )}
      </Activity>
    </Tabs.Content>
  );
}

export interface PrReviewRequest {
  id: string;
  member: ReviewMember;
}

export interface PrReadingPosition {
  memberUrl: string;
  scroll: Record<string, number>;
}

function PrSummaryContent({
  item,
  feedbackRequest,
  starredUrls,
  starBusy,
  starError,
  onStarChange,
  onMute,
  muteBusy,
  account,
  statusRefreshing,
  tab,
  onTabChange,
  preferences,
  starting,
  error,
  statuses,
  statusErrors,
  onBack,
  onQueue,
  onScopeChange,
  onRenameStack,
  matchingUrls,
  onGenerate,
  generationActions,
  onReview,
  reviewRequest,
  onReviewRequestHandled,
  explanationDestination,
  explanations,
  onShowActivity,
  onRetryStatus,
  onAiSetup,
  onGitHubAuth,
  navigation,
  positions,
  shortcutsEnabled = true,
}: {
  item: QueueItem;
  feedbackRequest?: FeedbackRequest;
  starredUrls: ReadonlySet<string>;
  starBusy: boolean;
  muteBusy: boolean;
  onMute: (members: QueueItem['subject']['members']) => void;
  starError: string;
  onStarChange: (members: QueueItem['subject']['members'], starred: boolean) => void;
  account: string | null;
  statusRefreshing: boolean;
  tab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  preferences: Preferences | null;
  starting: boolean;
  error: string;
  statuses: Partial<Record<string, PrStatus>>;
  statusErrors: Record<string, string>;
  onBack: () => void;
  onQueue?: () => void;
  onScopeChange?: (id: string) => void;
  onRenameStack?: (name: string) => Promise<void>;
  matchingUrls?: string[];
  onGenerate: (previousReviewId?: string) => void;
  generationActions?: PrGenerationActionsFor;
  onReview?: (member: ReviewMember) => void;
  reviewRequest?: PrReviewRequest;
  onReviewRequestHandled?: () => void;
  explanationDestination?: ExplanationDestination;
  explanations: ReviewHistoryEntry[];
  onShowActivity: () => void;
  onRetryStatus: () => void;
  onAiSetup?: () => void;
  onGitHubAuth?: () => void;
  navigation: {
    index: number;
    total: number;
    viewName: string;
    previous?: string;
    next?: string;
    move: (direction: number) => void;
    choices: { value: string; label: string }[];
    select: (id: string) => void;
  };
  positions: Map<string, PrReadingPosition>;
  shortcutsEnabled?: boolean;
}) {
  countRender('PrSummaryContent');
  usePrReadVisit(item.subject.members, tab === 'summary' && item.subject.kind === 'pr', 'summary');
  // Tabs stay mounted once visited. The set only grows while this PR is shown.
  const [visited, setVisited] = useState<ReadonlySet<WorkspaceTab>>(() => new Set([tab]));
  if (!visited.has(tab)) setVisited(new Set([...visited, tab]));
  const currentTab = useRef(tab);
  currentTab.current = tab;
  // The tab shown when the PR opened. Its first visit measures the PR open itself.
  const [openedTab] = useState(tab);
  const arrival = (value: WorkspaceTab) => ({ subjectId: item.subject.id, opened: value === openedTab });
  // While this PR is hidden for a minute, behind a saved review or another workspace tab, drop its other tabs.
  const evict = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(evict.current);
    return () => { evict.current = setTimeout(() => setVisited(new Set([currentTab.current])), 60_000); };
  }, []);
  // Programmatic jumps remount Feedback, which reads its initial thread and intent once.
  const [feedbackJump, setFeedbackJump] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(item.subject.name ?? '');
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState('');
  const [feedbackPr, setFeedbackPr] = useState<string>();
  const [feedbackThread, setFeedbackThread] = useState<string>();
  const [feedbackIntent, setFeedbackIntent] = useState<'address' | 'request' | ResponseIntent | undefined>(feedbackRequest?.intent);
  useEffect(() => { if (feedbackRequest) { setFeedbackPr(undefined); setFeedbackThread(undefined); setFeedbackIntent(feedbackRequest.intent); } }, [feedbackRequest?.id]);
  const [initialFile, setInitialFile] = useState<ChangesInitialFile>();
  // A jump happens once. Returning to Changes later restores where the reviewer left off.
  useEffect(() => {
    if (tab !== 'changes') setInitialFile(undefined);
  }, [tab]);
  const brief = useAgentBrief(item.subject.id);
  const openBriefComment = (comment: AgentBriefComment) => {
    setInitialFile({
      url: comment.url,
      path: comment.path,
      line: comment.line,
      headSha: comment.headSha,
      side: comment.side === 'LEFT' ? 'before' : 'after',
      view: comment.view,
    });
    onTabChange('changes');
  };
  const checks = usePrChecks(item.subject, account, tab === 'summary' || tab === 'checks', statuses, tab === 'checks');
  const [checkFocus, setCheckFocus] = useState<CheckFocus>();
  const checkTotals = checkCounts(item.subject.members.flatMap(m => checks.values[m.url]?.checks ?? []));
  const openChecks = (url: string, id?: string) => { setCheckFocus({ url, id, nonce: Date.now() }); onTabChange('checks'); };
  const heading = useRef<HTMLHeadingElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const restoring = useRef(false);
  const [position] = useState(() => {
    const saved = positions.get(item.subject.id) ?? { memberUrl: item.subject.members[0].url, scroll: {} };
    positions.set(item.subject.id, saved);
    return saved;
  });
  const [memberUrl, setMemberUrl] = useState(position.memberUrl);
  const activeUrl = item.subject.members.find((m) => m.url === memberUrl)?.url ?? item.subject.members[0].url;
  const stacked = item.subject.kind === 'stack';
  const parentStack = item.parentStack;
  const scopeStack = stacked ? item.subject : parentStack;
  const first = item.subject.members[0];
  const activeMember = item.subject.members.find(m => m.url === activeUrl) ?? first;
  // Capture the revision the menu targeted, even if discovery advances while opening the dialog.
  const reviewMember = reviewRequest?.member.url === activeUrl ? reviewRequest.member : activeMember;
  const summaryReview = useChangesComments({
    snapshot: { version: 1, url: reviewMember.url, metadata: reviewMember, comparisonBase: reviewMember.baseSha, files: [], fetchedAt: 0 },
    activeKey: `summary:${reviewMember.url}`,
    inline: [],
    replaceThread: () => {},
    refresh: () => { onRetryStatus(); return Promise.resolve(); },
    onOpenChanges: (path) => {
      setInitialFile({ url: reviewMember.url, path });
      onTabChange('changes');
    },
  });
  const handledReviewRequest = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (reviewRequest && item.subject.members.some(m => m.url === reviewRequest.member.url)) {
      setMemberUrl(reviewRequest.member.url);
    }
  }, [reviewRequest?.id]);
  useEffect(() => {
    if (!reviewRequest || handledReviewRequest.current === reviewRequest.id ||
      reviewRequest.member.url !== activeUrl || !summaryReview.ready) return;
    handledReviewRequest.current = reviewRequest.id;
    summaryReview.openReview();
    onReviewRequestHandled?.();
  }, [reviewRequest, activeUrl, summaryReview.ready, summaryReview.openReview, onReviewRequestHandled]);
  const { ref: statusRef, values: signals, loaded: signalsLoaded } = useQueueSignals(
    account,
    item.subject.members.map((m) => ({ url: m.url, headSha: m.headSha }))
  );
  // Status ages on the shared status clock in lib/status-clock.ts. Only the components that show
  // status read it, so a tick re-renders them and not this page, its kept tabs or the explanation.
  // New status, or a failed refresh, is aged at once: every status component reads the new time.
  useEffect(() => statusClock.tick(), [statuses, statusErrors]);
  const commonRepo = stacked && new Set(item.subject.members.map(m => m.repo)).size === 1 ? first.repo : undefined;
  const state = first.merged ? 'Merged' : first.state === 'closed' ? 'Closed' : first.isDraft ? 'Draft' : 'Open';
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    const element = page.current;
    // The kept summary is hidden on other tabs; restore it only when shown.
    if (!element || tab !== 'summary') return;
    position.memberUrl = activeUrl;
    const desired = position.scroll[activeUrl] ?? 0;
    restoring.current = desired > 0;
    const content = element.querySelector('.pr-summary-body');
    const observer = new ResizeObserver(() => restore());
    const stop = () => {
      restoring.current = false;
      observer.disconnect();
    };
    const restore = () => {
      if (!restoring.current) return;
      element.scrollTop = desired;
      if (Math.abs(element.scrollTop - desired) < 2) stop();
    };
    element.scrollTop = desired;
    if (content && restoring.current) observer.observe(content);
    const frame = requestAnimationFrame(restore);
    const timer = setTimeout(stop, 5000);
    element.addEventListener('wheel', stop, { passive: true });
    element.addEventListener('pointerdown', stop);
    return () => {
      stop();
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      element.removeEventListener('wheel', stop);
      element.removeEventListener('pointerdown', stop);
    };
  }, [activeUrl, position, tab]);
  const remember = () => {
    // A hidden summary has no layout, so its scroll offset would read as zero.
    if (tab === 'summary' && page.current && !restoring.current) position.scroll[activeUrl] = page.current.scrollTop;
  };
  const move = (direction: number) => {
    remember();
    navigation.move(direction);
  };
  const back = () => {
    remember();
    onBack();
  };
  useEffect(() => {
    if (!shortcutsEnabled) return;
    const keydown = (event: KeyboardEvent) => {
      if (tab === 'explanation' && event.key !== 'Escape') return;
      if (event.composedPath().some((node) => node instanceof Element && node.matches('.pr-changes, .pr-checks-workspace'))) return;
      if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (
        target?.isContentEditable ||
        target?.closest(
          'input, textarea, select, summary, [role="combobox"], [role="dialog"], [role="menu"], .review-breadcrumbs, .activity-drawer, .activity-capsule, .workbench-help'
        )
      )
        return;
      if (hasVisibleNavigationOverlay()) return;
      if (event.key === 'j' && navigation.next) {
        event.preventDefault();
        move(1);
      }
      if (event.key === 'k' && navigation.previous) {
        event.preventDefault();
        move(-1);
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        back();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [navigation, onBack, shortcutsEnabled, activeUrl, position, tab]);
  useReviewBreadcrumbs('summary', []);
  const changeScope = (id: string) => { remember(); onScopeChange?.(id); };
  const evidence = (
    <ReviewEvidence onFeedback={url => { setFeedbackPr(url); setFeedbackJump(n => n + 1); onTabChange('feedback'); }}
      compact={!stacked}
      key={`${account}:${item.subject.id}`}
      subject={item.subject}
      account={account}
      signals={[...signals, ...item.subject.members.flatMap(member => statuses[member.url]?.signals ?? [])]}
      checks={checks.values}
      checkErrors={checks.errors}
      onChecks={openChecks}
      onRefresh={onRetryStatus}
      refreshBusy={statusRefreshing}
      refreshError={Object.values(statusErrors)[0]}
    />
  );
  const tabs = workspaceTabs;
  return (
    <Tabs.Root
      value={tab}
      onValueChange={(value) => {
        if (tab === 'summary') remember();
        onTabChange(value as WorkspaceTab);
      }}
      asChild
    >
      <main className={`pr-summary-page ${stacked ? 'is-stack' : ''} ${tab !== 'summary' ? 'showing-changes' : ''} ${tab === 'checks' ? 'showing-checks' : ''}`}>
        <div className="pr-summary-toolbar">
          <div className="pr-summary-toolbar-inner">
            <ReviewBreadcrumbs scope={tab} base={[
              { id: 'origin', label: navigation.viewName, navigate: () => { remember(); (onQueue ?? onBack)(); } },
              ...(parentStack ? [{ id: 'parent-stack', kind: 'stack' as const, label: parentStack.title, title: 'Stack', navigate: () => changeScope(parentStack.id) }] : []),
              { id: 'subject', kind: stacked ? 'stack' : 'pr', label: stacked ? item.subject.title : `${first.repo} #${first.number}`,
                title: item.subject.title, navigate: () => { remember(); onTabChange('summary'); },
                pickerLabel: parentStack ? 'PR in stack' : 'PR or stack', value: item.subject.id, options: parentStack ? stackScopeChoices(parentStack).slice(1) : navigation.choices,
                select: id => { remember(); if (parentStack) changeScope(id); else navigation.select(id); } },
              { id: 'tab', workspaceTab: tab, label: tabs.find(t => t.value === tab)?.label ?? 'Summary',
                pickerLabel: 'Review tab', value: tab, options: tabs,
                select: value => { remember(); onTabChange(value as typeof tab); } },
            ]} />
            <nav className="pr-queue-navigation" aria-label="Changes in current view">
              <button
                aria-label="Previous change"
                disabled={!navigation.previous}
                title={navigation.previous ? `Previous: ${navigation.previous} (k)` : 'First change in this view'}
                onClick={() => move(-1)}
              >
                <ChevronLeft size={16} />
              </button>
              <span title={navigation.viewName}>
                {navigation.index < 0 ? 'Outside current view' : `${navigation.index + 1} / ${navigation.total}`}
              </span>
              <button
                aria-label="Next change"
                disabled={!navigation.next}
                title={navigation.next ? `Next: ${navigation.next} (j)` : 'Last change in this view'}
                onClick={() => move(1)}
              >
                <ChevronRight size={16} />
              </button>
            </nav>
          </div>
        </div>
        <PrEntryActions {...generationActions?.(item.subject.members)} onReview={onReview} reviewDisabled={!account} members={item.subject.members} starredUrls={starredUrls}
          busy={starBusy || muteBusy || statusRefreshing} onStarChange={onStarChange} onMute={onMute}
          onRefresh={onRetryStatus}>{actions => <header className="pr-overview-heading">
          <div className="pr-title-with-star">
            <h1 ref={heading} tabIndex={-1} title={item.subject.title}>
              <SubjectIcon kind={stacked ? 'stack' : 'pr'} />{item.subject.title}
            </h1>
            <PrStarMarker members={item.subject.members} starredUrls={starredUrls} />
            {stacked && onRenameStack && !renaming && <button className="workbench-icon" aria-label="Rename stack" title="Rename stack on this computer" onClick={() => { setName(item.subject.name ?? item.subject.title); setNameError(''); setRenaming(true); }}><Pencil size={15} /></button>}
            {actions}
            {stacked && <StackMergeActions subject={item.subject} signals={signals} checks={checks.values} onChanged={onRetryStatus} />}
          </div>
          {renaming && <form className="stack-name-form" onSubmit={event => {
            event.preventDefault(); if (!onRenameStack || nameBusy) return;
            setNameBusy(true); setNameError('');
            void onRenameStack(name).then(() => setRenaming(false)).catch((error: unknown) => setNameError(`Could not save the stack name. ${error instanceof Error ? error.message.replace(/^Error:\s*/, '') : 'Try again.'}`)).finally(() => setNameBusy(false));
          }}>
            <label htmlFor="stack-name">Stack name <span>Only in Gnosis on this computer</span></label>
            <div><input id="stack-name" value={name} maxLength={120} autoFocus disabled={nameBusy} onChange={e => setName(e.target.value)} placeholder="Use the first PR title" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setRenaming(false); } }} /><Button size="sm" disabled={nameBusy} type="submit">{nameBusy ? 'Saving…' : 'Save'}</Button><Button size="sm" type="button" variant="ghost" disabled={nameBusy} onClick={() => setRenaming(false)}>Cancel</Button></div>
            {nameError && <p role="alert">{nameError}</p>}
          </form>}
          {starError && (
            <p role="alert" className="text-sm text-destructive">
              {starError}
            </p>
          )}
          <div className="pr-summary-context">
            <span>
              {stacked ? (
                <>
                  <Layers size={14} />
                  {item.subject.members.length} PRs{commonRepo && <RepositoryBadge repo={commonRepo} />}
                </>
              ) : (
                <>
                  <RepositoryBadge repo={first.repo} /> <PrBadge url={first.url} number={first.number} title={first.title} /> ·{' '}
                  <span className={`pr-state pr-state-${state.toLowerCase()}`}>{state}</span> · by{' '}
                  <GitHubAuthor login={first.author} /> · updated{' '}
                  <time dateTime={first.updatedAt}>{timeAgo(first.updatedAt)}</time>
                </>
              )}
            </span>
            {!stacked && (
              <a className="pr-github-link" href={first.url} target="_blank" rel="noopener noreferrer">
                GitHub <ExternalLink size={13} />
              </a>
            )}
          </div>
        </header>}</PrEntryActions>
        <div ref={statusRef} className="pr-merge-status" data-tour="summary" aria-label={stacked ? 'Stack status' : 'PR status'}>
          <PrStatusLine subject={item.subject} signals={signals} checking={!signalsLoaded && !!account} checks={checks.values} checkErrors={checks.errors}
            showReadiness={stacked || tab !== 'summary'} updating={item.subject.members.some(member => statuses[member.url]?.stale && !statusErrors[member.url])} />
          {stacked && <button aria-label="Refresh status" title="Refresh status" disabled={statusRefreshing || !account} onClick={onRetryStatus}><RefreshCw size={14} className={statusRefreshing ? 'animate-spin' : undefined} /></button>}
          {!stacked && <div className="pr-summary-review-actions" inert={tab !== 'summary'} style={{ visibility: tab === 'summary' ? 'visible' : 'hidden' }}>{summaryReview.controls}</div>}
        </div>
        <div className="pr-workspace-navigation">
        {scopeStack && onScopeChange && <nav className="stack-scope-bar" aria-label="Stack navigation">
          {parentStack ? <Button variant="ghost" size="sm" className="stack-back" aria-label="Back to stack" onClick={() => changeScope(parentStack.id)}><ChevronLeft size={15} aria-hidden="true" /><SubjectIcon kind="stack" />Stack</Button> : null}
          <SearchableSelect label="Review scope" value={item.subject.id} triggerLabel={stacked ? 'Whole stack' : `#${first.number} · ${scopeStack.members.findIndex(m => m.url === first.url) + 1} of ${scopeStack.members.length}`} options={stackScopeChoices(scopeStack)} onValueChange={changeScope} popupBoundary="viewport" popupClassName="stack-scope-popup" />
        </nav>}
        <Tabs.List className="pr-overview-tabs" aria-label="PR overview">
          <Tabs.Trigger value="summary"><WorkspaceIcon tab="summary" />Summary</Tabs.Trigger>
          <Tabs.Trigger value="changes" data-tour="changes"><WorkspaceIcon tab="changes" />Changes</Tabs.Trigger>
          <Tabs.Trigger value="commits"><WorkspaceIcon tab="commits" />Commits</Tabs.Trigger>
          <Tabs.Trigger value="checks"><WorkspaceIcon tab="checks" />Checks{checkTotals.attention > 0 && <span className="checks-tab-count">{checkTotals.attention}</span>}</Tabs.Trigger>
          <Tabs.Trigger value="feedback"><WorkspaceIcon tab="feedback" />Feedback</Tabs.Trigger>
          <Tabs.Trigger value="explanation" data-tour="explanation"><WorkspaceIcon tab="explanation" />Explanation</Tabs.Trigger>
          <Tabs.Trigger value="brief"><WorkspaceIcon tab="brief" />Local notes{brief.comments.length > 0 && <span className="brief-tab-count">{brief.comments.length}</span>}</Tabs.Trigger>
        </Tabs.List>

        </div>
        <KeptTab value="changes" tab={tab} visited={visited} arrival={arrival('changes')} className="pr-changes-tab">
          {preferences && (stacked ? <StackChangesView key={`${account}:${item.subject.id}`} subject={item.subject} preferences={preferences} account={account ?? ''} initialFile={initialFile} onOpenFeedback={(url, threadId) => { setFeedbackPr(url); setFeedbackThread(threadId); setFeedbackIntent('address'); setFeedbackJump(n => n + 1); onTabChange('feedback'); }} onOpenPr={changeScope} onOpenBrief={() => onTabChange('brief')} /> :
            <PrChangesView
              key={item.subject.id}
              subject={item.subject}
              preferences={preferences}
              account={account ?? ''}
              onOpenFeedback={(url, threadId) => { setFeedbackPr(url); setFeedbackThread(threadId); setFeedbackIntent('address'); setFeedbackJump(n => n + 1); onTabChange('feedback'); }}
              initialFile={initialFile}
              onOpenBrief={() => onTabChange('brief')}
            />
          )}
        </KeptTab>
        <KeptTab value="feedback" tab={tab} visited={visited} arrival={arrival('feedback')} className="pr-changes-tab">
          <PrFeedbackView key={`${account}:${item.subject.id}:${feedbackPr ?? ''}:${feedbackRequest?.id ?? ''}:${feedbackJump}`} subject={item.subject} account={account} initialPrUrl={feedbackPr} initialThreadId={feedbackThread} preferences={preferences ?? undefined} intent={feedbackIntent} onIntentHandled={() => { setFeedbackIntent(undefined); setFeedbackThread(undefined); }} onSource={item => {
            if (!item.thread) return;
            setInitialFile({ url: item.member.url, headSha: item.member.headSha, path: item.thread.path, line: feedbackCodeContext(item.thread, item.headSha ? { headSha: item.headSha, baseSha: item.baseSha ?? '' } : undefined, item.member) === 'current' ? item.thread.line ?? undefined : undefined, side: item.thread.diffSide === 'LEFT' ? 'before' : 'after' }); onTabChange('changes');
          }} />
        </KeptTab>
        <KeptTab value="brief" tab={tab} visited={visited} className="pr-changes-tab">
          <AgentBriefView key={item.subject.id} subject={item.subject} parentStack={parentStack} onOpenScope={onScopeChange ? changeScope : undefined} onOpenComment={openBriefComment} onOpenChanges={() => onTabChange('changes')} />
        </KeptTab>
        <KeptTab value="checks" tab={tab} visited={visited} arrival={arrival('checks')} className="pr-changes-tab">
          <PrChecksView key={`${account}:${item.subject.id}`} stateKey={`${account}:${item.subject.id}`} subject={item.subject} {...checks} focus={checkFocus}
            onSource={(url, path, line, headSha) => {
              setInitialFile({ url, path, line, headSha }); onTabChange('changes');
            }} />
        </KeptTab>
        <KeptTab value="commits" tab={tab} visited={visited} arrival={arrival('commits')} className="pr-changes-tab">
          {preferences && (
            <PrCommitsView
              key={item.subject.id}
              subject={item.subject}
              preferences={preferences}
              onOpenCurrentFile={(url, path) => {
                setInitialFile({ url, path });
                onTabChange('changes');
              }}
            />
          )}
        </KeptTab>
        <Tabs.Content value="explanation" className="pr-changes-tab" forceMount>
          <PrExplanation
            item={item}
            entries={explanations}
            destination={explanationDestination}
            active={tab === 'explanation' && shortcutsEnabled}
            preferences={preferences}
            starting={starting}
            error={error}
            onGenerate={onGenerate}
            onAiSetup={onAiSetup}
            onGitHubAuth={onGitHubAuth}
            onShowActivity={onShowActivity}
            onBack={back}
            onOpenChanges={() => onTabChange('changes')}
            onOpenChangesFile={(target) => {
              const member = item.subject.members.find((m) => m.url === target.url) ?? activeMember;
              // Lines only apply to the revision the answer read; a newer head opens just the file.
              const current = !!target.headSha && member.headSha === target.headSha;
              setInitialFile({
                url: member.url,
                path: target.path,
                headSha: current ? target.headSha : undefined,
                line: current ? target.line : undefined,
                endLine: current ? target.endLine : undefined,
                side: target.side,
              });
              onTabChange('changes');
            }}
          />
        </Tabs.Content>
        <KeptTab value="summary" tab={tab} visited={visited} arrival={arrival('summary')} className="pr-summary-content" ref={page} onScroll={remember}>
          <div className="pr-summary-body">
            {summaryReview.panel}
            {item.subject.warnings.map((warning) => (
              <p key={warning} className="workbench-notice" role="status">
                {warning}
              </p>
            ))}
            {stacked ? <div className="stack-summary-layout">
              <div className="stack-summary-main">
                <StackOverview account={account} checking={!signalsLoaded && !!account} onRefresh={onRetryStatus} refreshBusy={statusRefreshing || !account} item={item} signals={signals} checks={checks.values} checkErrors={checks.errors} checksBusy={checks.busy} matchingUrls={matchingUrls}
                  onFeedback={member => { setFeedbackPr(member.url); setFeedbackIntent('address'); setFeedbackJump(n => n + 1); onTabChange('feedback'); }} onOpen={member => changeScope(member.url)} onChecks={(member, id) => { setCheckFocus({ url: member.url, id, nonce: Date.now() }); changeScope(member.url); onTabChange('checks'); }} />
                {evidence}
                <StackBriefing briefing={item.briefing} actions={generationActions?.(item.subject.members)} onActivity={onShowActivity} onSetup={onGitHubAuth} connected={!!account} />
              </div>
            </div> : <PrSubjectDetails
              overview={{
                evidence,
                onChanges: () => onTabChange('changes'),
                stackContext: parentStack && <StackContext subject={parentStack} currentUrl={first.url} account={account} onOpen={changeScope} onStack={() => changeScope(parentStack.id)} compact />,
                briefing: item.briefing?.status === 'ready' && <details className="pr-briefing"><summary>AI briefing</summary><Markdown>{item.briefing.summary ?? ''}</Markdown></details>,
              }}
              generationActions={generationActions}
              onReview={onReview}
              reviewDisabled={!account}
              starredUrls={starredUrls}
              starBusy={starBusy}
              onStarChange={onStarChange}
              onMute={onMute}
              muteBusy={muteBusy}
              signals={signals}
              compactIdentity
              statusChecking={!signalsLoaded && !!account}
              subject={item.subject}
              activeUrl={activeUrl}
              onSelect={(url) => {
                remember();
                setMemberUrl(url);
              }}
              statuses={statuses}
              statusErrors={statusErrors}
              onRetryStatus={onRetryStatus}
            />}
          </div>
        </KeptTab>
      </main>
    </Tabs.Root>
  );
}

/** Review status and merge readiness in the page header. It re-renders on each status clock tick. */
function PrStatusLine({ subject, signals, checking, checks, checkErrors, showReadiness, updating }: {
  subject: ReviewSubject;
  signals: QueueSignals[];
  checking: boolean;
  checks: Partial<Record<string, PrChecks>>;
  checkErrors: Partial<Record<string, string>>;
  showReadiness: boolean;
  updating: boolean;
}) {
  countRender('PrStatusLine');
  const now = useStatusNow();
  const stacked = subject.kind === 'stack';
  const stackStatus = stacked ? stackMergeStatus(subject, signals, checks, now) : undefined;
  const mergePlan = stacked ? stackMergePlan(subject, signals, checks, now) : undefined;
  const readiness = stackStatus?.summary ?? subjectReadiness(subject, signals, now);
  return <>
    {!stacked && <SubjectReviewStatus subject={subject} signals={signals} checking={checking} now={now} />}
    {showReadiness && <ReadinessBadge readiness={stackStatus?.blocked ? { ...readiness, label: 'Not ready to merge' } : readiness} reviewStatusShown staleLabel={stacked ? 'Status needs refresh' : undefined} />}
    {showReadiness && (stacked && readiness.checkedAt === undefined ? <span className="merge-readiness-checked">Merge requirements not confirmed for all PRs</span> : <ReadinessCheckedAt readiness={readiness} label={stacked ? 'Merge requirements checked' : undefined} updating={updating} />)}
    {mergePlan && <StackChecksFreshness plan={mergePlan} now={now} delayed={Object.values(checkErrors).some(Boolean)} />}
  </>;
}

/** Merge actions for a whole stack. Whether it can merge depends on the status clock. */
function StackMergeActions({ subject, signals, checks, onChanged }: {
  subject: ReviewSubject;
  signals: QueueSignals[];
  checks: Partial<Record<string, PrChecks>>;
  onChanged: () => void;
}) {
  const now = useStatusNow();
  const ready = stackMergeStatus(subject, signals, checks, now).summary.ready;
  return <PrActions member={subject.members[subject.members.length - 1]} stackMembers={subject.members} mergeReady={ready} onChanged={onChanged} />;
}

export function PrSummary(props: ComponentProps<typeof PrSummaryContent>) {
  return <ReviewBreadcrumbProvider><PrSummaryContent {...props} /></ReviewBreadcrumbProvider>;
}
