import { useRef, useState, type ReactNode } from 'react';
import { CloseWhenHidden } from './PrActionControls';
import { Popover } from 'radix-ui';
import { AlertCircle, CheckCircle2, ChevronDown, CircleHelp, Clock3 } from 'lucide-react';
import { conflictIcon } from '../lib/interface-icons';
import type { MergeReadiness } from '../lib/merge-readiness';
import { timeAgo } from '../lib/utils';

/** The review status chip already says these: the readiness slot keeps to merge eligibility. */
const REVIEW_LABELS = ['Changes requested', 'Approval required', 'Draft PR', 'Merged', 'Closed'];
function readinessIcon(readiness: MergeReadiness) {
  return readiness.label === 'Merge conflicts'
    ? conflictIcon
    : readiness.mismatch
      ? CircleHelp
      : readiness.tone === 'success'
        ? CheckCircle2
        : readiness.tone === 'danger'
          ? AlertCircle
          : readiness.tone === 'warning'
            ? Clock3
            : CircleHelp;
}
const readinessLabel = (readiness: MergeReadiness, staleLabel: string) =>
  `${readiness.label}${readiness.stale && readiness.label !== 'Readiness out of date' ? ` · ${staleLabel}` : ''}`;

export function ReadinessBadge({ readiness, reviewStatusShown = false, staleLabel = 'Out of date' }: { readiness: MergeReadiness; reviewStatusShown?: boolean; staleLabel?: string }) {
  if (reviewStatusShown && REVIEW_LABELS.includes(readiness.label)) return null;
  const Icon = readinessIcon(readiness);
  const description = [
    ...readiness.details,
    readiness.checkedAt ? `Last checked ${new Date(readiness.checkedAt).toLocaleString()}.` : '',
  ].join(' ');
  return (
    <><span className={`merge-readiness-badge is-${readiness.tone}`} title={description}>
      <Icon size={14} aria-hidden="true" />
      <span>{readinessLabel(readiness, staleLabel)}</span>
    </span>{!!readiness.blockedCount && <span className="merge-readiness-blocked">{readiness.blockedCount} blocked</span>}</>
  );
}

/**
 * Merge readiness in the PR header on every tab (#542): a chip with the verdict, such as "Checks running". Its popover
 * has the full sentences, the checks and when Gnosis last checked (`children`).
 */
export function ReadinessChip({ readiness, staleLabel = 'Out of date', reviewStatusShown = false, children }: {
  readiness: MergeReadiness;
  staleLabel?: string;
  reviewStatusShown?: boolean;
  children?: ReactNode;
}) {
  if (reviewStatusShown && REVIEW_LABELS.includes(readiness.label)) return null;
  const Icon = readinessIcon(readiness);
  const label = readinessLabel(readiness, staleLabel);
  return <ReadinessChipPopover readiness={readiness} label={label} Icon={Icon}>{children}</ReadinessChipPopover>;
}

function ReadinessChipPopover({ readiness, label, Icon, children }: { readiness: MergeReadiness; label: string; Icon: ReturnType<typeof readinessIcon>; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      {open && <CloseWhenHidden onClose={() => setOpen(false)} content={content} />}
      <Popover.Trigger asChild>
        <button type="button" className={`merge-readiness-badge merge-readiness-chip is-${readiness.tone}`} aria-label={`${label}. Merge readiness details`}>
          <Icon size={14} aria-hidden="true" />
          <span>{label}</span>
          {!!readiness.blockedCount && <span className="merge-readiness-blocked">{readiness.blockedCount} blocked</span>}
          <ChevronDown size={12} aria-hidden="true" className="merge-readiness-chevron" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content ref={content} className="readiness-popover" align="end" sideOffset={6} collisionPadding={12} tabIndex={-1}
          onOpenAutoFocus={(event) => { event.preventDefault(); (event.currentTarget as HTMLElement).focus(); }}>
          <p className={`merge-readiness-badge is-${readiness.tone}`}>
            <Icon size={14} aria-hidden="true" />
            <span>{label}</span>
          </p>
          {readiness.details.length > 0 && (
            <ul>
              {readiness.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          )}
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** `updating` marks a saved status that GitHub is confirming. */
export function ReadinessCheckedAt({ readiness, label = 'Checked', updating = false }: { readiness: MergeReadiness; label?: string; updating?: boolean }) {
  return (
    <span className="merge-readiness-checked">
      {readiness.checkedAt ? (
        <>
          {label}{' '}
          <time
            dateTime={new Date(readiness.checkedAt).toISOString()}
            title={new Date(readiness.checkedAt).toLocaleString()}
          >
            {timeAgo(new Date(readiness.checkedAt).toISOString())}
          </time>
        </>
      ) : (
        'Not checked for this revision'
      )}
      {updating && ' · updating'}
    </span>
  );
}
