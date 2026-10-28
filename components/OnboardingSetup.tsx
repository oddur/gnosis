import { GitHubIcon } from '../lib/constants';
import { useEffect, useState } from 'react';
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
import { SETUP_GOALS, SETUP_STEPS, setupViews, type SetupDraft, type SetupStep } from '../lib/onboarding';
import { normalizeQueueFilters } from '../lib/queue-filters';
import { PROVIDERS, PROVIDER_IDS, normalizeModelSelection, type Provider } from '../lib/models';
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
  const [cli, setCli] = useState<'checking' | 'found' | 'missing' | 'error'>('checking');
  const [retry, setRetry] = useState(0);
  const [linkError, setLinkError] = useState('');
  const patch = (next: Partial<SetupDraft>) => {
    setError('');
    onChange({ ...draft, ...next });
  };
  const steps = SETUP_STEPS.filter((step) => !draft.local || !['github', 'repositories', 'filters'].includes(step));
  const active = steps.includes(draft.step) ? draft.step : 'goals';
  useEffect(() => {
    if (active !== 'ai') return;
    let alive = true;
    setCli('checking');
    window.electronAPI
      .checkCliInstalled(draft.provider)
      .then((result) => {
        if (alive) setCli(result.installed ? 'found' : 'missing');
      })
      .catch(() => {
        if (alive) setCli('error');
      });
    return () => {
      alive = false;
    };
  }, [active, draft.provider, retry]);
  const validate = () => {
    if (active === 'goals' && !draft.local && !draft.goals.length)
      return 'Choose at least one goal, or use local reviews.';
    if (active === 'github' && !login) return 'Connect GitHub, or choose local reviews on the previous step.';
    if (active === 'repositories' && draft.goals.includes('repositories') && !draft.repositories.length)
      return 'Choose at least one repository for Repository activity.';
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
                You can read PRs and inspect diffs without AI. Explanations and chat use a tool installed on your
                computer.
              </QuestionnaireDescription>
              <div className="setup-models">
                <label className="setup-field">
                  AI tool
                  <SearchableSelect
                    label="AI tool"
                    value={draft.provider}
                    options={PROVIDER_IDS.map((id) => ({ value: id, label: PROVIDERS[id].label }))}
                    onValueChange={(value) =>
                      patch({ ...normalizeModelSelection(value as Provider, undefined), configureAI: true })
                    }
                  />
                </label>
                <label className="setup-field">
                  Model
                  <SearchableSelect
                    label="AI model"
                    value={draft.model}
                    options={PROVIDERS[draft.provider].models.map((model) => ({ value: model.id, label: model.label }))}
                    onValueChange={(model) =>
                      patch({ ...normalizeModelSelection(draft.provider, model), configureAI: true })
                    }
                  />
                </label>
              </div>
              <div className="setup-cli" role="status">
                {cli === 'checking'
                  ? 'Looking for the AI tool…'
                  : cli === 'found'
                    ? 'Tool found. Sign in through its terminal command before generating.'
                    : cli === 'missing'
                      ? 'Tool not found. You can install it later.'
                      : 'Could not check the tool. Retry or set it up later.'}
                <Button type="button" variant="ghost" size="sm" onClick={() => setRetry((value) => value + 1)}>
                  Check again
                </Button>
              </div>
              <Button
                type="button"
                variant="link"
                className="setup-link"
                onClick={() => {
                  setLinkError('');
                  void window.electronAPI
                    .openExternal(
                      draft.provider === 'claude'
                        ? 'https://code.claude.com/docs/en/setup'
                        : 'https://developers.openai.com/codex/cli/'
                    )
                    .catch(() => setLinkError('Could not open the guide. Try again.'));
                }}
              >
                Installation and sign-in guide <ArrowRight size={14} />
              </Button>
              {linkError && <p role="alert">{linkError}</p>}
              {!draft.local && (
                <>
                  <label className="setup-check">
                    <input
                      type="checkbox"
                      checked={draft.autoBriefings}
                      onChange={(event) =>
                        patch({
                          autoBriefings: event.target.checked,
                          configureAI: event.target.checked || draft.configureAI,
                        })
                      }
                    />
                    Create briefings automatically for my active view
                  </label>
                  {draft.autoBriefings && (
                    <label className="setup-field">
                      Daily briefing limit
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
                        Uses your selected model and AI account allowance. Full explanations still start only when you
                        ask.
                      </span>
                    </label>
                  )}
                </>
              )}
              <Button
                type="button"
                variant="ghost"
                onClick={() => patch({ autoBriefings: false, configureAI: false, step: 'finish' })}
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
                  <li>
                    AI model:{' '}
                    {PROVIDERS[draft.provider].models.find((model) => model.id === draft.model)?.label ?? draft.model}
                  </li>
                )}
                {!draft.local && (
                  <li>
                    {draft.repositories.length} repositories followed ·{' '}
                    {draft.days ? `updated within ${draft.days} days` : 'any update date'}
                  </li>
                )}
                {!draft.local && <li>{draft.ignoreDependabot ? 'Dependabot hidden' : 'Dependabot included'}</li>}
                <li>
                  {draft.autoBriefings && !draft.local
                    ? `Automatic briefings · up to ${draft.dailyLimit}/day · ${draft.model}`
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
                disabled={saving}
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
