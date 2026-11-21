import { languageEnabled, type CodeIntelligenceSettings } from './code-intelligence';
import { CHECKS_VERSION, proposalKey } from './conflict-verify';
import type { ConflictFile } from './conflict-resolution';
import { SYNTAX_LANGUAGES, type SyntaxLanguage } from './syntax-scope';

/** The languages Settings › Code intelligence keeps from being parsed, the conflict checks included. */
export const disabledLanguages = (settings: CodeIntelligenceSettings): SyntaxLanguage[] =>
  SYNTAX_LANGUAGES.filter((language) => !languageEnabled(settings, language));

/**
 * What a saved verdict (`ConflictFile.verdict`) was made for: the checks' version, the languages that were off, and
 * the proposals with the draft (proposalKey). A verdict counts only while all three are the same.
 */
export const verdictKey = (
  file: Pick<ConflictFile, 'original' | 'proposals' | 'wholeFile'> & Partial<Pick<ConflictFile, 'result'>>,
  disabled: readonly SyntaxLanguage[]
) => `${CHECKS_VERSION}:${disabled.join(',')}:${proposalKey(file)}`;
