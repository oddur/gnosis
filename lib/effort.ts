import type { ModelId, Provider } from './models';
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];
export const effortLabels: Record<Effort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};
// Claude CLI --effort and Codex's advertised reasoning levels (October 2026).
export function effortLevels(provider: Provider, model: ModelId): readonly Effort[] {
  return provider === 'claude' || model === 'gpt-6-luna' ? EFFORT_LEVELS.slice(0, 5) : EFFORT_LEVELS;
}
export function normalizeEffort(provider: Provider, model: ModelId, value: unknown, thinking = true): Effort {
  if (typeof value !== 'string' || !EFFORT_LEVELS.includes(value as Effort)) return thinking ? 'high' : 'low';
  const levels = effortLevels(provider, model);
  return levels.includes(value as Effort) ? (value as Effort) : levels[levels.length - 1];
}
