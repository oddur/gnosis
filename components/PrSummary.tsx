import { stackMergePlan } from '../lib/stack-merge-plan';
import { StackChecksFreshness } from './StackMergePlan';
import { StackChangesView } from './StackChangesView';
import { StackBriefing } from './StackBriefing';
import { StackContext } from './StackContext';
import { StackOverview } from './StackOverview';
import { SearchableSelect } from './SearchableSelect';
import { stackScopeChoices } from '../lib/stack-workspace';
import { Button } from './ui/button';
import { PrChecksView, type CheckFocus } from './PrChecksView';
import { PrCheckSummary } from './PrCheckSummary';
import { usePrChecks } from '../lib/use-pr-checks';
import { checkCounts } from '../lib/pr-checks';
import { RepositoryBadge, PrBadge } from './EntityBadge';
import { usePrReadVisit } from '../lib/pr-read-context';
import { PrActions } from './PrActions';
import { ReviewBreadcrumbProvider, useReviewBreadcrumbs } from '../lib/review-breadcrumbs';
import { ReviewBreadcrumbs } from './ReviewBreadcrumbs';
import type { ComponentProps } from 'react';
import { PrEntryActions, PrStarMarker, type PrGenerationActionsFor } from './PrEntryActions';
import { PrExplanation } from './PrExplanation';
import type { ExplanationDestination } from '../lib/explanation-workspace';
import type { ReviewHistoryEntry } from '../lib/types';
import { Tabs } from 'radix-ui';
import { PrCommitsView } from './PrCommitsView';
import { PrChangesView } from './PrChangesView';
import type { Preferences } from '../lib/types';
import { GitHubAuthor } from './GitHubAuthor';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, Layers, Pencil, RefreshCw } from 'lucide-react';
import { Markdown } from './Markdown';
import { PrSubjectDetails } from './PrSubjectDetails';
import { type QueueItem } from '../lib/workbench';
import type { PrStatus } from '../lib/types';
import { timeAgo } from '../lib/utils';
import { useQueueSignals } from '../lib/use-queue-signals';
import { stackMergeStatus } from '../lib/stack-merge-status';
import { subjectReadiness } from '../lib/merge-readiness';
import { ReadinessBadge, ReadinessCheckedAt } from './MergeReadiness';
import { SubjectReviewStatus } from './PrReviewStatus';
import { useChangesComments } from './useChangesComments';
import type { ReviewMember } from '../lib/workbench';

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
  starredUrls: ReadonlySet<string>;
  starBusy: boolean;
  muteBusy: boolean;
  onMute: (members: QueueItem['subject']['members']) => void;
  starError: string;
  onStarChange: (members: QueueItem['subject']['members'], starred: boolean) => void;
  account: string | null;
  statusRefreshing: boolean;
  tab: 'summary' | 'changes' | 'commits' | 'explanation' | 'checks';
  onTabChange: (tab: 'summary' | 'changes' | 'commits' | 'explanation' | 'checks') => void;
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
  onGenerate: () => void;
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
  usePrReadVisit(item.subject.members, tab === 'summary' && item.subject.kind === 'pr', 'summary');
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(item.subject.name ?? '');
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState('');
  const [initialFile, setInitialFile] = useState<{ url: string; path: string; line?: number; headSha?: string }>();
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
  // Use one render-time clock for the entire workspace. Child-only cache updates
  // must not age member badges while leaving the header claiming fresh status.
  const [, tickStatus] = useState(0);
  useEffect(() => {
    const tick = () => tickStatus(value => value + 1);
    const timer = setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, []);
  const statusNow = Date.now();
  const stackStatus = stacked ? stackMergeStatus(item.subject, signals, checks.values, statusNow) : undefined;
  const mergePlan = stacked ? stackMergePlan(item.subject, signals, checks.values, statusNow) : undefined;
  const readiness = stackStatus?.summary ?? subjectReadiness(item.subject, signals, statusNow);
  const commonRepo = stacked && new Set(item.subject.members.map(m => m.repo)).size === 1 ? first.repo : undefined;
  const state = first.merged ? 'Merged' : first.state === 'closed' ? 'Closed' : first.isDraft ? 'Draft' : 'Open';
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    const element = page.current;
    if (!element) return;
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
    if (page.current && !restoring.current) position.scroll[activeUrl] = page.current.scrollTop;
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
          'input, textarea, select, summary, [role="combobox"], [role="dialog"], [role="menu"], .review-breadcrumbs, .activity-shell, .workbench-help'
        )
      )
        return;
      if (document.querySelector('[role="dialog"], [role="menu"], .workbench-help')) return;
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
  const tabs = [{ value: 'summary', label: 'Summary' }, { value: 'changes', label: 'Changes' },
    { value: 'commits', label: 'Commits' }, { value: 'checks', label: 'Checks' }, { value: 'explanation', label: 'Explanation' }];
  return (
    <Tabs.Root
      value={tab}
      onValueChange={(value) => {
        if (tab === 'summary') remember();
        onTabChange(value as 'summary' | 'changes' | 'commits' | 'explanation' | 'checks');
      }}
      asChild
    >
      <main className={`pr-summary-page ${stacked ? 'is-stack' : ''} ${tab !== 'summary' ? 'showing-changes' : ''}`}>
        <div className="pr-summary-toolbar">
          <div className="pr-summary-toolbar-inner">
            <ReviewBreadcrumbs scope={tab} base={[
              { id: 'origin', label: navigation.viewName, navigate: () => { remember(); (onQueue ?? onBack)(); } },
              ...(parentStack ? [{ id: 'parent-stack', label: parentStack.title, title: 'Stack', navigate: () => changeScope(parentStack.id) }] : []),
              { id: 'subject', label: stacked ? `Stack · ${item.subject.title}` : `${first.repo} #${first.number}`,
                title: item.subject.title, navigate: () => { remember(); onTabChange('summary'); },
                pickerLabel: parentStack ? 'PR in stack' : 'PR or stack', value: item.subject.id, options: parentStack ? stackScopeChoices(parentStack).slice(1) : navigation.choices,
                select: id => { remember(); if (parentStack) changeScope(id); else navigation.select(id); } },
              { id: 'tab', label: tabs.find(t => t.value === tab)?.label ?? 'Summary',
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
            <h1 ref={heading} tabIndex={-1}>
              {item.subject.title}
            </h1>
            <PrStarMarker members={item.subject.members} starredUrls={starredUrls} />
            {stacked && onRenameStack && !renaming && <button className="workbench-icon" aria-label="Rename stack" title="Rename stack on this computer" onClick={() => { setName(item.subject.name ?? item.subject.title); setNameError(''); setRenaming(true); }}><Pencil size={15} /></button>}
            {actions}
            {stacked && <PrActions member={item.subject.members[item.subject.members.length - 1]} stackMembers={item.subject.members} mergeReady={readiness.ready} onChanged={onRetryStatus} />}
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
          {!stacked && <SubjectReviewStatus subject={item.subject} signals={signals} checking={!signalsLoaded && !!account} now={statusNow} />}
          <ReadinessBadge readiness={stackStatus?.blocked ? { ...readiness, label: 'Not ready to merge' } : readiness} reviewStatusShown staleLabel={stacked ? 'Status needs refresh' : undefined} />
          {stacked && readiness.checkedAt === undefined ? <span className="merge-readiness-checked">Merge requirements not confirmed for all PRs</span> : <ReadinessCheckedAt readiness={readiness} label={stacked ? 'Merge requirements checked' : undefined} />}
          {mergePlan && <StackChecksFreshness plan={mergePlan} now={statusNow} delayed={Object.values(checks.errors).some(Boolean)} />}
          {stacked && <button aria-label="Refresh status" title="Refresh status" disabled={statusRefreshing || !account} onClick={onRetryStatus}><RefreshCw size={14} className={statusRefreshing ? 'animate-spin' : undefined} /></button>}
          {!stacked && <div className="pr-summary-review-actions" inert={tab !== 'summary'} style={{ visibility: tab === 'summary' ? 'visible' : 'hidden' }}>{summaryReview.controls}</div>}
        </div>
        <div className="pr-workspace-navigation">
        <Tabs.List className="pr-overview-tabs" aria-label="PR overview">
          <Tabs.Trigger value="summary">Summary</Tabs.Trigger>
          <Tabs.Trigger value="changes" data-tour="changes">Changes</Tabs.Trigger>
          <Tabs.Trigger value="commits">Commits</Tabs.Trigger>
          <Tabs.Trigger value="checks">Checks{checkTotals.attention > 0 && <span className="checks-tab-count">{checkTotals.attention}</span>}</Tabs.Trigger>
          <Tabs.Trigger value="explanation" data-tour="explanation">Explanation</Tabs.Trigger>
        </Tabs.List>
        {scopeStack && onScopeChange && <nav className="stack-scope-bar" aria-label="Stack navigation">
          <Layers size={15} aria-hidden="true" /><SearchableSelect label="Review scope" value={item.subject.id} triggerLabel={stacked ? 'Whole stack' : `#${first.number} · ${scopeStack.members.findIndex(m => m.url === first.url) + 1} of ${scopeStack.members.length}`} options={stackScopeChoices(scopeStack)} onValueChange={changeScope} popupBoundary="viewport" popupClassName="stack-scope-popup" />
          {parentStack && <button className="stack-back" onClick={() => changeScope(parentStack.id)}>Back to stack</button>}
        </nav>}
        </div>
        <Tabs.Content value="changes" className="pr-changes-tab">
          {preferences && (stacked ? <StackChangesView key={`${account}:${item.subject.id}`} subject={item.subject} preferences={preferences} account={account ?? ''} initialFile={initialFile} onOpenPr={changeScope} /> :
            <PrChangesView
              key={item.subject.id}
              subject={item.subject}
              preferences={preferences}
              initialFile={initialFile}
            />
          )}
        </Tabs.Content>
        <Tabs.Content value="checks" className="pr-changes-tab">
          <PrChecksView key={`${account}:${item.subject.id}`} subject={item.subject} {...checks} focus={checkFocus}
            onSource={(url, path, line, headSha) => {
              setInitialFile({ url, path, line, headSha }); onTabChange('changes');
            }} />
        </Tabs.Content>
        <Tabs.Content value="commits" className="pr-changes-tab">
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
        </Tabs.Content>
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
          />
        </Tabs.Content>
        <Tabs.Content value="summary" className="pr-summary-content" ref={page} onScroll={remember}>
          <div className="pr-summary-body">
            {summaryReview.panel}
            {item.subject.warnings.map((warning) => (
              <p key={warning} className="workbench-notice" role="status">
                {warning}
              </p>
            ))}
            {!stacked && item.briefing?.status === 'ready' && (
              <details className="pr-briefing" open>
                <summary>AI briefing</summary>
                <Markdown>{item.briefing.summary ?? ''}</Markdown>
              </details>
            )}
            {parentStack && <StackContext subject={parentStack} currentUrl={first.url} account={account} now={statusNow} onOpen={changeScope} onStack={() => changeScope(parentStack.id)} />}
            {stacked ? <div className="stack-summary-layout">
              <div className="stack-summary-main">
                <StackOverview account={account} now={statusNow} checking={!signalsLoaded && !!account} onRefresh={onRetryStatus} refreshBusy={statusRefreshing || !account} item={item} signals={signals} checks={checks.values} checkErrors={checks.errors} checksBusy={checks.busy} matchingUrls={matchingUrls}
                  onOpen={member => changeScope(member.url)} onChecks={(member, id) => { setCheckFocus({ url: member.url, id, nonce: Date.now() }); changeScope(member.url); onTabChange('checks'); }} />
                <StackBriefing briefing={item.briefing} actions={generationActions?.(item.subject.members)} onActivity={onShowActivity} onSetup={onGitHubAuth} connected={!!account} />
              </div>
            </div> : <PrSubjectDetails
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
              checkSummary={url => <PrCheckSummary value={checks.values[url]} error={checks.errors[url]} busy={checks.busy} onOpen={id => openChecks(url, id)} />}
              statuses={statuses}
              statusErrors={statusErrors}
              onRetryStatus={onRetryStatus}
            />}
          </div>
        </Tabs.Content>
      </main>
    </Tabs.Root>
  );
}

export function PrSummary(props: ComponentProps<typeof PrSummaryContent>) {
  return <ReviewBreadcrumbProvider><PrSummaryContent {...props} /></ReviewBreadcrumbProvider>;
}
