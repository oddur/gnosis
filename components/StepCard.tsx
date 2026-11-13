/*
 * Step cards follow the shape of Beautiful UI's "Approval Card" (component 04,
 * https://www.beautifului.dev/, MIT License): a paged question with a counter, Skip and Continue.
 * This implementation is written for Gnosis; no Beautiful UI code is copied.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import {
  ArrowRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleMinus,
  CirclePause,
  LoaderCircle,
} from 'lucide-react';
import { Button } from './ui/button';
import type { ActionStep, ActionStepStatus } from '../lib/action-steps';

const icons: Record<ActionStepStatus, typeof Circle> = {
  upcoming: Circle,
  current: CircleDot,
  running: LoaderCircle,
  paused: CirclePause,
  done: CircleCheck,
  blocked: CircleAlert,
  failed: CircleAlert,
  skipped: CircleMinus,
};
const statusText: Record<ActionStepStatus, string> = {
  upcoming: 'Not started',
  current: 'Current step',
  running: 'In progress',
  paused: 'Paused',
  done: 'Done',
  blocked: 'Blocked',
  failed: 'Failed',
  skipped: 'Not needed',
};

/** The visible plan. Status is carried by icon and text, never color alone. */
export function StepList({
  steps,
  current,
  label,
  compact = false,
  onRetry,
  retryLabel = 'Retry',
  busy = false,
  errorRef,
}: {
  steps: ActionStep[];
  current: number;
  label: string;
  compact?: boolean;
  onRetry?: () => void;
  retryLabel?: string;
  busy?: boolean;
  errorRef?: Ref<HTMLDivElement>;
}) {
  return (
    <ol className="step-list" data-compact={compact || undefined} aria-label={label}>
      {steps.map((step, index) => {
        const Icon = icons[step.status];
        return (
          <li
            key={step.id}
            data-step={step.id}
            data-status={step.status}
            aria-current={index === current ? 'step' : undefined}
          >
            <Icon
              size={compact ? 13 : 15}
              aria-hidden="true"
              className={step.status === 'running' ? 'step-list-icon motion-safe:animate-spin' : 'step-list-icon'}
            />
            <span className="step-list-text">
              <span className="step-list-label">
                {step.label}
                <span className="sr-only">. {statusText[step.status]}.</span>
                {step.optional && step.status !== 'done' && <span className="step-list-optional">Optional</span>}
              </span>
              {step.detail && !compact && <span className="step-list-detail">{step.detail}</span>}
              {step.error && (
                <div
                  className="step-list-error"
                  role={step.status === 'failed' ? 'alert' : 'status'}
                  tabIndex={-1}
                  ref={step.status === 'failed' ? errorRef : undefined}
                >
                  <p>{step.error}</p>
                  {onRetry && (
                    <Button size="xs" variant="outline" disabled={busy} onClick={onRetry}>
                      {retryLabel}
                    </Button>
                  )}
                </div>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

const interactive =
  'button,a,select,textarea,summary,[role=combobox],[role=listbox],[contenteditable=true],input:not([type=text]):not([type=search])';

/**
 * Shows what will happen, in order, before anything runs. Enter continues ordinary steps; a push
 * or merge needs its own button, so a repeated Enter can never reach the point of no return.
 */
export function StepCard({
  title,
  description,
  steps,
  current,
  children,
  onContinue,
  continueLabel = 'Continue',
  continueDisabled = false,
  onBack,
  backLabel = 'Back',
  onSkip,
  skipLabel = 'Skip',
  skipDescription,
  onCancel,
  cancelLabel = 'Cancel',
  onRetry,
  retryLabel,
  busy = false,
  status,
  className,
  ariaLabel,
  autoFocus = false,
}: {
  title: ReactNode;
  description?: ReactNode;
  steps: ActionStep[];
  current: number;
  children?: ReactNode;
  onContinue?: () => void;
  continueLabel?: ReactNode;
  continueDisabled?: boolean;
  onBack?: () => void;
  backLabel?: string;
  /** Only for optional steps the flow can really leave out. */
  onSkip?: () => void;
  skipLabel?: string;
  skipDescription?: string;
  onCancel?: () => void;
  cancelLabel?: string;
  onRetry?: () => void;
  retryLabel?: string;
  busy?: boolean;
  /** Footer status text, such as review progress. */
  status?: ReactNode;
  className?: string;
  ariaLabel?: string;
  /** Take focus as soon as the first step has content, so Enter continues from the start. */
  autoFocus?: boolean;
}) {
  const id = useId();
  const step = steps[current] as ActionStep | undefined;
  const body = useRef<HTMLDivElement>(null);
  const error = useRef<HTMLDivElement>(null);
  const [announcement, setAnnouncement] = useState('');
  const position = `Step ${current + 1} of ${steps.length}: ${step?.label ?? ''}`;
  const mounted = useRef(false);
  const hasBody = !!children;
  useEffect(() => {
    setAnnouncement(position);
    // Opening focus belongs to the surrounding view unless requested; step changes move focus here.
    if ((mounted.current || autoFocus) && hasBody) body.current?.focus();
    mounted.current = true;
  }, [current, step?.id, hasBody]);
  useEffect(() => {
    if (step?.status === 'running') setAnnouncement(`${step.label}. In progress.`);
    else if (step?.status === 'done' && current === steps.length - 1) setAnnouncement(`${step.label}. Done.`);
  }, [step?.status]);
  useEffect(() => {
    if (step?.status === 'failed') error.current?.focus();
  }, [step?.status, step?.error]);
  const canContinue = !!onContinue && !continueDisabled && !busy && step?.status !== 'running';
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Enter' || event.repeat || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey)
      return;
    const target = event.target as HTMLElement;
    if (!onContinue || target.closest(interactive) || step?.pointOfNoReturn || !canContinue || event.defaultPrevented)
      return;
    event.preventDefault();
    onContinue();
  }
  const optional = !!step?.optional && !!onSkip;
  return (
    <section
      className={`step-card ${className ?? ''}`}
      aria-labelledby={ariaLabel ? undefined : `${id}-title`}
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      data-step={step?.id}
    >
      <header className="step-card-header">
        <div id={`${id}-title`} className="step-card-title">
          {title}
        </div>
        <span className="step-card-count" aria-hidden="true">
          {current + 1} / {steps.length}
        </span>
      </header>
      {description && <div className="step-card-description">{description}</div>}
      <StepList
        steps={steps}
        current={current}
        label="Steps"
        onRetry={onRetry}
        retryLabel={retryLabel}
        busy={busy}
        errorRef={error}
      />
      {children && (
        <div
          ref={body}
          className="step-card-body"
          role="group"
          tabIndex={-1}
          aria-label={position}
          data-point-of-no-return={step?.pointOfNoReturn || undefined}
        >
          {children}
        </div>
      )}
      <footer className="step-card-footer">
        {onCancel && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </Button>
        )}
        <span className="step-card-status">{status}</span>
        {onBack && (
          <Button size="sm" variant="outline" disabled={busy} onClick={onBack}>
            {backLabel}
          </Button>
        )}
        {optional && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onSkip} title={skipDescription}>
            {skipLabel}
          </Button>
        )}
        {onContinue && (
          <Button
            size="sm"
            data-step-continue=""
            disabled={!canContinue}
            onClick={onContinue}
            aria-keyshortcuts={step?.pointOfNoReturn ? undefined : 'Enter'}
          >
            {continueLabel}
            {!busy && !step?.pointOfNoReturn && <ArrowRight size={14} aria-hidden="true" />}
          </Button>
        )}
      </footer>
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
    </section>
  );
}
