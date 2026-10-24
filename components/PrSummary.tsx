import { PrMuteMenu } from './PrMuteMenu';
import { PrExplanation } from './PrExplanation';
import type { ExplanationDestination } from '../lib/explanation-workspace';
import type { ReviewHistoryEntry } from '../lib/types';
import { Tabs } from 'radix-ui';
import { PrCommitsView } from './PrCommitsView';
import { PrChangesView } from './PrChangesView';
import type { Preferences } from '../lib/types';
import { GitHubAuthor } from './GitHubAuthor';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, ExternalLink, Layers, RefreshCw } from 'lucide-react';
import { Markdown } from './Markdown';
import { PrSubjectDetails } from './PrSubjectDetails';
import { type QueueItem } from '../lib/workbench';
import type { PrStatus } from '../lib/types';
import { timeAgo } from '../lib/utils';
import { useQueueSignals } from '../lib/use-queue-signals';
import { subjectReadiness } from '../lib/merge-readiness';
import { ReadinessBadge, ReadinessCheckedAt } from './MergeReadiness';
import { PrStarButton } from './PrStarButton';

export interface PrReadingPosition {
  memberUrl: string;
  scroll: Record<string, number>;
}

export function PrSummary({
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
  onGenerate,
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
  tab: 'summary' | 'changes' | 'commits' | 'explanation';
  onTabChange: (tab: 'summary' | 'changes' | 'commits' | 'explanation') => void;
  preferences: Preferences | null;
  starting: boolean;
  error: string;
  statuses: Partial<Record<string, PrStatus>>;
  statusErrors: Record<string, string>;
  onBack: () => void;
  onGenerate: () => void;
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
  };
  positions: Map<string, PrReadingPosition>;
  shortcutsEnabled?: boolean;
}) {
  const [initialFile, setInitialFile] = useState<{ url: string; path: string }>();
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
  const stacked = item.subject.members.length > 1;
  const first = item.subject.members[0];
  const { ref: statusRef, values: signals } = useQueueSignals(
    account,
    item.subject.members.map((m) => ({ url: m.url, headSha: m.headSha }))
  );
  const readiness = subjectReadiness(item.subject, signals);
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
      if (event.composedPath().some((node) => node instanceof Element && node.matches('.pr-changes'))) return;
      if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (
        target?.isContentEditable ||
        target?.closest(
          'input, textarea, select, summary, [role="dialog"], [role="menu"], .activity-shell, .workbench-help'
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
  return (
    <Tabs.Root
      value={tab}
      onValueChange={(value) => {
        if (tab === 'summary') remember();
        onTabChange(value as 'summary' | 'changes' | 'commits' | 'explanation');
      }}
      asChild
    >
      <main className={`pr-summary-page ${stacked ? 'is-stack' : ''} ${tab !== 'summary' ? 'showing-changes' : ''}`}>
        <div className="pr-summary-toolbar">
          <div className="pr-summary-toolbar-inner">
            <button onClick={back} className="pr-back" title="Return to work queue (Esc)">
              <ArrowLeft size={15} />
              Work queue
            </button>
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
        <header className="pr-overview-heading">
          <div className="pr-title-with-star">
            <h1 ref={heading} tabIndex={-1}>
              {item.subject.title}
            </h1>
            <PrStarButton
              members={item.subject.members}
              starredUrls={starredUrls}
              busy={starBusy}
              onChange={onStarChange}
            />
            <PrMuteMenu members={item.subject.members} busy={muteBusy} onMute={onMute} />
          </div>
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
                  {item.subject.members.length} PRs · one AI explanation
                </>
              ) : (
                <>
                  {first.repo} #{first.number} ·{' '}
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
        </header>
        <div ref={statusRef} className="pr-merge-status" aria-label="Merge readiness">
          <ReadinessBadge readiness={readiness} />
          <ReadinessCheckedAt readiness={readiness} />
          <button
            type="button"
            aria-label="Refresh status"
            title={statusRefreshing ? 'Refreshing status…' : 'Refresh status'}
            aria-busy={statusRefreshing}
            disabled={statusRefreshing}
            onClick={onRetryStatus}
          >
            <RefreshCw
              size={14}
              aria-hidden="true"
              className={statusRefreshing ? 'motion-safe:animate-spin' : undefined}
            />
          </button>
        </div>
        <Tabs.List className="pr-overview-tabs" aria-label="PR overview">
          <Tabs.Trigger value="summary">Summary</Tabs.Trigger>
          <Tabs.Trigger value="changes">Changes</Tabs.Trigger>
          <Tabs.Trigger value="commits">Commits</Tabs.Trigger>
          <Tabs.Trigger value="explanation">Explanation</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="changes" className="pr-changes-tab">
          {preferences && (
            <PrChangesView
              key={item.subject.id}
              subject={item.subject}
              preferences={preferences}
              initialFile={initialFile}
            />
          )}
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
            {item.subject.warnings.map((warning) => (
              <p key={warning} className="workbench-notice" role="status">
                {warning}
              </p>
            ))}
            {item.briefing?.status === 'ready' && (
              <details className="pr-briefing" open>
                <summary>AI briefing</summary>
                <Markdown>{item.briefing.summary ?? ''}</Markdown>
              </details>
            )}
            <PrSubjectDetails
              starredUrls={starredUrls}
              starBusy={starBusy}
              onStarChange={onStarChange}
              onMute={onMute}
              muteBusy={muteBusy}
              signals={signals}
              compactIdentity
              subject={item.subject}
              activeUrl={activeUrl}
              onSelect={(url) => {
                remember();
                setMemberUrl(url);
              }}
              statuses={statuses}
              statusErrors={statusErrors}
              onRetryStatus={onRetryStatus}
            />
          </div>
        </Tabs.Content>
      </main>
    </Tabs.Root>
  );
}
