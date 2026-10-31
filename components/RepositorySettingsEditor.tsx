import { useEffect, useId, useState } from 'react';
import { Button } from './ui/button';
import { RepositoryIconPicker } from './RepositoryIconPicker';
import { PrInactivitySetting } from './PrInactivitySetting';
import { RepositoryIcon, RepositoryMark } from './RepositoryAppearance';
import {
  REPOSITORY_COLORS,
  repositorySettings,
  validRepositoryIcon,
  type RepositorySettings,
  type RepositoryDefaults,
  type BriefingBudget,
} from '../lib/repository-settings';
export const REPOSITORY_SETTING_KEYS = [
  'prInactivityDays',
  'ignoreDependabotPrs',
  'autoBriefings',
  'briefingDailyLimit',
  'icon',
  'color',
] as const;
type Key = keyof RepositorySettings;
const settingNames = {
  prInactivityDays: 'inactivity',
  ignoreDependabotPrs: 'Dependabot',
  autoBriefings: 'automatic briefings',
  briefingDailyLimit: 'daily briefing count',
  icon: 'icon',
  color: 'color',
};
export function RepositorySettingsEditor({
  repo,
  value,
  defaults,
  onApply,
  onCancel,
  action = 'Save settings',
  bulk = false,
  saving = false,
  error,
  budget,
  initialChanged = [],
  onDraftChange,
}: {
  initialChanged?: Key[];
  onDraftChange?: (value: RepositorySettings, changed: Key[]) => void;
  budget?: BriefingBudget;
  repo: string;
  value: RepositorySettings;
  defaults: RepositoryDefaults;
  onApply: (settings: RepositorySettings, changed: Key[]) => void;
  onCancel: () => void;
  action?: string;
  bulk?: boolean;
  saving?: boolean;
  error?: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const [changed, setChanged] = useState<Key[]>(initialChanged);
  useEffect(() => {
    if (changed.length) onDraftChange?.(draft, changed);
  }, [draft, changed, onDraftChange]);
  const [emoji, setEmoji] = useState(value.icon?.startsWith('emoji:') ? value.icon.slice(6) : '');
  const [emojiMode, setEmojiMode] = useState(!!value.icon?.startsWith('emoji:'));
  const inherited = repositorySettings({ ...defaults, repositorySettings: {} }, repo);
  const effective = { ...inherited, ...Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== undefined)) };
  function patch(update: Partial<RepositorySettings>) {
    setDraft((current) => ({ ...current, ...update }));
    setChanged((current) => [...new Set([...current, ...(Object.keys(update) as Key[])])]);
  }
  const inheritedToggle = (key: Key, fallback: number | boolean) => (
    <label className="repository-inherit">
      <input
        type="checkbox"
        aria-label={`Use global default for ${settingNames[key]}`}
        checked={draft[key] === undefined}
        onChange={(e) => patch({ [key]: e.target.checked ? undefined : fallback })}
      />
      Use global default (
      {typeof fallback === 'boolean'
        ? fallback
          ? 'on'
          : 'off'
        : key === 'prInactivityDays'
          ? fallback
            ? `${fallback} days`
            : 'never ignore'
          : `${fallback}/day`}
      )
    </label>
  );
  const usage = budget?.repositories[repo.toLowerCase()];
  const invalidEmoji = emojiMode && !validRepositoryIcon(`emoji:${emoji}`);
  return (
    <section
      className="repository-editor"
      aria-label={`Configure ${repo}`}
      onKeyDown={(event) => {
        if (
          event.key === 'Enter' &&
          event.target instanceof HTMLInputElement &&
          !event.target.closest('[data-slot="combobox-content"]')
        ) {
          event.preventDefault();
          event.stopPropagation();
          event.target.blur();
        }
      }}
    >
      <fieldset disabled={saving} className="repository-editor-fields">
        <div className="repository-editor-body">
          <div className="repository-editor-heading">
            <h3 tabIndex={-1}>{bulk ? repo : <RepositoryMark repo={repo} settings={draft} />}</h3>
            <p>
              {bulk
                ? 'Only settings you change here are applied. Other overrides and appearance choices stay as they are.'
                : 'Overrides apply to this repository in every view. Settings stay on this computer.'}
            </p>
          </div>
          <div className="repository-setting-row">
            <div>
              <h4>Ignore PRs inactive for</h4>
              <p>Starred PRs and necessary stack context stay available.</p>
            </div>
            <div>
              {inheritedToggle('prInactivityDays', inherited.prInactivityDays)}
              {draft.prInactivityDays !== undefined && (
                <PrInactivitySetting days={draft.prInactivityDays} onChange={(v) => patch({ prInactivityDays: v })} />
              )}
            </div>
          </div>
          {(['ignoreDependabotPrs', 'autoBriefings'] as const).map((key) => (
            <div className="repository-setting-row" key={key}>
              <div>
                <h4>{key === 'autoBriefings' ? 'Automatic briefings' : 'Ignore Dependabot'}</h4>
                <p>
                  {key === 'autoBriefings'
                    ? 'Uses your active view and automatic briefing limits.'
                    : 'Hide Dependabot-only PRs from the queue.'}
                </p>
              </div>
              <div>
                {inheritedToggle(key, inherited[key])}
                {draft[key] !== undefined && (
                  <label className="repository-inherit">
                    <input
                      type="checkbox"
                      aria-label={
                        key === 'autoBriefings' ? 'Repository automatic briefings' : 'Repository ignore Dependabot'
                      }
                      checked={draft[key]}
                      onChange={(e) => patch({ [key]: e.target.checked })}
                    />
                    {key === 'autoBriefings' ? 'Generate automatically' : 'Hide Dependabot PRs'}
                  </label>
                )}
              </div>
            </div>
          ))}
          <div className="repository-setting-row">
            <div>
              <h4>Daily automatic briefings</h4>
              <p>The overall cap also applies. Manual briefings do not count.</p>
            </div>
            <div>
              {inheritedToggle('briefingDailyLimit', inherited.briefingDailyLimit)}
              {draft.briefingDailyLimit !== undefined && (
                <label className="repository-number">
                  <input
                    aria-label="Repository daily automatic briefings"
                    type="number"
                    min={0}
                    max={100}
                    value={draft.briefingDailyLimit}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isInteger(v) && v >= 0 && v <= 100) patch({ briefingDailyLimit: v });
                    }}
                  />{' '}
                  per day
                </label>
              )}
              <p>{effective.briefingDailyLimit === 0 ? 'Automatic generation is paused. ' : ''}Resets at midnight.</p>
              {budget && !bulk && (
                <p className="repository-budget">
                  {Math.max(0, effective.briefingDailyLimit - (usage?.used ?? 0))} of {effective.briefingDailyLimit}{' '}
                  left here · {budget.remaining} left overall
                </p>
              )}
            </div>
          </div>
          <div className="repository-appearance">
            <div className="repository-editor-heading">
              <h4>Repository appearance</h4>
              <p>Identifies the repository. PR status colors stay separate.</p>
            </div>
            <div className="repository-icon-controls">
              <RepositoryIconPicker
                value={emojiMode ? 'emoji' : (draft.icon ?? 'default')}
                color={draft.color}
                onChange={(v) => {
                  setEmojiMode(v === 'emoji');
                  patch({ icon: v === 'default' ? undefined : v === 'emoji' ? `emoji:${emoji}` : v });
                }}
              />
              {emojiMode && (
                <label htmlFor={`${id}-emoji`}>
                  Emoji{' '}
                  <input
                    id={`${id}-emoji`}
                    aria-label="Repository emoji"
                    value={emoji}
                    maxLength={34}
                    onChange={(e) => {
                      setEmoji(e.target.value);
                      patch({ icon: `emoji:${e.target.value}` });
                    }}
                    aria-invalid={invalidEmoji}
                    placeholder="🚀"
                  />
                </label>
              )}
            </div>
            {invalidEmoji && <p role="alert">Enter one emoji, or choose an icon.</p>}
            <div className="repository-colors" role="group" aria-label="Repository color">
              {[undefined, ...REPOSITORY_COLORS].map((color) => (
                <button
                  key={color ?? 'default'}
                  type="button"
                  className={`repository-color-choice repository-color-${color ?? 'default'}`}
                  aria-label={`${color ?? 'Default'} repository color`}
                  aria-pressed={draft.color === color}
                  onClick={() => patch({ color })}
                >
                  <RepositoryIcon settings={{ icon: draft.icon, color }} />
                  <span>{color ?? 'Default'}</span>
                </button>
              ))}
            </div>
            <div className="repository-preview">
              <RepositoryMark repo={bulk ? 'owner/repository' : repo} settings={draft} />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  patch({ icon: undefined, color: undefined });
                  setEmojiMode(false);
                }}
              >
                Reset appearance
              </Button>
            </div>
          </div>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
        </div>
        <div className="repository-editor-actions">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => {
              setDraft({});
              setChanged([...REPOSITORY_SETTING_KEYS]);
              setEmojiMode(false);
            }}
          >
            Reset repository settings
          </Button>
          <span />
          <Button type="button" variant="outline" size="sm" disabled={saving} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={saving || invalidEmoji} onClick={() => onApply(draft, changed)}>
            {saving ? 'Saving…' : action}
          </Button>
        </div>
      </fieldset>
    </section>
  );
}
