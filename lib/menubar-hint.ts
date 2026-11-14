/**
 * The menu bar panel's first-open tip: one quiet footer line that names the panel's keys and the icon's right-click
 * menu. Pure, so main and unit tests share one reading of the saved state.
 *
 * The tip shows on every open until it is dismissed or a row is opened from the panel, whichever comes first. Main
 * keeps the answer in the app's saved state (`MENUBAR_HINT_KEY`), app-wide rather than per account, and sends only
 * `hint: boolean` to the panel inside its state.
 */

/** A name outside `onboarding:<account>`, so no GitHub login can collide with it. */
export const MENUBAR_HINT_KEY = 'menubar-hint';

/** `dismissed`: the user closed the tip. `opened`: they opened a row, so they know the panel. */
export type MenubarHintDone = 'dismissed' | 'opened';
export interface MenubarHintState {
  done?: MenubarHintDone;
  at?: number;
}

export function normalizeMenubarHint(input: unknown): MenubarHintState {
  if (!input || typeof input !== 'object') return {};
  const raw = input as Record<string, unknown>;
  if (raw.done !== 'dismissed' && raw.done !== 'opened') return {};
  return { done: raw.done, ...(typeof raw.at === 'number' && Number.isFinite(raw.at) ? { at: raw.at } : {}) };
}

export const menubarHintVisible = (state: MenubarHintState): boolean => !state.done;

/** The first answer stays: a later open after a dismissal changes nothing, and nothing is written again. */
export function recordMenubarHint(state: MenubarHintState, done: MenubarHintDone, now: number): MenubarHintState {
  return state.done ? state : { done, at: now };
}
