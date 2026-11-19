import { SYNTAX_LANGUAGES, syntaxLanguage, type SyntaxLanguage } from './syntax-scope';

/**
 * Settings › Appearance › Code intelligence (#393): whether diffs show code structure (hunk breadcrumbs, "Show whole
 * function" and opening short definitions), and for which languages. Pure, so main, the renderer and unit tests share
 * one reading of `preferences.json`. A language that is off is never read for its scopes, never parsed, and its diffs
 * show as they would without a grammar. Languages Gnosis adds later are on: the setting lists those turned off.
 */
export interface CodeIntelligencePreferences {
  /** "Show code structure in diffs". Undefined means on. */
  enabled?: boolean;
  /** Languages turned off. */
  disabled?: string[];
}
export interface CodeIntelligenceSettings {
  enabled: boolean;
  disabled: SyntaxLanguage[];
}
export const DEFAULT_CODE_INTELLIGENCE: Readonly<CodeIntelligenceSettings> = { enabled: true, disabled: [] };

/** The setting as saved, with unknown languages and repeats dropped, in the order Settings lists languages. */
export function codeIntelligenceSettings(preferences: unknown): CodeIntelligenceSettings {
  const p = (preferences && typeof preferences === 'object' ? preferences : {}) as Record<string, unknown>;
  const raw = (p.codeIntelligence && typeof p.codeIntelligence === 'object' ? p.codeIntelligence : {}) as Record<
    string,
    unknown
  >;
  const disabled = Array.isArray(raw.disabled) ? new Set(raw.disabled.filter((v) => typeof v === 'string')) : new Set();
  return {
    enabled: raw.enabled !== false,
    disabled: SYNTAX_LANGUAGES.filter((language) => disabled.has(language)),
  };
}

/** Whether a language's code structure shows. */
export const languageEnabled = (settings: CodeIntelligenceSettings, language: SyntaxLanguage | undefined) =>
  !!language && settings.enabled && !settings.disabled.includes(language);
/** Whether a file's code structure shows: it has a grammar, and its language is on. */
export const pathEnabled = (settings: CodeIntelligenceSettings, path: string) =>
  languageEnabled(settings, syntaxLanguage(path));

/** The setting with one language turned on or off. */
export function withLanguage(
  settings: CodeIntelligenceSettings,
  language: SyntaxLanguage,
  on: boolean
): CodeIntelligenceSettings {
  const disabled = new Set(settings.disabled);
  if (on) disabled.delete(language);
  else disabled.add(language);
  return { ...settings, disabled: SYNTAX_LANGUAGES.filter((l) => disabled.has(l)) };
}

/** Names as Settings lists them. */
export const LANGUAGE_NAMES: Record<SyntaxLanguage, string> = {
  typescript: 'TypeScript',
  tsx: 'TSX',
  javascript: 'JavaScript',
  rust: 'Rust',
  go: 'Go',
  python: 'Python',
  java: 'Java',
  csharp: 'C#',
  json: 'JSON',
  yaml: 'YAML',
};
