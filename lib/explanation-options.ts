import { effectiveFileKinds, fileExtension, pathFileKinds, type FileKinds, type FileKindOverride } from './file-kinds';
import type { ChangedFile } from './types';
import { PROVIDER_IDS, PROVIDERS, type ModelId, type Provider } from './models';
import { EFFORT_LEVELS, normalizeEffort, type Effort } from './effort';

export const EXPLANATION_STYLES = [
  { value: 'concise', label: 'Concise', description: 'Main changes, their purpose, and essential code.' },
  { value: 'in-depth', label: 'In Depth', description: 'Also cover interactions, edge cases, and tradeoffs.' },
  { value: 'educational', label: 'Educational', description: 'Explain the concepts and reasoning behind the change.' },
  { value: 'custom', label: 'Custom', description: 'Guide the explanation with your own instructions.' },
] as const;
export type ExplanationStyle = (typeof EXPLANATION_STYLES)[number]['value'];
/** Reduce noise: which hunks the explanation leaves out because a reviewer doesn't need them explained. */
export const NOISE_LEVELS = [
  { value: 'off', label: 'Off', description: 'Explain every hunk.' },
  {
    value: 'conservative',
    label: 'Conservative',
    description: 'Leave out imports, formatting, comments and other clear noise.',
  },
  {
    value: 'aggressive',
    label: 'Aggressive',
    description: 'Also leave out small related edits that aren’t part of the main change.',
  },
] as const;
export type NoiseLevel = (typeof NOISE_LEVELS)[number]['value'];
export const DEFAULT_NOISE_LEVEL: NoiseLevel = 'conservative';
export interface ExplanationPreferences {
  style: ExplanationStyle;
  customInstructions: string;
  excludeGenerated: boolean;
  excludeTests: boolean;
  hiddenExtensions: string[];
  /** Reduce noise (lib/explanation-noise.ts). Part of the options, so a change makes a new explanation. */
  reduceNoise: NoiseLevel;
  /**
   * Focused sections (#562): sections show only the slices of large hunks they explain. A per-repository setting, off
   * by default; generation reads the repository's value, and a later change makes the explanation out of date.
   */
  focusedSections: boolean;
  /**
   * The explanation's provider, model and reasoning effort, from any provider's models. Unset follows the review model
   * in Settings. Generation fills them in, so Regenerate keeps the model the explanation was written with.
   */
  provider?: Provider;
  model?: ModelId;
  effort?: Effort;
}
export interface ExplanationOptions extends ExplanationPreferences {
  /** Source paths (namespaced by PR in a stack). Explicit choices override filter rules. */
  fileOverrides: Partial<Record<string, boolean>>;
}
export interface ExplanationFile {
  path: string;
  displayPath: string;
  group: string;
  kinds: FileKinds;
  additions: number;
  deletions: number;
}
export interface ExplanationSetup {
  title: string;
  repository: string;
  files: ExplanationFile[];
  options: ExplanationOptions;
  restored: boolean;
  /** Set when the setup came from saved data. A later `ExplanationSetupUpdate` with this ID replaces it. */
  updateId?: string;
}
/** GitHub's answer for a setup that came from saved data: a newer setup, or why the scope can't be explained. */
export interface ExplanationSetupUpdate {
  updateId: string;
  setup?: ExplanationSetup;
  error?: string;
}
export const DEFAULT_EXPLANATION_PREFERENCES: ExplanationPreferences = {
  style: 'concise',
  customInstructions: '',
  excludeGenerated: true,
  excludeTests: false,
  hiddenExtensions: [],
  reduceNoise: DEFAULT_NOISE_LEVEL,
  focusedSections: false,
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function normalizeExplanationPreferences(value: unknown): ExplanationPreferences {
  const v = object(value) ? value : {};
  return {
    style: EXPLANATION_STYLES.some((s) => s.value === v.style) ? (v.style as ExplanationStyle) : 'concise',
    customInstructions: typeof v.customInstructions === 'string' ? v.customInstructions.slice(0, 20_000) : '',
    excludeGenerated: typeof v.excludeGenerated === 'boolean' ? v.excludeGenerated : true,
    excludeTests: v.excludeTests === true,
    hiddenExtensions: [
      ...new Set(
        (Array.isArray(v.hiddenExtensions) ? v.hiddenExtensions : [])
          .filter((e): e is string => typeof e === 'string' && e.length <= 256 && (e === '' || /^\.[^/\\.]+$/.test(e)))
          .map((e) => e.toLowerCase())
      ),
    ].slice(0, 1000),
    reduceNoise: normalizeNoiseLevel(v.reduceNoise),
    focusedSections: v.focusedSections === true,
    ...modelChoice(v.provider, v.model),
    ...(EFFORT_LEVELS.includes(v.effort as Effort) ? { effort: v.effort as Effort } : {}),
  };
}
/** The provider that offers a model; none for an unknown model. */
const modelProvider = (model: unknown): Provider | undefined =>
  PROVIDER_IDS.find((provider) => PROVIDERS[provider].models.some((m) => m.id === model));
/**
 * A known model with its provider. Without a provider, the model's own. An unknown provider, an unknown model, or a
 * model the provider doesn't offer is dropped, so the explanation follows the review model in Settings.
 */
function modelChoice(provider: unknown, model: unknown): { provider?: Provider; model?: ModelId } {
  const owner = modelProvider(model);
  return owner && (provider === undefined || provider === owner) ? { provider: owner, model: model as ModelId } : {};
}
/** The model an explanation was written with, for its metadata line; none for one saved before the choice (#573). */
export function explanationModelLabel(options: Pick<ExplanationPreferences, 'model'> | undefined): string | undefined {
  return Object.values(PROVIDERS)
    .flatMap((provider) => provider.models as readonly { id: string; label: string }[])
    .find((model) => model.id === options?.model)?.label;
}
/** Settings' review model: the fallback for an explanation without its own choice. */
export interface ReviewModel {
  provider: Provider;
  model: ModelId;
  effort?: Effort;
  thinking?: boolean;
}
/**
 * The provider, model and effort an explanation is written with: its own choice when the model is known and belongs to
 * the provider, else the review provider and model in Settings (fail closed: an unknown model, or one from another
 * provider, never reaches a CLI). The effort is normalized for the model.
 */
export function explanationModel(
  options: Pick<ExplanationPreferences, 'provider' | 'model' | 'effort'>,
  review: ReviewModel
): { provider: Provider; model: ModelId; effort: Effort } {
  const own = modelChoice(options.provider, options.model);
  const provider = own.provider ?? review.provider,
    model = own.model ?? review.model;
  return { provider, model, effort: normalizeEffort(provider, model, options.effort ?? review.effort, review.thinking ?? true) };
}
export function normalizeNoiseLevel(value: unknown): NoiseLevel {
  return NOISE_LEVELS.some((level) => level.value === value) ? (value as NoiseLevel) : DEFAULT_NOISE_LEVEL;
}
export function normalizeExplanationOptions(value: unknown): ExplanationOptions {
  const v = object(value) ? value : {};
  return {
    ...normalizeExplanationPreferences(v),
    fileOverrides: Object.fromEntries(
      Object.entries(object(v.fileOverrides) ? v.fileOverrides : {}).filter(
        ([p, included]) => p.length > 0 && p.length <= 4096 && typeof included === 'boolean'
      )
    ) as Record<string, boolean>,
  };
}
export function explanationExclusion(file: ExplanationFile, options: ExplanationOptions): string | undefined {
  const explicit = Object.hasOwn(options.fileOverrides, file.path) ? options.fileOverrides[file.path] : undefined;
  if (explicit !== undefined) return explicit ? undefined : 'Excluded by you';
  if (options.hiddenExtensions.includes(fileExtension(file.displayPath)))
    return `Hidden extension: ${fileExtension(file.displayPath) || 'no extension'}`;
  if (options.excludeGenerated && file.kinds.generated.value) return file.kinds.generated.reason;
  if (options.excludeTests && file.kinds.test.value) return file.kinds.test.reason;
  return undefined;
}
export function explanationFile(
  file: ChangedFile,
  displayPath: string,
  group: string,
  known?: FileKinds,
  override?: FileKindOverride
): ExplanationFile {
  return {
    path: file.filename,
    displayPath,
    group,
    additions: file.additions,
    deletions: file.deletions,
    kinds: effectiveFileKinds(known ?? pathFileKinds(displayPath), override),
  };
}
const styleInstructions: Record<ExplanationStyle, string> = {
  concise:
    'Focus on the main behavioral changes, why they matter, and the essential code. Keep only the topics needed to understand this change. Omit background lessons and incidental implementation detail.',
  'in-depth':
    'Explain the change thoroughly, including meaningful interactions, boundary conditions, failure paths, and tradeoffs. Use distinct topics for distinct mechanisms. Add detail only where it improves understanding; do not repeat the same facts across topics.',
  educational:
    'Help an engineer who is unfamiliar with this area understand how the change works. Explain necessary concepts and the reasoning behind the implementation, using relevant examples when useful. Keep background material tied to the actual code; avoid a generic tutorial.',
  custom: 'Adapt topic selection and depth to the custom instructions below.',
};
export function explanationInstructions(options: ExplanationPreferences, globalInstructions = ''): string {
  return [
    `Explanation style: ${EXPLANATION_STYLES.find((s) => s.value === options.style)?.label ?? 'Concise'}. ${styleInstructions[options.style]}`,
    'For every style: use clear, concise prose and structured Markdown. Prefer useful bullets over long paragraphs. Explain the change at the right level; avoid filler. Use diagrams only when they clarify a mechanism or relationship.',
    options.style === 'custom' ? `Custom explanation instructions:\n${options.customInstructions.trim()}` : '',
    globalInstructions.trim() ? `User and repository conventions (also apply):\n${globalInstructions.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Local defaults are scoped to the repository directory, independent of branch. */
export function normalizeLocalExplanationPreferences(value: unknown): Record<string, ExplanationPreferences> {
  return Object.fromEntries(
    Object.entries(object(value) ? value : {})
      .filter(([key, entry]) => key.startsWith('local:/') && object(entry))
      .map(([key, entry]) => [key, normalizeExplanationPreferences(entry)])
  );
}
