import { preferencesUpdated } from './use-repository-settings';
import { useEffect, useRef, useState } from 'react';
import { initialSetup, normalizeSetup, type OnboardingState, type SetupDraft } from './onboarding';
import type { Preferences } from './types';
import type { QueueViewsState } from './saved-views';

export function useOnboarding(
  prefs: Preferences | null,
  login: string | null,
  views?: QueueViewsState,
  firstUse = true
) {
  const [state, setState] = useState<OnboardingState>({});
  const current = useRef(state);
  const [open, setOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [offerTour, setOfferTour] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const ready = !!prefs;
  const latest = useRef({ prefs, views, open });
  latest.current = { prefs, views, open };
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void window.electronAPI
      .loadOnboarding()
      .then((saved) => {
        if (!alive || latest.current.open) return;
        saved = { ...saved, draft: saved.draft ? normalizeSetup(saved.draft) : undefined };
        current.current = saved;
        setState(saved);
        const preferences = latest.current.prefs;
        if (firstUse && preferences && !preferences.firstRunSeen && !saved.paused && !saved.completed) {
          const next = { ...saved, draft: saved.draft ?? initialSetup(preferences, latest.current.views) };
          current.current = next;
          setState(next);
          setOpen(true);
        }
      })
      .catch(() => {
        if (alive) setError('Could not load setup progress. Run setup again to retry.');
      });
    return () => {
      alive = false;
    };
  }, [ready, login]);
  function persist(next: OnboardingState) {
    current.current = next;
    setState(next);
    const operation = writes.current.then(() => window.electronAPI.saveOnboarding(next, login));
    writes.current = operation.catch(() => {});
    return operation;
  }
  const change = (draft: SetupDraft) => {
    setError('');
    void persist({ ...current.current, draft }).catch(() =>
      setError('Could not save setup progress. Keep this window open and retry.')
    );
  };
  const start = () => {
    if (!prefs) return;
    setTourOpen(false);
    setOfferTour(false);
    setError('');
    const saved = current.current;
    const fresh = initialSetup(prefs, views);
    const draft =
      !saved.completed && saved.draft
        ? saved.draft
        : {
            ...fresh,
            goals: saved.draft?.goals ?? fresh.goals,
            start: saved.draft?.start ?? fresh.start,
            refinements: saved.draft?.refinements ?? fresh.refinements,
          };
    void persist({ ...saved, draft, completed: false, paused: false }).catch(() =>
      setError('Could not save setup progress. Try again.')
    );
    setOpen(true);
  };
  const pause = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await persist({ ...current.current, paused: true });
      setOpen(false);
    } catch {
      setError('Could not save setup progress. Try Finish later again.');
    } finally {
      setSaving(false);
    }
  };
  const apply = async (): Promise<Preferences | undefined> => {
    if (!current.current.draft || saving) return;
    setSaving(true);
    setError('');
    try {
      await writes.current;
      const nextPrefs = await window.electronAPI.applyOnboarding(current.current.draft, login);
      preferencesUpdated(nextPrefs);
      const next = { ...current.current, completed: true, paused: false, tourStep: 0, tourCompleted: false };
      current.current = next;
      setState(next);
      setOpen(false);
      setOfferTour(true);
      return nextPrefs;
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
          : 'Could not apply setup. Try again.'
      );
    } finally {
      setSaving(false);
    }
  };
  const startTour = () => {
    setOfferTour(false);
    setTourOpen(true);
  };
  const tourStep = (step: number) => {
    void persist({ ...current.current, tourStep: step }).catch(() => setError('Could not save walkthrough progress.'));
  };
  const endTour = (completed = false) => {
    setTourOpen(false);
    void persist({
      ...current.current,
      tourCompleted: completed,
      tourStep: completed ? 0 : current.current.tourStep,
    }).catch(() => setError('Could not save walkthrough progress.'));
  };
  return {
    state,
    open,
    tourOpen,
    offerTour,
    setOfferTour,
    saving,
    error,
    start,
    pause,
    apply,
    change,
    startTour,
    tourStep,
    endTour,
  };
}
