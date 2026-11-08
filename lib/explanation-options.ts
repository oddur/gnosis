import { effectiveFileKinds, fileExtension, pathFileKinds, type FileKinds, type FileKindOverride } from './file-kinds';
import type { ChangedFile } from './types';

export const EXPLANATION_STYLES = [
  { value: 'concise', label: 'Concise', description: 'Main changes, their purpose, and essential code.' },
  { value: 'in-depth', label: 'In Depth', description: 'Also cover interactions, edge cases, and tradeoffs.' },
  { value: 'educational', label: 'Educational', description: 'Explain the concepts and reasoning behind the change.' },
  { value: 'custom', label: 'Custom', description: 'Guide the explanation with your own instructions.' },
] as const;
export type ExplanationStyle = (typeof EXPLANATION_STYLES)[number]['value'];
export interface ExplanationPreferences {
  style: ExplanationStyle;
  customInstructions: string;
  excludeGenerated: boolean;
  excludeTests: boolean;
  hiddenExtensions: string[];
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
}
export const DEFAULT_EXPLANATION_PREFERENCES: ExplanationPreferences = {
  style: 'concise',
  customInstructions: '',
  excludeGenerated: true,
  excludeTests: false,
  hiddenExtensions: [],
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
  };
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
