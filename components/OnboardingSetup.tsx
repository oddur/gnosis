import { RepositorySettingsList } from './RepositorySettingsList';
import { ModelEffortSelect } from './ModelEffortSelect';
import { effortLabels, normalizeEffort } from '../lib/effort';
import { GitHubIcon } from '../lib/constants';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, X } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog';
import { Button } from './ui/button';
import {
  Questionnaire,
  QuestionnaireItem,
  QuestionnaireTitle,
  QuestionnaireDescription,
  QuestionnaireProgress,
  QuestionnaireChoices,
  QuestionnaireChoice,
  QuestionnairePrevious,
  QuestionnaireNext,
  QuestionnaireSubmit,
} from './ui/questionnaire';
import { RepositoryPicker } from './RepositoryPicker';
import { SearchableSelect } from './SearchableSelect';
import { QueueFilterPanel } from './QueueFilterPanel';
import {
  SETUP_GOALS,
  SETUP_STEPS,
  setupViews,
  recommendedSetupModel,
  setupForInstalledProviders,
  type SetupDraft,
  type SetupStep,
} from '../lib/onboarding';
import { normalizeQueueFilters } from '../lib/queue-filters';
import { PROVIDERS, PROVIDER_IDS, type Provider } from '../lib/models';
import type { QueueItem } from '../lib/workbench';

