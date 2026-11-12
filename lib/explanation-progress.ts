import type { ActivityStep, ActivityStepStatus } from './activity';

/**
 * Explanation generation reports phases as text (`reportReviewPhase`) plus a few structured
 * events: the plan's topic list, each topic's status, the context size, and the outcome. This
 * reduces them into the stages a person sees as Task Rows. It is pure, so the main process,
 * the renderer fallback and the tests share it.
 */
export type ExplanationStage = 'context' | 'plan' | 'topics' | 'generate' | 'check' | 'overview' | 'render';
export type TopicStatus = 'queued' | 'writing' | 'done' | 'failed';
export type ExplanationEvent =
  | { type: 'phase'; phase: string; completed?: number; total?: number }
  | { type: 'context'; files: number; imports: number }
  | { type: 'plan'; topics: { id: string; title: string }[] }
  | { type: 'topic'; id: string; status: TopicStatus; title?: string; error?: string }
  | { type: 'finish'; status: 'completed' | 'failed' | 'cancelled'; error?: string };

export interface TopicProgress {
  id: string;
  title: string;
  status: ActivityStepStatus;
  error?: string;
}
export interface ExplanationProgress {
  mode?: 'planned' | 'single';
  stage?: ExplanationStage;
  done: ExplanationStage[];
  failed?: { stage: ExplanationStage; error: string };
  cancelled?: boolean;
  finished?: boolean;
  files?: number;
  imports?: number;
  /** Live detail for the running context stage, such as file loading or a rate-limit wait. */
  note?: string;
  topics: TopicProgress[];
  /** Topic counts reported without a plan event (single-line progress only). */
  counted?: { completed: number; total: number };
}

const PLANNED: ExplanationStage[] = ['context', 'plan', 'topics', 'check', 'overview', 'render'];
const SINGLE: ExplanationStage[] = ['context', 'generate', 'check', 'overview', 'render'];
export const initialExplanationProgress = (): ExplanationProgress => ({ done: [], topics: [] });

export function phaseStage(phase: string): ExplanationStage | undefined {
  if (/^(Fetching PR data|Loading files|Waiting for GitHub|Resolving imports|Building context|Preparing review)/.test(phase))
    return 'context';
  if (phase === 'Planning review structure') return 'plan';
  if (phase === 'Writing topics' || phase === 'Writing sections') return 'topics';
  if (phase === 'Generating review' || phase === 'Thinking') return 'generate';
  if (phase === 'Checking explanation text') return 'check';
  if (phase === 'Writing overview') return 'overview';
  if (phase === 'Rendering') return 'render';
  return undefined;
}

const topicStatus: Record<TopicStatus, ActivityStepStatus> = {
  queued: 'queued',
  writing: 'running',
  done: 'done',
  failed: 'failed',
};

