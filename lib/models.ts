// Single source of truth for the Claude model roster. The picker UIs
// (HomePage, SettingsDialog), the provider (`--model` passed to the
// CLI), the `ClaudeModel` union, and the stored-preference migration
// all derive from the tables here — a roster change is one edit in
// this file. No React imports: this module is shared by the renderer
// and the Electron main process.

export const CLAUDE_MODELS = [
  { id: 'claude-fable-5', label: 'Fable 5', quick: false },
  { id: 'claude-opus-5', label: 'Opus 5', quick: false },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', quick: false },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', quick: true },
] as const;

export type ClaudeModel = (typeof CLAUDE_MODELS)[number]['id'];

/** Default for manual reviews and the general model preference. */
export const DEFAULT_CLAUDE_MODEL: ClaudeModel = 'claude-opus-5';
/** Default for background/proactive reviews and slide chat — fast and cheap. */
export const DEFAULT_FAST_CLAUDE_MODEL: ClaudeModel = 'claude-sonnet-5';

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
  'claude-opus-4-6': { label: 'Claude Opus 4.6', successor: 'claude-opus-5' },
  'claude-opus-4-7': { label: 'Claude Opus 4.7', successor: 'claude-opus-5' },
  'claude-sonnet-4-6': { label: 'Claude Sonnet 4.6', successor: 'claude-sonnet-5' },
};