export function OnboardingSetup({
  draft,
  onChange,
  onPause,
  onApply,
  onConnect,
  login,
  items,
  saving,
  saveError,
}: {
  draft: SetupDraft;
  onChange: (draft: SetupDraft) => void;
  onPause: () => void;
  onApply: () => void;
  onConnect: () => void;
  login: string | null;
  items: QueueItem[];
  saving: boolean;
  saveError: string;
}) {
  const [error, setError] = useState('');
  const [cli, setCli] = useState<Partial<Record<Provider, 'found' | 'missing' | 'error'>> | null>(null);
  const [retry, setRetry] = useState(0);
  const [linkError, setLinkError] = useState('');
  const latest = useRef({ draft, onChange });
  latest.current = { draft, onChange };
  const available = PROVIDER_IDS.filter((id) => cli?.[id] === 'found');
  const modelOptions = (role: 'explanation' | 'briefing') =>
    available.flatMap((provider) =>
      PROVIDERS[provider].models.map((model) => ({
        value: model.id,
        label: `${PROVIDERS[provider].label} · ${model.label}${model.id === recommendedSetupModel(provider, role) ? ' (recommended)' : ''}`,
      }))
    );
  const patch = (next: Partial<SetupDraft>) => {
    setError('');
    onChange({ ...draft, ...next });
  };
  const steps = SETUP_STEPS.filter((step) => !draft.local || !['github', 'repositories', 'filters'].includes(step));
  const active = steps.includes(draft.step) ? draft.step : 'goals';
  useEffect(() => {
    if (active !== 'ai') return;
    let alive = true;
    setCli(null);
    void Promise.allSettled(PROVIDER_IDS.map((provider) => window.electronAPI.checkCliInstalled(provider, true))).then(
      (results) => {
        if (!alive) return;
        const statuses: Partial<Record<Provider, 'found' | 'missing' | 'error'>> = {};
        results.forEach((result, index) => {
          statuses[PROVIDER_IDS[index]] =
            result.status === 'rejected' ? 'error' : result.value.installed ? 'found' : 'missing';
        });
        setCli(statuses);
        const installed = PROVIDER_IDS.filter((id) => statuses[id] === 'found');
        if (installed.length) latest.current.onChange(setupForInstalledProviders(latest.current.draft, installed));
      }
    );
    return () => {
      alive = false;
    };
  }, [active, retry]);
  const validate = () => {
    if (active === 'goals' && !draft.local && !draft.goals.length)
      return 'Choose at least one goal, or use local reviews.';
    if (active === 'github' && !login) return 'Connect GitHub, or choose local reviews on the previous step.';
    if (active === 'repositories' && draft.goals.includes('repositories') && !draft.repositories.length)
      return 'Choose at least one repository for Repository activity.';
    if (active === 'ai' && !available.length)
      return cli
        ? 'Install an AI tool and check again, or choose Set up AI later.'
        : 'Checking installed AI tools. You can also set up AI later.';
    return '';
  };
  const move = (step: string) => {
    const failure = steps.indexOf(step as SetupStep) > steps.indexOf(active) ? validate() : '';
    if (failure) {
      setError(failure);
      return;
    }
    patch({ step: step as SetupStep });
  };
  const automaticEnabled = draft.autoBriefings || Object.values(draft.repositorySettings ?? {}).some(s => s.autoBriefings === true);
  const goals = SETUP_GOALS.filter((goal) => draft.goals.includes(goal.id));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onPause();
      }}
    >
      <DialogContent
        className="setup-dialog"
        showCloseButton={false}
        onPointerDownOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (saving || document.querySelector('[data-slot=combobox-content]')) event.preventDefault();
        }}
      >
        <div className="setup-heading">
          <div>
            <DialogTitle>Make Gnosis yours</DialogTitle>
            <DialogDescription>A review queue built around your work.</DialogDescription>
          </div>
          <Button variant="ghost" size="icon" disabled={saving} aria-label="Save setup and close" onClick={onPause}>
            <X size={18} />
          </Button>
        </div>
        <Questionnaire
          className="setup-questionnaire"
          item={active}
          items={steps.map((name) => ({ name }))}
          onItemChange={move}
          onSubmit={(event) => {
            event.preventDefault();
            if (saving) return;
            if (active !== 'finish') {
              move(steps[steps.indexOf(active) + 1]);
              return;
            }
            try {
              setupViews(draft);
              onApply();
            } catch (failure) {
              setError(failure instanceof Error ? failure.message : 'Check your setup choices.');
            }
          }}
        >
          <QuestionnaireProgress className="setup-progress" />
          <div inert={saving} className="setup-body">
            <QuestionnaireItem name="goals" multiple>
              <QuestionnaireTitle>What brings you to Gnosis?</QuestionnaireTitle>
              <QuestionnaireDescription>
                Choose all that apply. Each goal gets its own saved view.
              </QuestionnaireDescription>
              <QuestionnaireChoices className="setup-choices">
                {SETUP_GOALS.map((goal) => (
                  <QuestionnaireChoice
                    key={goal.id}
                    value={goal.id}
                    checked={!draft.local && draft.goals.includes(goal.id)}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...draft.goals, goal.id]
                        : draft.goals.filter((id) => id !== goal.id);
                      patch({
                        local: false,
                        goals: [...new Set(next)],
                        start: next.includes(draft.start) ? draft.start : (next[0] ?? 'review'),
                      });
                    }}
                  >
                    <strong>{goal.label}</strong>
                    <span className="setup-choice-description">{goal.description}</span>
                  </QuestionnaireChoice>
                ))}
              </QuestionnaireChoices>
              <Button
                type="button"
                variant={draft.local ? 'secondary' : 'ghost'}
                onClick={() => patch({ local: !draft.local })}
                aria-pressed={draft.local}
              >
                {draft.local && <Check size={15} />}Use local reviews without GitHub
              </Button>
            </QuestionnaireItem>
            {!draft.local && (
              <QuestionnaireItem name="github">
                <QuestionnaireTitle>Connect your GitHub account</QuestionnaireTitle>
                <QuestionnaireDescription>
                  Gnosis uses your access to find PRs and load their code, comments, and checks.
                </QuestionnaireDescription>
                {login ? (
                  <p className="setup-connected">
                    <Check size={18} />
                    Connected as <strong>{login}</strong>
                  </p>
                ) : (
                  <Button type="button" onClick={onConnect}>
                    <GitHubIcon className="size-4" />
                    Connect GitHub
                  </Button>
                )}
                <p className="setup-note">
                  Browser sign-in, device code, and personal access tokens are supported. AI sign-in is separate.
                </p>
              </QuestionnaireItem>
            )}
            {!draft.local && (
              <QuestionnaireItem name="repositories">
                <QuestionnaireTitle>
                  {draft.goals.includes('repositories')
                    ? 'Which repositories do you follow?'
                    : 'Follow any repositories?'}
                </QuestionnaireTitle>
                <QuestionnaireDescription>
                  {draft.goals.includes('repositories')
                    ? 'Add repositories for your Repository activity view.'
                    : 'Optional. Your own PRs and review requests are included without adding repositories.'}
                </QuestionnaireDescription>
                <RepositoryPicker
                  value={draft.repositories}
                  onChange={(repositories) => patch({ repositories })}
                  search
                />
                <RepositorySettingsList repositories={draft.repositories} settings={draft.repositorySettings ?? {}}
                  defaults={{ prInactivityDays: draft.days, ignoreDependabotPrs: draft.ignoreDependabot, autoBriefings: draft.autoBriefings, briefingDailyLimit: draft.dailyLimit, repositoryBriefingDailyLimit: draft.repositoryDailyLimit }}
                  onChange={repositorySettings => patch({ repositorySettings })} />
                <p className="setup-note">
                  This adds open PRs to Gnosis. It does not change GitHub Watch subscriptions.
                </p>
              </QuestionnaireItem>
            )}
            {!draft.local && (
              <QuestionnaireItem name="filters">
                <QuestionnaireTitle>Keep the queue focused</QuestionnaireTitle>
                <QuestionnaireDescription>
                  These defaults keep older work and bot updates out of the way.
                </QuestionnaireDescription>
                <label className="setup-field">
                  PRs last updated
                  <SearchableSelect
                    label="PRs last updated"
                    value={String(draft.days)}
                    onValueChange={(value) => patch({ days: Number(value) })}
                    options={[0, 7, 14, 30, 90, 180, 365].map((days) => ({
                      value: String(days),
                      label: days ? `Within ${days} days` : 'Any time',
                    }))}
                  />
                </label>
                <label className="setup-check">
                  <input
                    type="checkbox"
                    checked={draft.ignoreDependabot}
                    onChange={(event) => patch({ ignoreDependabot: event.target.checked })}
                  />
                  Hide Dependabot PRs
                </label>
                <p className="setup-note">
                  Both read and unread PRs are included. The activity cutoff and Dependabot setting apply across Gnosis;
                  saved views can narrow them further.
                </p>
                <details>
                  <summary>Refine labels, authors, or target branches</summary>
                  <QueueFilterPanel
                    setup
                    filters={normalizeQueueFilters(draft.refinements)}
                    items={items}
                    onChange={(change) => patch({ refinements: { ...draft.refinements, ...change } })}
                  />
                </details>
              </QuestionnaireItem>
            )}
            <QuestionnaireItem name="ai">
              <QuestionnaireTitle>Choose how AI helps</QuestionnaireTitle>
              <QuestionnaireDescription>
                Choose a model for detailed explanations and one for quick briefings. You can change either later in
                Settings.
              </QuestionnaireDescription>
              <div className="setup-cli">
                <span role="status">
                  {cli === null
                    ? 'Checking Claude Code and Codex…'
                    : available.length
                      ? `${available.map((id) => (id === 'claude' ? 'Claude Code' : 'Codex')).join(' and ')} found on this computer.`
                      : 'No AI tool found yet. You can still read PRs and inspect diffs.'}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={cli === null}
                  onClick={() => setRetry((value) => value + 1)}
                >
                  Check again
                </Button>
              </div>
              {cli &&
                PROVIDER_IDS.filter((id) => cli[id] === 'error').map((id) => (
                  <p key={id} className="setup-note" role="status">
                    Could not check {PROVIDERS[id].label}. Use Check again to retry.
                  </p>
                ))}
              {available.length > 0 && (
                <div className="setup-ai-roles">
                  <p className="setup-note">Higher effort allows more reasoning time and can take longer.</p>
                  <div className="setup-ai-role">
                    <div>
                      <label htmlFor="setup-explanation-model">Explanations</label>
                      <p id="setup-explanation-help" className="setup-note">
                        Guided walkthroughs of the code. Start one when you need it.
                      </p>
                    </div>
                    <ModelEffortSelect
                      id="setup-explanation-model"
                      label="Explanation model"
                      describedBy="setup-explanation-help"
                      provider={draft.provider}
                      model={draft.model}
                      effort={normalizeEffort(draft.provider, draft.model, draft.effort)}
                      options={modelOptions('explanation')}
                      onChange={(selection) => patch({ ...selection, configureAI: true })}
                    />
                  </div>
                  {!draft.local && (
                    <div className="setup-ai-role">
                      <div>
                        <label htmlFor="setup-briefing-model">Briefings</label>
                        <p id="setup-briefing-help" className="setup-note">
                          Short summaries to help you triage the review queue.
                        </p>
                      </div>
                      <ModelEffortSelect
                        id="setup-briefing-model"
                        label="Briefing model"
                        describedBy="setup-briefing-help"
                        provider={draft.briefingProvider}
                        model={draft.briefingModel}
                        effort={normalizeEffort(
                          draft.briefingProvider,
                          draft.briefingModel,
                          draft.briefingEffort,
                          false
                        )}
                        options={modelOptions('briefing')}
                        onChange={(selection) =>
                          patch({
                            briefingProvider: selection.provider,
                            briefingModel: selection.model,
                            briefingEffort: selection.effort,
                            configureAI: true,
                          })
                        }
                      />
                    </div>
                  )}
                </div>
              )}
              {cli && (
                <details className="setup-ai-guides" open={available.length === 0 || undefined}>
                  <summary>
                    {available.length ? 'Installation and sign-in guides' : 'Install Claude Code or Codex'}
                  </summary>
                  <p className="setup-note">
                    Sign in through the tool before generating. Finding an installed tool does not check your account or
                    model access.
                  </p>
                  <div className="setup-guide-links">
                    {PROVIDER_IDS.map((provider) => (
                      <Button
                        key={provider}
                        type="button"
                        variant="link"
                        className="setup-link"
                        onClick={() => {
                          setLinkError('');
                          void window.electronAPI
                            .openExternal(
                              provider === 'claude'
                                ? 'https://code.claude.com/docs/en/setup'
                                : 'https://developers.openai.com/codex/cli/'
                            )
                            .catch(() => setLinkError('Could not open the guide. Try again.'));
                        }}
                      >
                        {provider === 'claude' ? 'Claude Code' : 'Codex'} guide <ArrowRight size={14} />
                      </Button>
                    ))}
                  </div>
                </details>
              )}
              {linkError && <p role="alert">{linkError}</p>}
              {!draft.local && available.length > 0 && (
                <div className="setup-ai-automation">
                  <label className="setup-check">
                    <input
                      type="checkbox"
                      checked={draft.autoBriefings}
                      onChange={(event) => patch({ autoBriefings: event.target.checked })}
                    />
                    Create automatic briefings by default
                  </label>
                  {automaticEnabled && (
                    <label className="setup-field">
                      Overall daily automatic briefing cap
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={draft.dailyLimit}
                        onChange={(event) =>
                          patch({ dailyLimit: Math.min(100, Math.max(1, Number(event.target.value) || 1)) })
                        }
                      />
                      <span className="setup-note">
                        Counts automatic attempts across repositories. Manual briefings do not count. Resets at midnight.
                      </span>
                    </label>
                  )}
                </div>
              )}
              <Button
                type="button"
                variant="ghost"
                onClick={() => patch({ autoBriefings: false, configureAI: false, repositorySettings: Object.fromEntries(Object.entries(draft.repositorySettings ?? {}).map(([repo, settings]) => [repo, settings.autoBriefings === true ? { ...settings, autoBriefings: false } : settings])), step: 'finish' })}
              >
                Set up AI later
              </Button>
            </QuestionnaireItem>
            <QuestionnaireItem name="finish">
              <QuestionnaireTitle>
                {draft.local ? 'Ready for local reviews' : 'Your queue, ready to review'}
              </QuestionnaireTitle>
              <QuestionnaireDescription>
                Review what will change. Nothing is applied until you choose Apply setup.
              </QuestionnaireDescription>
              {!draft.local && (
                <div className="setup-views">
                  {goals.map((goal) => (
                    <label className="setup-field" key={goal.id}>
                      {goal.view}
                      <input
                        aria-label={`${goal.view} view name`}
                        maxLength={60}
                        value={draft.names[goal.id]}
                        onChange={(event) => patch({ names: { ...draft.names, [goal.id]: event.target.value } })}
                      />
                      <span className="setup-note">{goal.description}</span>
                    </label>
                  ))}
                  <label className="setup-field">
                    Open first
                    <SearchableSelect
                      label="Starting view"
                      value={draft.start}
                      options={goals.map((goal) => ({ value: goal.id, label: draft.names[goal.id] || goal.view }))}
                      onValueChange={(value) => patch({ start: value as SetupDraft['start'] })}
                    />
                  </label>
                </div>
              )}
              <ul className="setup-summary">
                {draft.configureAI && (
                  <>
                    <li>
                      Explanations: {PROVIDERS[draft.provider].label} ·{' '}
                      {PROVIDERS[draft.provider].models.find((model) => model.id === draft.model)?.label}
                      {` · ${effortLabels[normalizeEffort(draft.provider, draft.model, draft.effort)]} effort`}
                    </li>
                    {!draft.local && (
                      <li>
                        Briefings: {PROVIDERS[draft.briefingProvider].label} ·{' '}
                        {
                          PROVIDERS[draft.briefingProvider].models.find((model) => model.id === draft.briefingModel)
                            ?.label
                        }
                        {` · ${effortLabels[normalizeEffort(draft.briefingProvider, draft.briefingModel, draft.briefingEffort, false)]} effort`}
                      </li>
                    )}
                  </>
                )}
                {!draft.local && (
                  <li>
                    {draft.repositories.length} repositories followed ·{' '}
                    {draft.days ? `updated within ${draft.days} days` : 'any update date'}
                  </li>
                )}
                {!draft.local && <li>{Object.keys(draft.repositorySettings ?? {}).length} repositories with custom settings</li>}
                {!draft.local && <li>{draft.ignoreDependabot ? 'Dependabot hidden' : 'Dependabot included'}</li>}
                <li>
                  {automaticEnabled && !draft.local
                    ? `Automatic briefings · up to ${draft.dailyLimit}/day`
                    : 'AI generation starts only when you ask'}
                </li>
              </ul>
              <p className="setup-note">
                Setup-created views are updated on replay. Other saved views, reviews, and drafts are kept. You can
                change these choices later in Settings.
              </p>
            </QuestionnaireItem>
          </div>
          {(error || saveError) && (
            <p className="setup-error" role="alert">
              {error || saveError}
            </p>
          )}
          <div className="setup-actions">
            <Button type="button" variant="ghost" onClick={onPause} disabled={saving}>
              Finish later
            </Button>
            <div>
              <QuestionnairePrevious disabled={saving}>Back</QuestionnairePrevious>
              <QuestionnaireNext
                disabled={saving || (active === 'ai' && available.length === 0)}
                onClick={(event) => {
                  event.preventDefault();
                  move(steps[steps.indexOf(active) + 1]);
                }}
              >
                Next
              </QuestionnaireNext>
              <QuestionnaireSubmit
                disabled={saving}
                onClick={(event) => {
                  event.preventDefault();
                  try {
                    setupViews(draft);
                    onApply();
                  } catch (failure) {
                    setError(failure instanceof Error ? failure.message : 'Check your choices.');
                  }
                }}
              >
                {saving ? 'Applying…' : 'Apply setup'}
              </QuestionnaireSubmit>
            </div>
          </div>
        </Questionnaire>
      </DialogContent>
    </Dialog>
  );
}
