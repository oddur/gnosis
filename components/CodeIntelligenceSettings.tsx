import manifest from '../src/assets/tree-sitter/manifest.json';
import { SYNTAX_LANGUAGES, type SyntaxLanguage } from '../lib/syntax-scope';
import { LANGUAGE_NAMES, withLanguage, type CodeIntelligenceSettings as Settings } from '../lib/code-intelligence';
import { SettingRow, Toggle } from './SettingsControls';
import { SCOPE_CONTEXT_BUDGET } from '../lib/show-scope';

/** Each bundled grammar's size, from the vendored manifest (scripts/vendor-tree-sitter.mjs). */
const GRAMMAR_BYTES = new Map<string, number>(
  manifest.packages.flatMap((pkg) =>
    Object.entries(pkg.files as unknown as Record<string, { bytes: number }>).flatMap(([file, entry]) =>
      file.endsWith('.wasm') ? [[file.slice(0, -'.wasm'.length), entry.bytes] as const] : []
    )
  )
);
const size = (language: SyntaxLanguage) => {
  const bytes = GRAMMAR_BYTES.get(language) ?? 0;
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1_000))} KB`;
};

/**
 * Settings › Appearance › Code intelligence (#393): the master switch for code structure in diffs, and one switch per
 * bundled language. Grammars ship with the app and load only when a file of their language is parsed.
 */
export function CodeIntelligenceSettings({ value, onChange }: { value: Settings; onChange: (next: Settings) => void }) {
  return (
    <section className="settings-group flex flex-col gap-2" aria-labelledby="code-intelligence-title">
      <h3 id="code-intelligence-title" className="text-sm font-medium">
        Code intelligence
      </h3>
      <SettingRow
        label="Show code structure in diffs"
        description="Name the function or class around each change, offer Show whole function, and list the symbols each file changes."
      >
        <Toggle
          checked={value.enabled}
          ariaLabel="Show code structure in diffs"
          onChange={() => onChange({ ...value, enabled: !value.enabled })}
        />
      </SettingRow>
      <SettingRow
        label="Show the whole function or class when it’s short"
        description={`When at most ${SCOPE_CONTEXT_BUDGET} more lines above and below a change complete the function, method or class around it, show all of it, marked by a rail beside the line numbers. Collapse it on any hunk.`}
      >
        <Toggle
          checked={value.enabled && value.showScope}
          disabled={!value.enabled}
          ariaLabel="Show the whole function or class when it’s short"
          onChange={() => onChange({ ...value, showScope: !value.showScope })}
        />
      </SettingRow>
      <div className="settings-code-languages" role="group" aria-label="Languages" data-disabled={!value.enabled || undefined}>
        <p className="settings-description">
          Languages. Each grammar is part of the app and loads when a file of its language first shows.
        </p>
        <ul>
          {SYNTAX_LANGUAGES.map((language) => {
            const on = !value.disabled.includes(language);
            return (
              <li key={language} className="settings-code-language" data-language={language}>
                <span className="text-sm text-foreground">{LANGUAGE_NAMES[language]}</span>
                <span className="settings-description">{size(language)}</span>
                <Toggle
                  checked={on}
                  ariaLabel={`Code structure for ${LANGUAGE_NAMES[language]}`}
                  onChange={() => onChange(withLanguage(value, language, !on))}
                />
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
