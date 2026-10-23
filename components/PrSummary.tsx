import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, ExternalLink, Layers } from 'lucide-react';
import { Button } from './ui/button';
import { Markdown } from './Markdown';
import { PrSubjectDetails } from './PrSubjectDetails';
import { fingerprint, type QueueItem } from '../lib/workbench';
import type { PrStatus } from '../lib/types';
import { timeAgo } from '../lib/utils';

export interface PrReadingPosition {
  memberUrl: string;
  scroll: Record<string, number>;
}

export function PrSummary({
  item,
  starting,
  error,
  statuses,
  statusErrors,
  onBack,
  onGenerate,
  onOpenReview,
  onRetryStatus,
  onAiSetup,
  navigation,
  positions,
  shortcutsEnabled = true,
}: {
  item: QueueItem;
  starting: boolean;
  error: string;
  statuses: Partial<Record<string, PrStatus>>;
  statusErrors: Record<string, string>;
  onBack: () => void;
  onGenerate: () => void;
  onOpenReview: () => void;
  onRetryStatus: () => void;
  onAiSetup?: () => void;
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
  const heading = useRef<HTMLHeadingElement>(null);
  const page = useRef<HTMLElement>(null);
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
    const content = element.querySelector('.pr-summary-content');
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
  }, [activeUrl, position]);
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
  }, [navigation, onBack, shortcutsEnabled, activeUrl, position]);
  const running = starting || item.review?.status === 'generating';
  const ready = item.review?.status === 'completed';
  const current = ready && item.review?.snapshot?.fingerprint === fingerprint(item.subject);
  return (
    <main
      className={`pr-summary-page ${stacked ? 'is-stack' : ''}`}
      ref={page}
      onScroll={() => {
        remember();
      }}
    >
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
          <div className="pr-summary-actions">
            {ready && !current && (
              <Button variant="outline" size="sm" onClick={onOpenReview}>
                Open previous AI explanation
              </Button>
            )}
            <Button size="sm" disabled={running} onClick={current ? onOpenReview : onGenerate}>
              {running
                ? 'Generating AI explanation…'
                : current
                  ? 'Open AI explanation'
                  : ready
                    ? 'Update AI explanation'
                    : 'Generate AI explanation'}
              {!running && <ArrowRight size={14} />}
            </Button>
          </div>
        </div>
      </div>
      <div className="pr-summary-content">
        <h1 ref={heading} tabIndex={-1}>
          {item.subject.title}
        </h1>
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
                <span className={`pr-state pr-state-${state.toLowerCase()}`}>{state}</span> · by {first.author} ·
                updated <time dateTime={first.updatedAt}>{timeAgo(first.updatedAt)}</time>
              </>
            )}
          </span>
          {!stacked && (
            <a className="pr-github-link" href={first.url} target="_blank" rel="noopener noreferrer">
              GitHub <ExternalLink size={13} />
            </a>
          )}
        </div>
        <div className="pr-explanation-help">
          <span>AI explanations walk through the changes alongside the code.</span>
          {!current && !running && onAiSetup && (
            <button className="workbench-help-link" onClick={onAiSetup}>
              AI setup
            </button>
          )}
          <span className="pr-summary-shortcuts">
            <kbd>j</kbd>/<kbd>k</kbd> next/previous · <kbd>Esc</kbd> queue
          </span>
        </div>
        {item.subject.warnings.map((warning) => (
          <p key={warning} className="workbench-notice" role="status">
            {warning}
          </p>
        ))}
        {running && (
          <p role="status" className="workbench-notice">
            Your AI explanation is running in the background. Track progress in Activity while you keep reading.
          </p>
        )}
        {error && (
          <div role="alert" className="workbench-notice error">
            <p>Could not open or generate the AI explanation. Your PR description is still available.</p>
            <details>
              <summary>Error details</summary>
              <p>{error}</p>
            </details>
          </div>
        )}
        {item.review?.status === 'failed' && (
          <p className="workbench-notice">The AI explanation could not be completed. Generate it again to retry.</p>
        )}
        {item.briefing?.status === 'ready' && (
          <details className="pr-briefing" open>
            <summary>AI briefing</summary>
            <Markdown>{item.briefing.summary ?? ''}</Markdown>
          </details>
        )}
        <PrSubjectDetails
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
    </main>
  );
}
