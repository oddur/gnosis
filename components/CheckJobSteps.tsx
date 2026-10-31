import { useEffect, useState } from 'react';
import { Circle, CircleAlert, CircleCheck, CircleMinus, LoaderCircle, RefreshCw } from 'lucide-react';
import { checkDuration, checkLabel, type CheckDetails } from '../lib/pr-checks';
import { Button } from './ui/button';

export function CheckJobSteps({
  job,
  onRefresh,
  busy,
}: {
  busy: boolean;
  job: NonNullable<CheckDetails['job']>;
  onRefresh: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  const running = job.status !== 'completed' && job.steps.some((step) => step.status === 'in_progress');
  useEffect(() => {
    if (!running) return;
    const tick = () => {
      if (document.visibilityState !== 'hidden') setNow(Date.now());
    };
    tick();
    const timer = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [running]);
  const finished = job.steps.filter((step) => step.status === 'completed').length;
  return (
    <section className="check-job-steps" aria-label="Job steps">
      <div className="check-steps-heading">
        <h3>
          Job steps{' '}
          {job.steps.length > 0 && (
            <span>
              {finished} of {job.steps.length} complete
            </span>
          )}
        </h3>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={onRefresh}
          aria-label="Refresh job steps"
          title="Refresh job steps"
        >
          <RefreshCw size={14} />
        </Button>
      </div>
      {job.steps.length === 0 && (
        <p className="checks-notice">
          {job.status === 'completed' ? 'No job steps were reported.' : 'Waiting for job steps.'}
        </p>
      )}
      <ol className="check-steps">
        {job.steps.map((step) => {
          const active = step.status === 'in_progress' && job.status !== 'completed';
          const complete = step.status === 'completed';
          const passed = complete && step.conclusion === 'success';
          const skipped = complete && ['skipped', 'neutral'].includes(step.conclusion ?? '');
          const state = active
            ? 'running'
            : !complete
              ? 'pending'
              : passed
                ? 'passed'
                : skipped
                  ? 'skipped'
                  : 'attention';
          const Icon = active
            ? LoaderCircle
            : !complete
              ? Circle
              : passed
                ? CircleCheck
                : skipped
                  ? CircleMinus
                  : CircleAlert;
          const label = active
            ? 'Running'
            : !complete
              ? 'Not started'
              : checkLabel({ name: step.name, status: 'completed', conclusion: step.conclusion, url: null });
          const elapsed = checkDuration(
            { ...step, status: active ? 'in_progress' : complete ? 'completed' : 'pending' },
            now
          );
          return (
            <li key={step.number} data-state={state} aria-current={active ? 'step' : undefined}>
              <Icon size={16} className={active ? 'check-step-spinner' : undefined} aria-hidden="true" />
              <span className="check-step-name">{step.name}</span>
              <span className="check-step-outcome">{label}</span>
              <span
                className="check-step-duration"
                title={
                  step.startedAt
                    ? `Started ${new Date(step.startedAt).toLocaleString()}${step.completedAt ? ` · Finished ${new Date(step.completedAt).toLocaleString()}` : ''}`
                    : 'No timing reported'
                }
              >
                {elapsed ? `${elapsed}${active ? ' elapsed' : ''}` : '—'}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
