import { useEffect, useId, useState } from 'react';
import {
  EXPLANATION_STYLES,
  normalizeExplanationPreferences,
  type ExplanationPreferences,
} from '../lib/explanation-options';

export function ExplanationPreferencesFields({
  value,
  onChange,
  extensions = false,
}: {
  value: ExplanationPreferences;
  onChange: (value: ExplanationPreferences) => void;
  extensions?: boolean;
}) {
  const id = useId();
  const extensionsLabel = value.hiddenExtensions.map((extension) => extension || '[none]').join(', ');
  const [extensionText, setExtensionText] = useState(extensionsLabel);
  useEffect(() => setExtensionText(extensionsLabel), [extensionsLabel]);
  return (
    <div className="explanation-preferences-fields">
      <fieldset className="explanation-style-options">
        <legend>Explanation style</legend>
        {EXPLANATION_STYLES.map((style) => (
          <label key={style.value}>
            <input
              type="radio"
              name={`${id}-style`}
              value={style.value}
              checked={value.style === style.value}
              onChange={() => onChange({ ...value, style: style.value })}
            />
            <span>
              <strong>{style.label}</strong>
              <small>{style.description}</small>
            </span>
          </label>
        ))}
      </fieldset>
      {value.style === 'custom' && (
        <label className="explanation-custom-label" htmlFor={`${id}-instructions`}>
          Custom instructions
          <textarea
            id={`${id}-instructions`}
            rows={4}
            maxLength={20000}
            value={value.customInstructions}
            placeholder="For example: focus on concurrency and explain the invariants each change preserves."
            onChange={(event) => onChange({ ...value, customInstructions: event.target.value })}
          />
          <small>Your global review instructions also apply.</small>
        </label>
      )}
      <fieldset className="explanation-file-rules">
        <legend>Exclude from the explanation</legend>
        <label>
          <input
            type="checkbox"
            checked={value.excludeGenerated}
            onChange={(event) => onChange({ ...value, excludeGenerated: event.target.checked })}
          />
          Generated files
        </label>
        <label>
          <input
            type="checkbox"
            checked={value.excludeTests}
            onChange={(event) => onChange({ ...value, excludeTests: event.target.checked })}
          />
          Test files
        </label>
      </fieldset>
      {extensions && (
        <label className="explanation-custom-label" htmlFor={`${id}-extensions`}>
          Hidden extensions
          <input
            id={`${id}-extensions`}
            value={extensionText}
            placeholder=".snap, .lock"
            onChange={(event) => setExtensionText(event.target.value)}
            onBlur={() =>
              onChange(
                normalizeExplanationPreferences({
                  ...value,
                  hiddenExtensions: extensionText
                    .split(/[\s,]+/)
                    .filter(Boolean)
                    .map((extension) => (extension === '[none]' ? '' : extension)),
                })
              )
            }
          />
          <small>Separate extensions with commas. Use [none] for files without an extension.</small>
        </label>
      )}
    </div>
  );
}
