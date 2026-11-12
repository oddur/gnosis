import { Circle, CircleAlert, CircleCheck, CircleMinus, LoaderCircle, RefreshCw } from 'lucide-react';
import { checkDuration, checkLabel, type CheckDetails } from '../lib/pr-checks';
import { Button } from './ui/button';
import { countRender } from '../lib/render-count';
import { useElapsedNow } from '../lib/status-clock';

type Step = NonNullable<CheckDetails['job']>['steps'][number];

/** A step's elapsed time. While the step runs, only this label re-renders each second, not the step list. */
function StepDuration({ step, active, complete }: { step: Step; active: boolean; complete: boolean }) {
  countRender('CheckStepDuration');
  const now = useElapsedNow(active);
  const elapsed = checkDuration({ ...step, status: active ? 'in_progress' : complete ? 'completed' : 'pending' }, now);
  return (
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
  );
}

export function CheckJobSteps({
  job,
  onRefresh,
  busy,
}: {
  busy: boolean;
  job: NonNullable<CheckDetails['job']>;
  onRefresh: () => void;
}) {
  countRender('CheckJobSteps');
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
          return (
            <li key={step.number} data-state={state} aria-current={active ? 'step' : undefined}>
              <Icon size={16} className={active ? 'check-step-spinner' : undefined} aria-hidden="true" />
              <span className="check-step-name">{step.name}</span>
              <span className="check-step-outcome">{label}</span>
              <StepDuration step={step} active={active} complete={complete} />
            </li>
          );
        })}
      </ol>
    </section>
  );
}