export function reduceExplanationProgress(state: ExplanationProgress, event: ExplanationEvent): ExplanationProgress {
  if (state.finished) return state;
  switch (event.type) {
    case 'phase': {
      const stage = phaseStage(event.phase);
      // Runtime notes, such as tool mode or a dirty working tree, keep the current stage.
      if (!stage) return state;
      const mode = stage === 'generate' ? 'single' : stage === 'plan' || stage === 'topics' ? 'planned' : state.mode;
      const order = mode === 'single' ? SINGLE : PLANNED;
      const before = order.slice(0, Math.max(0, order.indexOf(stage)));
      const done = [...new Set([...state.done, ...before])];
      const loading = /^(Loading files|Waiting for GitHub)/.test(event.phase);
      const files = loading && event.total !== undefined ? event.total : state.files;
      const counted =
        stage === 'topics' && event.total !== undefined
          ? { completed: event.completed ?? 0, total: event.total }
          : state.counted;
      return {
        ...state,
        mode,
        stage,
        done,
        files,
        counted,
        note:
          stage !== 'context'
            ? undefined
            : event.phase.startsWith('Waiting for GitHub')
              ? event.phase
              : loading && event.total
                ? `${event.completed ?? 0} of ${event.total} files`
                : undefined,
      };
    }
    case 'context':
      return { ...state, files: event.files, imports: event.imports };
    case 'plan':
      return {
        ...state,
        mode: 'planned',
        done: [...new Set([...state.done, 'context' as const, 'plan' as const])],
        topics: event.topics.map((topic) => ({ id: topic.id, title: topic.title, status: 'queued' })),
      };
    case 'topic': {
      const status = topicStatus[event.status];
      const exists = state.topics.some((topic) => topic.id === event.id);
      const next: TopicProgress = {
        id: event.id,
        title: event.title ?? state.topics.find((topic) => topic.id === event.id)?.title ?? event.id,
        status,
        ...(status === 'failed' ? { error: event.error || 'The topic could not be written.' } : {}),
      };
      return {
        ...state,
        topics: exists ? state.topics.map((topic) => (topic.id === event.id ? next : topic)) : [...state.topics, next],
      };
    }
    case 'finish': {
      if (event.status === 'completed') {
        const order = state.mode === 'single' ? SINGLE : PLANNED;
        return { ...state, finished: true, done: order, stage: undefined, note: undefined };
      }
      const stage = state.stage ?? 'context';
      const topics = state.topics.map((topic) =>
        topic.status === 'running' || topic.status === 'queued'
          ? { ...topic, status: (event.status === 'cancelled' ? 'cancelled' : 'queued') as ActivityStepStatus }
          : topic
      );
      return event.status === 'cancelled'
        ? { ...state, finished: true, cancelled: true, topics, note: undefined }
        : {
            ...state,
            finished: true,
            topics,
            note: undefined,
            failed: { stage, error: event.error?.trim() || 'Generation stopped without an error message.' },
          };
    }
  }
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The rows for an explanation build, in pipeline order. */
export function explanationSteps(state: ExplanationProgress): ActivityStep[] {
  const order = state.mode === 'single' ? SINGLE : PLANNED;
  const status = (stage: ExplanationStage): ActivityStepStatus =>
    state.failed?.stage === stage
      ? 'failed'
      : state.done.includes(stage)
        ? 'done'
        : state.stage === stage
          ? state.cancelled
            ? 'cancelled'
            : state.finished
              ? 'queued'
              : 'running'
          : 'queued';
  const topicsDone = state.topics.filter((topic) => topic.status === 'done').length;
  const topicsFailed = state.topics.filter((topic) => topic.status === 'failed').length;
  return order.map((stage) => {
    const s = status(stage);
    const error = state.failed?.stage === stage ? state.failed.error : undefined;
    const step = (title: string, meta?: string, subtasks?: ActivityStep[]): ActivityStep => ({
      id: stage,
      title,
      status: s,
      ...(meta ? { meta } : {}),
      ...(error ? { error } : {}),
      ...(subtasks ? { subtasks } : {}),
    });
    switch (stage) {
      case 'context':
        return step(
          'Read PR and context',
          s === 'running' && state.note
            ? state.note
            : [state.files !== undefined && plural(state.files, 'file'), state.imports !== undefined && plural(state.imports, 'import')]
                .filter(Boolean)
                .join(' · ')
        );
      case 'plan':
        return step(state.topics.length && s === 'done' ? `Planned ${plural(state.topics.length, 'topic')}` : 'Plan topics');
      case 'topics': {
        const total = state.topics.length || state.counted?.total || 0;
        const completed = state.topics.length ? topicsDone : (state.counted?.completed ?? 0);
        const meta = total
          ? [`${completed} of ${total}`, topicsFailed && `${topicsFailed} failed`].filter(Boolean).join(' · ')
          : undefined;
        return step(
          'Write topics',
          meta,
          state.topics.length
            ? state.topics.map((topic) => ({
                id: topic.id,
                title: topic.title,
                status: topic.status,
                slideId: topic.id,
                ...(topic.status === 'running' ? { meta: 'writing' } : {}),
                ...(topic.error ? { error: topic.error } : {}),
              }))
            : undefined
        );
      }
      case 'generate':
        return step('Write explanation');
      case 'check':
        return step('Check explanation text');
      case 'overview':
        return step('Write overview');
      case 'render':
        return step('Render code');
    }
  });
}

/** Rows for a task from before structured steps, or from a reader that only has one line. */
export function explanationStepsFromDetail(detail: string, progress?: { completed: number; total: number }) {
  return explanationSteps(
    reduceExplanationProgress(initialExplanationProgress(), {
      type: 'phase',
      phase: detail,
      completed: progress?.completed,
      total: progress?.total,
    })
  );
}

/** Elapsed time as "42s" or "1m 42s". */
export function formatElapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
