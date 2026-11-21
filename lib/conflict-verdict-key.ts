import { languageEnabled, type CodeIntelligenceSettings } from './code-intelligence';
import { CHECKS_VERSION, proposalKey } from './conflict-verify';
import type { ConflictFile } from './conflict-resolution';
import { SYNTAX_LANGUAGES, syntaxLanguage, type SyntaxLanguage } from './syntax-scope';

/** The languages Settings › Code intelligence keeps from being parsed, the conflict checks included. */
export const disabledLanguages = (settings: CodeIntelligenceSettings): SyntaxLanguage[] =>
  SYNTAX_LANGUAGES.filter((language) => !languageEnabled(settings, language));

/**
 * What a saved verdict (`ConflictFile.verdict`) was made for: the checks' version, whether the file's own language was
 * off in Settings, and the proposals with the draft (proposalKey). A verdict counts only while all three are the same:
 * turning another language on or off leaves it alone.
 */
export const verdictKey = (
  file: Pick<ConflictFile, 'path' | 'original' | 'proposals' | 'wholeFile'> & Partial<Pick<ConflictFile, 'result'>>,
  disabled: readonly SyntaxLanguage[]
) => {
  const language = syntaxLanguage(file.path);
  return `${CHECKS_VERSION}:${language && disabled.includes(language) ? 'off' : 'on'}:${proposalKey(file)}`;
};
