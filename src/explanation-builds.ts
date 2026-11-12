import type { ActivityService } from './activity-service';
import type { ReviewGuide, Slide } from '../lib/types';
import {
  explanationSteps,
  initialExplanationProgress,
  reduceExplanationProgress,
  type ExplanationEvent,
  type ExplanationProgress,
} from '../lib/explanation-progress';

type DraftBase = Omit<ReviewGuide, 'slides' | 'draft'>;
interface Build {
  progress: ExplanationProgress;
  base?: DraftBase;
  topics: { id: string; title: string }[];
  slides: Map<string, Slide>;
}

/**
 * Tracks each running explanation: its structured progress, mirrored into the activity task as
 * steps, and the topics finished so far, so they can be read before the rest are written.
 * Everything lives in the main process for the life of the generation, so a reopened tab or
 * window reads the same rows. Generations do not survive a restart, so neither does this.
 */
export function createExplanationBuilds(activities: Pick<ActivityService, 'steps'>) {
  const builds = new Map<string, Build>();
  const build = (reviewId: string) => {
    let entry = builds.get(reviewId);
    if (!entry) builds.set(reviewId, (entry = { progress: initialExplanationProgress(), topics: [], slides: new Map() }));
    return entry;
  };
  return {
    event(reviewId: string, event: ExplanationEvent) {
      const entry = build(reviewId);
      const next = reduceExplanationProgress(entry.progress, event);
      if (next === entry.progress) return;
      entry.progress = next;
      if (event.type === 'plan') entry.topics = event.topics;
      activities.steps(`review:${reviewId}`, explanationSteps(next));
    },
    /** Saved once the plan exists; the overview text is the planner's draft until the end. */
    draftBase(reviewId: string, base: DraftBase) {
      build(reviewId).base = base;
    },
    /** A finished topic, copied so later pipeline stages cannot change what a reader sees. */
    topicWritten(reviewId: string, slide: Slide) {
      build(reviewId).slides.set(slide.id, structuredClone(slide));
    },
    /** Finished topics in plan order, with placeholders for the rest. */
    draft(reviewId: string): ReviewGuide | undefined {
      const entry = builds.get(reviewId);
      if (!entry?.base || !entry.topics.length || entry.progress.finished) return undefined;
      const status = new Map(entry.progress.topics.map((topic) => [topic.id, topic]));
      const slides = entry.topics.map((topic, index): Slide => {
        const written = entry.slides.get(topic.id);
        if (written) return structuredClone(written);
        const progress = status.get(topic.id);
        return {
          id: topic.id,
          slideNumber: index + 1,
          title: topic.title,
          slideType: 'feature',
          narrative: '',
          reviewFocus: null,
          diffHunks: [],
          contextSnippets: [],
          affectedFiles: [],
          dependsOn: [],
          draftStatus: progress?.status === 'failed' ? 'failed' : progress?.status === 'running' ? 'writing' : 'queued',
          ...(progress?.error ? { draftError: progress.error } : {}),
        };
      });
      return {
        ...structuredClone(entry.base),
        reviewId,
        slides,
        draft: { completed: entry.slides.size, total: entry.topics.length },
      };
    },
    clear(reviewId: string) {
      builds.delete(reviewId);
    },
  };
}
export type ExplanationBuilds = ReturnType<typeof createExplanationBuilds>;
