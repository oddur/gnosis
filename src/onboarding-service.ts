import { applyViewAction, type QueueViewsState } from '../lib/saved-views';
import { normalizeSetup, setupPreferences, setupViews, type OnboardingState, type SetupDraft } from '../lib/onboarding';
import type { Preferences } from '../lib/types';
import type { StateStorage } from './app-data-store';

export function createOnboardingService(deps: {
  storage: StateStorage;
  account: () => string | null;
  preferences: () => Preferences;
  savePreferences: (preferences: Preferences) => void;
  views: () => QueueViewsState;
  replaceViews: (views: QueueViewsState) => void;
}) {
  const key = () => `onboarding:${(deps.account() ?? 'local').toLowerCase()}`;
  const assertAccount = (account: string | null) => {
    if (account !== deps.account()) throw new Error('The GitHub account changed. Reopen setup to continue.');
  };
  return {
    load: () => (deps.storage.read(key()) ?? {}) as OnboardingState,
    async save(state: OnboardingState, account: string | null) {
      assertAccount(account);
      const value: OnboardingState = {
        draft: state.draft ? normalizeSetup(state.draft) : undefined,
        paused: state.paused === true,
        completed: state.completed === true,
        tourStep:
          typeof state.tourStep === 'number' && Number.isInteger(state.tourStep)
            ? Math.min(3, Math.max(0, state.tourStep))
            : 0,
        tourCompleted: state.tourCompleted === true,
      };
      deps.storage.write(key(), value);
      await deps.storage.flush();
    },
    async apply(input: SetupDraft, account: string | null) {
      assertAccount(account);
      const draft = normalizeSetup(input);
      const oldPrefs = deps.preferences();
      const oldViews = structuredClone(deps.views());
      const storageKey = key();
      const oldProgress = deps.storage.read(storageKey) ?? {};
      // Validate every view before changing preferences or starting automatic work.
      const nextViews = draft.local
        ? oldViews
        : applyViewAction(
            oldViews,
            {
              type: 'setup',
              views: setupViews(draft),
              activeId: `setup:${draft.start}`,
            },
            () => {
              throw new Error('Setup views must have stable identities.');
            }
          );
      if (!draft.local && !account) throw new Error('Connect GitHub before applying repository setup.');
      const preferences = setupPreferences(oldPrefs, draft);
      let viewsWritten = false;
      try {
        if (!draft.local) {
          deps.replaceViews(nextViews);
          viewsWritten = true;
        }
        deps.savePreferences(preferences);
        deps.storage.write(storageKey, { draft, completed: true, paused: false, tourStep: 0, tourCompleted: false });
        await deps.storage.flush();
        return preferences;
      } catch {
        // Cross-store failures must not silently leave a half-configured queue.
        try {
          assertAccount(account);
          deps.savePreferences(oldPrefs);
          if (viewsWritten) deps.replaceViews(oldViews);
          deps.storage.write(storageKey, oldProgress);
          await deps.storage.flush();
        } catch {
          throw new Error(
            'Setup could not finish saving. Some settings may have changed. Reopen setup, check your choices, and apply again.'
          );
        }
        throw new Error('Could not save setup. Your previous settings are kept. Check disk space, then try again.');
      }
    },
  };
}
