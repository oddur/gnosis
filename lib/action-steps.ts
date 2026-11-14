import type { ConflictSession } from './conflict-resolution';
import { mergeMethodLabels, type MergeMethod, type PrMergePlan } from './pr-actions';

/**
 * Step plans for PR actions with several consequential steps. Each plan is derived from the state
 * the existing flow already holds, so a step exists only when the flow really performs it.
 */
export type ActionStepStatus =
  | 'upcoming'
  | 'current'
  | 'running'
  | 'paused'
  | 'done'
  | 'blocked'
  | 'failed'
  | 'skipped';
export interface ActionStep {
  id: string;
  label: string;
  detail?: string;
  status: ActionStepStatus;
  /** Pushes or merges. The card never confirms it with the Enter shortcut alone. */
  pointOfNoReturn?: boolean;
  /** The flow can finish without this step. Only optional steps offer Skip. */
  optional?: boolean;
  error?: string;
}
export interface ActionStepPlan {
  steps: ActionStep[];
  /** Index of the step the user acts on now. */
  current: number;
}
export interface StepFailure {
  step: string;
  message: string;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
/** Name a few items and count the rest, so a long stack keeps the step to one line. */
export function listSummary(items: string[], limit = 3) {
  if (items.length <= limit) return items.join(', ');
  return `${items.slice(0, limit).join(', ')} and ${items.length - limit} more`;
}
const prNumber = (url: string) => `#${url.split('/').pop() ?? ''}`;

/** Order the statuses around one current step; failures and progress stay in that step. */
function sequence(
  steps: Omit<ActionStep, 'status'>[],
  current: number,
  state: { running?: boolean; failure?: StepFailure; blocked?: string; complete?: boolean } = {}
): ActionStepPlan {
  return {
    current,
    steps: steps.map((step, index) => {
      if (state.complete || index < current) return { ...step, status: 'done' };
      if (index > current) return { ...step, status: 'upcoming' };
      if (state.failure?.step === step.id) return { ...step, status: 'failed', error: state.failure.message };
      if (state.blocked) return { ...step, status: 'blocked', error: state.blocked };
      return { ...step, status: state.running ? 'running' : 'current' };
    }),
  };
}

export type StackMergePage = 'review' | 'method' | 'confirm';
/** Merging several PRs at once: review the exact revisions, choose a method, then merge together. */
export function stackMergeSteps(
  plan: PrMergePlan | undefined,
  options: {
    page: StackMergePage;
    method: MergeMethod;
    loading?: boolean;
    running?: boolean;
    failure?: StepFailure;
    count?: number;
  }
): ActionStepPlan {
  const count = plan?.members.length ?? options.count ?? 0;
  const base = plan?.baseBranch;
  const queue = !!plan?.mergeQueue;
  const steps: Omit<ActionStep, 'status'>[] = [
    {
      id: 'review',
      label: plan ? `Review ${plural(count, 'PR')}` : 'Check revisions and permissions',
      detail: plan
        ? `${listSummary(plan.members.map((m) => `#${m.number}`))} → ${base}`
        : options.loading
          ? 'Reading the current revisions from GitHub.'
          : undefined,
    },
  ];
  if (!queue)
    steps.push({
      id: 'method',
      label: 'Choose merge method',
      detail: plan ? mergeMethodLabels[options.method] : undefined,
    });
  steps.push({
    id: 'merge',
    label: plan?.createStack
      ? `Create a GitHub stack and merge into ${base}`
      : queue
        ? `Add to the ${base ?? 'base branch'} merge queue`
        : `Merge into ${base ?? 'the base branch'}`,
    detail: plan?.createStack
      ? 'Two GitHub writes. The stack remains if merging is blocked. All PRs merge together, or none do.'
      : 'All PRs merge together, or none do.',
    pointOfNoReturn: true,
  });
  const ids = steps.map((s) => s.id);
  const target = options.page === 'confirm' || (options.page === 'method' && queue) ? 'merge' : options.page;
  const index = !plan ? 0 : Math.max(0, ids.indexOf(target));
  return sequence(steps, index, {
    running: options.loading || options.running,
    failure: options.failure,
    blocked: plan && index === 0 ? plan.blockedReason : undefined,
  });
}

/**
 * Bringing the base into a conflicted PR, then (optionally) restacking the PRs above it. One plan
 * from start to end: resolving and reviewing files, then one confirmation that shows the final
 * update and pushes it. The plan never gains or loses steps while the user works through it.
 */
export function conflictSteps(
  session: ConflictSession,
  options: { confirming?: boolean; running?: boolean; failure?: StepFailure } = {}
): ActionStepPlan {
  const files = session.files;
  const reviewed = files.filter((f) => f.resolved && !f.unsupported).length;
  const dependents = session.dependents?.length ?? 0;
  const upToDate = session.preparation === 'up-to-date' && !files.length;
  const steps: Omit<ActionStep, 'status'>[] = [
    {
      id: 'resolve',
      label: files.length
        ? `Resolve ${plural(files.length, 'file')}`
        : upToDate
          ? 'Already up to date'
          : 'No conflicts to resolve',
      detail: files.length ? `${reviewed} of ${files.length} reviewed` : undefined,
    },
    {
      id: 'push',
      label: `Confirm and push to ${session.headBranch}`,
      detail: 'Adds a merge commit. The PR stays open.',
      pointOfNoReturn: true,
    },
  ];
  if (dependents)
    steps.push({
      id: 'restack',
      label: `Restack ${plural(dependents, 'dependent PR')}`,
      detail: 'After the push. Rebases the PRs above this one.',
      optional: true,
    });
  if (session.status === 'published')
    return sequence(steps, dependents ? 2 : 1, { complete: !dependents || session.restack?.status === 'published' });
  if (upToDate)
    return {
      current: 0,
      steps: steps.map((step, index) =>
        index === 0 ? { ...step, status: 'done' } : { ...step, status: 'skipped', detail: 'No update is needed.' }
      ),
    };
  const index = options.confirming || !files.length ? 1 : 0;
  return sequence(steps, index, { running: options.running, failure: options.failure });
}

/** Rebase dependents onto the resolved PR, resolve any new conflicts, review, then push them together. */
export function restackSteps(
  session: ConflictSession,
  options: { confirming?: boolean; paused?: boolean; running?: boolean; failure?: StepFailure }
): ActionStepPlan {
  const plan = session.restack;
  const urls = session.dependents ?? [];
  const count = plan?.branches.length && plan.status !== 'blocked' ? plan.branches.length : urls.length;
  const commits = plan?.branches.reduce((total, branch) => total + branch.commits, 0) ?? 0;
  const blocked = plan?.status === 'blocked' ? plan.blocked : undefined;
  const steps: Omit<ActionStep, 'status'>[] = [
    {
      id: 'rebase',
      label: `Rebase ${plural(urls.length, 'dependent PR')} onto ${session.headBranch}`,
      detail:
        plan && plan.status !== 'blocked' && commits
          ? `${listSummary(urls.map(prNumber))} · ${plural(commits, 'commit')} · Nothing pushed`
          : `${listSummary(urls.map(prNumber))} · Nothing pushed`,
      optional: !plan,
    },
  ];
  if (blocked || options.paused)
    steps.push({
      id: 'resolve',
      label: blocked
        ? `Resolve ${plural(blocked.files.length, 'conflict')} in ${prNumber(blocked.url)}`
        : 'Resolve new conflicts',
      detail: blocked ? listSummary(blocked.paths.map((p) => p.split('/').pop() ?? p)) : undefined,
    });
  steps.push({ id: 'review', label: `Review ${plural(count, 'PR update')}`, detail: 'Nothing pushed yet' });
  steps.push({
    id: 'push',
    label: `Push ${plural(count, 'branch', 'branches')} together`,
    detail: 'Rewrites commit IDs with a lease on each branch. Approvals may be dismissed.',
    pointOfNoReturn: true,
  });
  const ids = steps.map((s) => s.id);
  if (plan?.status === 'published') return sequence(steps, ids.length - 1, { complete: true });
  const index = !plan
    ? 0
    : blocked
      ? ids.indexOf('resolve')
      : options.confirming
        ? ids.indexOf('push')
        : ids.indexOf('review');
  const result = sequence(steps, index, { running: options.running, failure: options.failure });
  // A paused rebase is not finished; it continues after the new conflicts are resolved.
  if (blocked) result.steps[0] = { ...result.steps[0], status: 'paused' };
  return result;
}
