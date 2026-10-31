import { normalizeRepositorySettings, normalizeBriefingLimit, type RepositorySettingsMap } from './repository-settings';
import { normalizeEffort, type Effort } from './effort';
import type { Preferences } from './types';
import { DEFAULT_QUEUE_FILTERS, normalizeQueueFilters, type QueueFilters } from './queue-filters';
import type { QueueViewsState } from './saved-views';
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_FAST_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_BRIEFING_CODEX_MODEL,
  normalizeModelSelection,
  type Provider,
  type ModelId,
} from './models';

export const SETUP_GOALS = [
  {
    id: 'review',
    label: 'Review PRs assigned to me',
    description: 'Review requests and PRs where you are an assignee.',
    view: 'Needs my review',
  },
  {
    id: 'repositories',
    label: 'Follow repository work',
    description: 'Open PRs across repositories you choose.',
    view: 'Repository activity',
  },
  { id: 'authored', label: 'Track my own PRs', description: 'The PRs you authored, in one view.', view: 'My PRs' },
] as const;
export type SetupGoal = (typeof SETUP_GOALS)[number]['id'];
export const SETUP_STEPS = ['goals', 'github', 'repositories', 'filters', 'ai', 'finish'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export interface SetupDraft {
  step: SetupStep;
  local: boolean;
  goals: SetupGoal[];
  repositories: string[];
  repositorySettings?: RepositorySettingsMap;
  repositoryDailyLimit?: number;
  days: number;
  ignoreDependabot: boolean;
  autoBriefings: boolean;
  configureAI: boolean;
  dailyLimit: number;
  provider: Provider;
  model: ModelId;
  effort?: Effort;
  briefingProvider: Provider;
  briefingModel: ModelId;
  briefingEffort?: Effort;
  names: Record<SetupGoal, string>;
  start: SetupGoal;
  refinements: Partial<QueueFilters>;
}
export interface OnboardingState {
  draft?: SetupDraft;
  paused?: boolean;
  completed?: boolean;
  tourStep?: number;
  tourCompleted?: boolean;
}
export interface SetupView {
  id: string;
  name: string;
  filters: QueueFilters;
}

export function recommendedSetupModel(provider: Provider, role: 'explanation' | 'briefing'): ModelId {
  if (role === 'briefing') return provider === 'codex' ? DEFAULT_BRIEFING_CODEX_MODEL : DEFAULT_FAST_CLAUDE_MODEL;
  return provider === 'codex' ? DEFAULT_CODEX_MODEL : DEFAULT_CLAUDE_MODEL;
}

/** Offer only installed tools, preserving an available saved choice for each job. */
export function setupForInstalledProviders(draft: SetupDraft, providers: Provider[]): SetupDraft {
  if (!providers.length) return draft;
  const provider = providers.includes(draft.provider) ? draft.provider : providers[0];
  const briefingProvider = providers.includes(draft.briefingProvider) ? draft.briefingProvider : provider;
  return {
    ...draft,
    configureAI: true,
    provider,
    model: provider === draft.provider ? draft.model : recommendedSetupModel(provider, 'explanation'),
    effort: normalizeEffort(
      provider,
      provider === draft.provider ? draft.model : recommendedSetupModel(provider, 'explanation'),
      draft.effort
    ),
    briefingEffort: normalizeEffort(
      briefingProvider,
      briefingProvider === draft.briefingProvider
        ? draft.briefingModel
        : recommendedSetupModel(briefingProvider, 'briefing'),
      draft.briefingEffort,
      false
    ),
    briefingProvider,
    briefingModel:
      briefingProvider === draft.briefingProvider
        ? draft.briefingModel
        : recommendedSetupModel(briefingProvider, 'briefing'),
  };
}

export function initialSetup(prefs: Preferences, views?: QueueViewsState): SetupDraft {
  const name = (goal: SetupGoal, fallback: string) => {
    const own = views?.views.find((view) => view.id === `setup:${goal}`);
    if (own) return own.name;
    let value = fallback,
      suffix = 2;
    while (views?.views.some((view) => view.name.toLowerCase() === value.toLowerCase()))
      value = `${fallback} ${suffix++}`;
    return value;
  };
  return {
    step: 'goals',
    local: prefs.guestMode,
    goals: ['review'],
    repositories: [...prefs.watchedRepos],
    repositorySettings: normalizeRepositorySettings(prefs.repositorySettings),
    repositoryDailyLimit: normalizeBriefingLimit(prefs.repositoryBriefingDailyLimit),
    days: prefs.prInactivityDays ?? 30,
    ignoreDependabot: prefs.ignoreDependabotPrs !== false,
    configureAI: false,
    autoBriefings: prefs.autoBriefings === true,
    dailyLimit: prefs.briefingDailyLimit ?? 10,
    effort: normalizeEffort(prefs.provider, prefs.model, prefs.effort, prefs.thinking),
    briefingEffort: normalizeEffort(
      prefs.proactiveReviewOverrides ? prefs.proactiveProvider : prefs.provider,
      prefs.proactiveReviewOverrides ? prefs.proactiveModel : prefs.model,
      prefs.proactiveEffort,
      prefs.proactiveReviewOverrides ? prefs.proactiveThinking : false
    ),
    provider: prefs.provider,
    model: prefs.firstRunSeen ? prefs.model : recommendedSetupModel(prefs.provider, 'explanation'),
    briefingProvider: prefs.proactiveReviewOverrides ? prefs.proactiveProvider : prefs.provider,
    briefingModel: prefs.proactiveReviewOverrides
      ? prefs.proactiveModel
      : prefs.firstRunSeen
        ? prefs.model
        : recommendedSetupModel(prefs.provider, 'briefing'),
    names: {
      review: name('review', 'Needs my review'),
      repositories: name('repositories', 'Repository activity'),
      authored: name('authored', 'My PRs'),
    },
    start: 'review',
    refinements: {},
  };
}
export function normalizeSetup(input: unknown): SetupDraft {
  const value = input as Partial<SetupDraft> | null;
  if (!value || typeof value !== 'object') throw new Error('Setup could not be read. Run setup again.');
  const goals = SETUP_GOALS.filter((goal) => value.goals?.includes(goal.id)).map((goal) => goal.id);
  const repositories = [
    ...new Set(
      (Array.isArray(value.repositories) ? value.repositories : [])
        .filter((repo): repo is string => typeof repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
        .map((repo) => repo.toLowerCase())
    ),
  ].slice(0, 100);
  const selection = normalizeModelSelection(value.provider, value.model);
  const briefing = normalizeModelSelection(
    value.briefingProvider ?? selection.provider,
    value.briefingModel ??
      (value.configureAI ? selection.model : recommendedSetupModel(selection.provider, 'briefing')),
    true
  );
  const names = Object.fromEntries(
    SETUP_GOALS.map((goal) => [
      goal.id,
      typeof value.names?.[goal.id] === 'string' ? value.names[goal.id].trim().slice(0, 60) : goal.view,
    ])
  ) as SetupDraft['names'];
  return {
    step: value.step && SETUP_STEPS.includes(value.step) ? value.step : 'goals',
    local: value.local === true,
    goals,
    repositories,
    repositorySettings: value.repositorySettings === undefined ? undefined : normalizeRepositorySettings(value.repositorySettings),
    repositoryDailyLimit: normalizeBriefingLimit(value.repositoryDailyLimit),
    days: typeof value.days === 'number' && [0, 7, 14, 30, 90, 180, 365].includes(value.days) ? value.days : 30,
    ignoreDependabot: value.ignoreDependabot !== false,
    configureAI: value.configureAI === true,
    autoBriefings: value.autoBriefings === true,
    dailyLimit:
      typeof value.dailyLimit === 'number' && Number.isFinite(value.dailyLimit)
        ? Math.min(100, Math.max(1, Math.round(value.dailyLimit)))
        : 10,
    ...selection,
    effort: normalizeEffort(selection.provider, selection.model, value.effort),
    briefingEffort: normalizeEffort(briefing.provider, briefing.model, value.briefingEffort, false),
    briefingProvider: briefing.provider,
    briefingModel: briefing.model,
    names,
    start: value.start && goals.includes(value.start) ? value.start : (goals[0] ?? 'review'),
    refinements: normalizeQueueFilters(value.refinements),
  };
}
export function setupViews(input: SetupDraft): SetupView[] {
  const draft = normalizeSetup(input);
  if (draft.local) return [];
  if (!draft.goals.length) throw new Error('Choose at least one goal.');
  if (draft.goals.includes('repositories') && !draft.repositories.length)
    throw new Error('Choose a repository to follow, or remove the repository goal.');
  return draft.goals.map((goal) => ({
    id: `setup:${goal}`,
    name: draft.names[goal],
    filters: normalizeQueueFilters({
      ...DEFAULT_QUEUE_FILTERS,
      ...draft.refinements,
      updatedWithin: draft.days,
      involvement: goal === 'repositories' ? 'all' : goal,
      repo: 'all',
      repos: goal === 'repositories' ? draft.repositories : undefined,
      briefingScope: 'matches',
    }),
  }));
}
export function setupPreferences(prefs: Preferences, input: SetupDraft): Preferences {
  const draft = normalizeSetup(input);
  return {
    ...prefs,
    watchedRepos: draft.local ? prefs.watchedRepos : draft.repositories,
    repositorySettings: draft.local ? prefs.repositorySettings : draft.repositorySettings ?? prefs.repositorySettings,
    repositoryBriefingDailyLimit: draft.local ? prefs.repositoryBriefingDailyLimit : draft.repositoryDailyLimit,
    prInactivityDays: draft.days,
    ignoreDependabotPrs: draft.ignoreDependabot,
    autoBriefings: !draft.local && draft.autoBriefings,
    briefingDailyLimit: draft.dailyLimit,
    ...(draft.configureAI
      ? {
          provider: draft.provider,
          model: draft.model,
          effort: draft.effort,
          proactiveReviewOverrides: true,
          proactiveProvider: draft.briefingProvider,
          proactiveModel: draft.briefingModel,
          proactiveEffort: draft.briefingEffort,
        }
      : {}),
    firstRunSeen: true,
    guestMode: draft.local,
  };
}
