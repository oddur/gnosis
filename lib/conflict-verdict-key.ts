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

/**
 * The conflict dialog's own checks in flight, by path (#531 review). A check reads Settings › Code intelligence while it
 * runs, so its result counts only while it is the path's latest check and the settings it started under are still the
 * ones in effect. Quick off, on and off again gives the same verdict key, but a check started before it is dropped.
 */
export function verdictRuns() {
  let settings: string | undefined;
  let generation = 0;
  const runs = new Map<string, { key: string; generation: number }>();
  return {
    /** The settings in effect now, as `disabledLanguages(…).join()`. A change drops every check in flight. */
    sync(next: string) {
      if (next === settings) return;
      settings = next;
      generation++;
      runs.clear();
    },
    /** A check for `key` is in flight under the current settings. */
    running: (path: string, key: string) => {
      const run = runs.get(path);
      return run?.key === key && run.generation === generation;
    },
    start(path: string, key: string) {
      const run = { key, generation };
      runs.set(path, run);
      return run;
    },
    /** A path's verdict came from elsewhere (the saved one): a check still in flight for it no longer counts. */
    drop(path: string) {
      runs.delete(path);
    },
    /** Whether a finished check's result counts. */
    accepts: (path: string, run: { key: string; generation: number }) =>
      runs.get(path) === run && run.generation === generation,
  };
}
