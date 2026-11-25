import { useEffect, useId, useState } from 'react';
import {
  EXPLANATION_STYLES,
  NOISE_LEVELS,
  normalizeExplanationPreferences,
  type ExplanationPreferences,
} from '../lib/explanation-options';

export function ExplanationPreferencesFields({
  value,
  onChange,
  extensions = false,
  focusedSections = false,
}: {
  value: ExplanationPreferences;
  onChange: (value: ExplanationPreferences) => void;
  extensions?: boolean;
  /** Show the Focused sections choice (#562): in Settings it is the repository's default, in Generate explanation this explanation's. */
  focusedSections?: boolean;
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
      <div className="explanation-noise-setting">
        <span id={`${id}-noise`} className="explanation-noise-label">
          Reduce noise
        </span>
        <div className="explanation-noise-switch" role="radiogroup" aria-labelledby={`${id}-noise`}>
          {NOISE_LEVELS.map((level) => (
            <button
              type="button"
              role="radio"
              key={level.value}
              aria-checked={value.reduceNoise === level.value}
              tabIndex={value.reduceNoise === level.value ? 0 : -1}
              data-level={level.value}
              onClick={() => onChange({ ...value, reduceNoise: level.value })}
              onKeyDown={(event) => {
                const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
                if (!step) return;
                event.preventDefault();
                const index = NOISE_LEVELS.findIndex((l) => l.value === value.reduceNoise);
                const next = NOISE_LEVELS[(index + step + NOISE_LEVELS.length) % NOISE_LEVELS.length];
                onChange({ ...value, reduceNoise: next.value });
                const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=radio]');
                buttons?.[NOISE_LEVELS.indexOf(next)]?.focus();
              }}
            >
              {level.label}
            </button>
          ))}
        </div>
        <small className="explanation-noise-description">
          {NOISE_LEVELS.find((level) => level.value === value.reduceNoise)?.description} Left-out changes stay in
          Changes.
        </small>
      </div>
      {focusedSections && (
        <label className="explanation-focused-setting">
          <input
            type="checkbox"
            checked={value.focusedSections}
            onChange={(event) => onChange({ ...value, focusedSections: event.target.checked })}
          />
          <span>
            <strong>Focused sections</strong>
            <small>
              Each section shows only the parts of large changes it explains. Code no section needs is listed
              separately. Changes still shows every line. Needs parallel review.
            </small>
          </span>
        </label>
      )}
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
