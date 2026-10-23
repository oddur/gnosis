import { useEffect, useRef } from 'react';
import { ArrowLeft, ArrowRight, Layers } from 'lucide-react';
import { Button } from './ui/button';
import { Markdown } from './Markdown';
import { PrDetails } from './PrDetails';
import { fingerprint, type QueueItem } from '../lib/workbench';
import type { PrStatus } from '../lib/types';

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
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [item.subject.id]);
  const running = starting || item.review?.status === 'generating';
  const ready = item.review?.status === 'completed';
  const current = ready && item.review?.snapshot?.fingerprint === fingerprint(item.subject);
  return (
    <main className="pr-summary-page">
      <div className="pr-summary-toolbar">
        <button onClick={onBack} className="pr-back">
          <ArrowLeft size={15} /> Work queue
        </button>
        <div className="pr-summary-actions">
          {ready && !current && (
            <Button variant="outline" size="sm" onClick={onOpenReview}>
              Open previous explanation
            </Button>
          )}
          <Button size="sm" disabled={running} onClick={current ? onOpenReview : onGenerate}>
            {running
              ? 'Generating explanation…'
              : current
                ? 'Open explanation'
                : ready
                  ? 'Generate updated explanation'
                  : 'Generate explanation'}
            {!running && <ArrowRight size={14} />}
          </Button>
        </div>
      </div>
      <div className="pr-summary-content">
        <h1 ref={heading} tabIndex={-1}>
          {item.subject.title}
        </h1>
        <p className="pr-summary-context">
          {item.subject.kind === 'stack' ? (
            <>
              <Layers size={14} /> {item.subject.members.length} PRs in this stack · one explanation
            </>
          ) : (
            `${item.subject.members[0].repo} #${item.subject.members[0].number}`
          )}{' '}
          · GitHub description and metadata
        </p>
        {running && (
          <p role="status" className="workbench-notice">
            The explanation is running in the background. Track it in Activity; you can keep reading or return to the
            queue.
          </p>
        )}
        {error && (
          <p role="alert" className="workbench-notice error">
            {error}
          </p>
        )}
        {item.review?.status === 'failed' && (
          <p className="workbench-notice">The explanation could not be completed. You can try generating it again.</p>
        )}
        {item.briefing?.status === 'ready' && (
          <details className="pr-briefing">
            <summary>AI briefing</summary>
            <Markdown>{item.briefing.summary ?? ''}</Markdown>
          </details>
        )}
        {item.subject.members.map((member) => (
          <PrDetails
            key={member.url}
            member={member}
            showTitle={item.subject.members.length > 1}
            status={statuses[member.url]}
            statusError={statusErrors[member.url]}
            onRetryStatus={onRetryStatus}
          />
        ))}
        {item.subject.warnings.map((warning) => (
          <p key={warning} className="workbench-notice">
            {warning}
          </p>
        ))}
      </div>
    </main>
  );
}
