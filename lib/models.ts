// Single source of truth for the Claude and Codex model rosters. The picker UIs
// (HomePage, SettingsDialog), the provider (`--model` passed to the
// CLI), the model unions, and the stored-preference migration
// all derive from the tables here — a roster change is one edit in
// this file. No React imports: this module is shared by the renderer
// and the Electron main process.

export const CLAUDE_MODELS = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1', quick: false },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', quick: false },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', quick: false },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', quick: true },
] as const;

export type ClaudeModel = (typeof CLAUDE_MODELS)[number]['id'];

/** Default for manual reviews and the general model preference. */
export const DEFAULT_CLAUDE_MODEL: ClaudeModel = 'claude-opus-5-5';
/** Default for background/proactive reviews and slide chat — fast and cheap. */
export const DEFAULT_FAST_CLAUDE_MODEL: ClaudeModel = 'claude-sonnet-5-5';

export function isClaudeModel(id: string): id is ClaudeModel {
  return CLAUDE_MODELS.some((m) => m.id === id);
}

/**
 * Models we used to offer. One entry per retirement: `label` keeps old
 * review-history rows readable, `successor` drives the stored-preference
 * migration in loadPreferences. Stored ids that appear in neither table
 * fall back to the defaults there, so a missed entry degrades to the
 * default model instead of passing a retired id to the CLI.
 */
export const RETIRED_CLAUDE_MODELS: Record<string, { label: string; successor: ClaudeModel }> = {
  'claude-fable-5': { label: 'Claude Fable 5', successor: 'claude-fable-5-1' },
  'claude-opus-5': { label: 'Claude Opus 5', successor: 'claude-opus-5-5' },
  'claude-sonnet-5': { label: 'Claude Sonnet 5', successor: 'claude-sonnet-5-5' },
  'claude-haiku-4-5-20251001': { label: 'Claude Haiku 4.5', successor: 'claude-haiku-5-5' },
  'claude-opus-4-6': { label: 'Claude Opus 4.6', successor: 'claude-opus-5-5' },
  'claude-opus-4-7': { label: 'Claude Opus 4.7', successor: 'claude-opus-5-5' },
  'claude-sonnet-4-6': { label: 'Claude Sonnet 4.6', successor: 'claude-sonnet-5-5' },
};

export const CODEX_MODELS = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', quick: false },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', quick: false },
  { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', quick: false },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', quick: true },
] as const;

export type CodexModel = (typeof CODEX_MODELS)[number]['id'];
export type Provider = 'claude' | 'codex';
export type ModelId = ClaudeModel | CodexModel;

export const PROVIDER_IDS: Provider[] = ['claude', 'codex'];
export const PROVIDERS = {
  claude: { label: 'Claude', models: CLAUDE_MODELS },
  codex: { label: 'Codex', models: CODEX_MODELS },
} as const;

export const DEFAULT_CODEX_MODEL: CodexModel = 'gpt-6.1-sol';
export const DEFAULT_BRIEFING_CODEX_MODEL: CodexModel = 'gpt-6.1-terra';

/** Keep provider and model together, including when loading older preferences. */
export function normalizeModelSelection(
  provider: unknown,
  model: unknown,
  proactive = false
): { provider: Provider; model: ModelId } {
  const selected = provider === 'codex' ? 'codex' : 'claude';
  const match = PROVIDERS[selected].models.find((m) => m.id === model);
  if (match) return { provider: selected, model: match.id };
  if (
    selected === 'claude' &&
    typeof model === 'string' &&
    Object.prototype.hasOwnProperty.call(RETIRED_CLAUDE_MODELS, model)
  ) {
    return { provider: selected, model: RETIRED_CLAUDE_MODELS[model].successor };
  }
  return {
    provider: selected,
    model: selected === 'codex' ? DEFAULT_CODEX_MODEL : proactive ? DEFAULT_FAST_CLAUDE_MODEL : DEFAULT_CLAUDE_MODEL,
  };
}
