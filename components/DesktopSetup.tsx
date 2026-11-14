import { useEffect, useId, useRef, useState } from 'react';
import { BatteryFull, Bell, Check, Lightbulb, Wifi, X } from 'lucide-react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import {
  Questionnaire,
  QuestionnaireDescription,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from './ui/questionnaire';
import {
  desktopSteps,
  menubarHelp,
  notificationHelp,
  type DesktopOutcome,
  type DesktopSetupState,
  type DesktopStep,
  type MenubarShowResult,
  type SystemSettingsPanes,
} from '../lib/desktop-setup';
import { MENUBAR_BADGES, menubarSettings, type MenubarBadge } from '../lib/menubar-settings';
import { preferencesUpdated } from '../lib/use-repository-settings';
import type { Preferences } from '../lib/types';

/** Which System Settings panes main can open here. Nothing until main answers. */
export function useSystemSettingsPanes(): SystemSettingsPanes {
  const [panes, setPanes] = useState<SystemSettingsPanes>({ notifications: false, menubar: false });
  useEffect(() => {
    let live = true;
    void Promise.resolve()
      .then(() => window.electronAPI.systemSettingsPanes())
      .then((next) => {
        if (live) setPanes(next);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return panes;
}

async function savePreferencePatch(patch: Partial<Preferences>) {
  const current = await window.electronAPI.loadPreferences();
  const next = { ...current, ...patch };
  await window.electronAPI.savePreferences(next);
  preferencesUpdated(next);
  return next;
}

/** Moves focus to a newly shown question or answer, so keyboard users are not left on a removed button. */
function useFocusOnChange<T extends HTMLElement>(key: string) {
  const ref = useRef<T>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    ref.current?.focus({ preventScroll: false });
  }, [key]);
  return ref;
}

type NotificationPhase = 'start' | 'sending' | 'ask' | 'help' | 'done' | 'in-app';

/** Setup step: turn on notifications with one test notification, then confirm it arrived. */
export function NotificationsSetupItem({
  platform,
  panes,
  outcome,
  onOutcome,
  onLater,
}: {
  platform: string;
  panes: SystemSettingsPanes;
  outcome?: DesktopOutcome;
  onOutcome: (outcome: DesktopOutcome) => void;
  /** In the full setup: skip this step. The standalone dialog has its own Set up later. */
  onLater?: () => void;
}) {
  const [phase, setPhase] = useState<NotificationPhase>(
    outcome === 'completed' ? 'done' : outcome === 'not-seen' ? 'help' : 'start'
  );
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const sending = useRef(false);
  const focus = useFocusOnChange<HTMLDivElement>(phase === 'sending' ? '' : phase);
  const questionId = useId();
  const mac = platform === 'darwin';
  /** Exactly one notification per click: the first turns desktop notifications on, later ones are tests. */
  const send = async (first: boolean) => {
    if (sending.current) return;
    sending.current = true;
    const previous = phase;
    setPhase('sending');
    setError('');
    try {
      const result = first
        ? await window.electronAPI.notificationIntroduce(true)
        : await window.electronAPI.sendTestNotification();
      setSent(true);
      if (result === 'desktop') setPhase('ask');
      else if (result === 'toast') {
        setPhase('in-app');
        onOutcome('completed');
      } else {
        setPhase('help');
        onOutcome('not-seen');
      }
    } catch {
      setPhase(previous);
      setError('Could not send a test notification. Try again.');
    } finally {
      sending.current = false;
    }
  };
  const openSettings = () => {
    setError('');
    void window.electronAPI
      .openSystemSettings('notifications')
      .then((opened) => {
        if (!opened) setError('Could not open notification settings. Open them from your system settings.');
      })
      .catch(() => setError('Could not open notification settings. Open them from your system settings.'));
  };
  return (
    <QuestionnaireItem name="notifications">
      <QuestionnaireTitle>Get notified when a PR needs you</QuestionnaireTitle>
      <QuestionnaireDescription>
        Gnosis tells you once when your review is requested, when your PRs are approved, need changes, fail checks
        or are ready to merge, and when an explanation is ready. Nothing in a notification writes to GitHub.
      </QuestionnaireDescription>
      {(phase === 'start' || (phase === 'sending' && !sent)) && (
        <div className="setup-desktop-start">
          <Button type="button" className="self-start" disabled={phase === 'sending'} onClick={() => void send(true)}>
            <Bell size={15} aria-hidden="true" />
            {phase === 'sending' ? 'Sending…' : 'Turn on notifications'}
          </Button>
          <p className="setup-note">
            {mac
              ? 'Gnosis sends one test notification. If macOS asks, choose Allow.'
              : 'Gnosis sends one test notification.'}
          </p>
        </div>
      )}
      {(phase === 'ask' || (phase === 'sending' && sent)) && (
        <div ref={focus} tabIndex={-1} className="setup-desktop-question" role="group" aria-labelledby={questionId}>
          <p id={questionId}>Gnosis sent a test notification. Did you see it?</p>
          <div className="setup-desktop-actions">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={phase === 'sending'}
              onClick={() => {
                setPhase('done');
                onOutcome('completed');
              }}
            >
              Yes
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={phase === 'sending'}
              onClick={() => {
                setPhase('help');
                onOutcome('not-seen');
              }}
            >
              No
            </Button>
          </div>
        </div>
      )}
      {phase === 'done' && (
        <div ref={focus} tabIndex={-1} className="setup-desktop-result" role="status">
          <p className="setup-connected">
            <Check size={18} aria-hidden="true" />
            Notifications are on.
          </p>
          <p className="setup-note">Choose which events notify you in Settings › Notifications.</p>
        </div>
      )}
      {phase === 'in-app' && (
        <div ref={focus} tabIndex={-1} className="setup-desktop-result" role="status">
          <p className="setup-note">
            This system cannot show desktop notifications, so Gnosis shows them inside the app.
          </p>
        </div>
      )}
      {phase === 'help' && (
        <div ref={focus} tabIndex={-1} className="setup-desktop-help" role="group" aria-label="Allow notifications">
          <p>{notificationHelp(platform)}</p>
          <div className="setup-desktop-actions">
            {panes.notifications && (
              <Button type="button" variant="outline" size="sm" onClick={openSettings}>
                Open notification settings
              </Button>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={() => void send(false)}>
              Send again
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p className="setup-error" role="alert">
          {error}
        </p>
      )}
      {onLater && !outcome && (
        <Button type="button" variant="ghost" className="self-start" onClick={onLater}>
          Set up later
        </Button>
      )}
    </QuestionnaireItem>
  );
}

export const MENUBAR_BADGE_LABELS: Readonly<Record<MenubarBadge, string>> = {
  new: 'New since you last looked',
  all: 'Everything that needs you',
  dot: 'A dot only',
  none: 'Nothing',
};
/** Illustrative counts for the preview strip. */
const PREVIEW_COUNT: Readonly<Record<MenubarBadge, string>> = { new: '2', all: '5', dot: '', none: '' };

/** A drawn slice of the menu bar: the Gnosis icon with the chosen number. Decorative; the choices carry meaning. */
function MenubarPreview({ badge }: { badge: MenubarBadge }) {
  return (
    <div className="setup-menubar-preview" aria-hidden="true">
      <span className="setup-menubar-item">
        <span className="setup-menubar-icon">
          <Lightbulb size={15} strokeWidth={2} />
          {badge === 'dot' && <span className="setup-menubar-dot" />}
        </span>
        {PREVIEW_COUNT[badge] && <span className="setup-menubar-count">{PREVIEW_COUNT[badge]}</span>}
      </span>
      <Wifi size={15} className="setup-menubar-system" />
      <BatteryFull size={17} className="setup-menubar-system" />
      <span>Fri 9:41</span>
    </div>
  );
}

const SHOW_MESSAGE: Readonly<Record<Exclude<MenubarShowResult, 'off'>, string>> = {
  shown: 'The summary panel is open under the icon. Click anywhere else to close it.',
  menu: 'Your icon opens the classic menu. To use the summary panel, choose it in Settings › Notifications.',
  hidden: 'Gnosis could not find its icon in the menu bar. If you cannot see it either, choose No.',
  unsupported: 'The summary panel is available on macOS.',
};

/** Setup step, macOS only: where the menu bar icon is, what its panel shows, and what its number counts. */
export function MenubarSetupItem({
  panes,
  outcome,
  onOutcome,
  onLater,
}: {
  panes: SystemSettingsPanes;
  outcome?: DesktopOutcome;
  onOutcome: (outcome: DesktopOutcome) => void;
  onLater?: () => void;
}) {
  const [badge, setBadge] = useState<MenubarBadge>('new');
  const [answer, setAnswer] = useState<'yes' | 'no' | undefined>(
    outcome === 'completed' ? 'yes' : outcome === 'not-seen' ? 'no' : undefined
  );
  const [shown, setShown] = useState<MenubarShowResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const focus = useFocusOnChange<HTMLDivElement>(answer ?? '');
  const questionId = useId();
  const badgeId = useId();
  useEffect(() => {
    let live = true;
    void Promise.resolve()
      .then(() => window.electronAPI.loadPreferences())
      .then((prefs) => {
        if (live) setBadge(menubarSettings(prefs).badge);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const show = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.electronAPI.showMenubarPanel();
      setShown(result);
    } catch {
      setError('Could not open the panel. Click the Gnosis icon in the menu bar instead.');
    } finally {
      setBusy(false);
    }
  };
  const turnOn = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await savePreferencePatch({ trayEnabled: true });
      setBusy(false);
      await show();
    } catch {
      setError('Could not turn on the menu bar icon. Try again, or turn it on in Settings › Integrations.');
    } finally {
      setBusy(false);
    }
  };
  const chooseBadge = (next: MenubarBadge) => {
    const previous = badge;
    setBadge(next);
    setError('');
    void window.electronAPI
      .loadPreferences()
      .then((prefs) => savePreferencePatch({ menubarSettings: { ...menubarSettings(prefs), badge: next } }))
      .catch(() => {
        setBadge(previous);
        setError('Could not save your choice. Try again.');
      });
  };
  const openSettings = () => {
    setError('');
    void window.electronAPI
      .openSystemSettings('menubar')
      .then((opened) => {
        if (!opened) setError('Could not open Menu Bar settings. Open System Settings › Menu Bar instead.');
      })
      .catch(() => setError('Could not open Menu Bar settings. Open System Settings › Menu Bar instead.'));
  };
  return (
    <QuestionnaireItem name="menubar">
      <QuestionnaireTitle>See what needs you from the menu bar</QuestionnaireTitle>
      <QuestionnaireDescription>
        Click the Gnosis icon in the menu bar for a summary: PRs to review, your PRs to fix, and PRs ready to merge.
        Choose one to open it in Gnosis.
      </QuestionnaireDescription>
      <div className="setup-menubar-demo">
        <MenubarPreview badge={badge} />
        <Button type="button" variant="outline" disabled={busy} onClick={() => void show()}>
          Show me
        </Button>
      </div>
      {shown && shown !== 'off' && (
        <p className="setup-note" role="status">
          {SHOW_MESSAGE[shown]}
        </p>
      )}
      {shown === 'off' && (
        <div className="setup-desktop-help" role="status">
          <p>The menu bar icon is off.</p>
          <div className="setup-desktop-actions">
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void turnOn()}>
              Turn on the icon
            </Button>
          </div>
        </div>
      )}
      <div className="setup-desktop-question" role="group" aria-labelledby={questionId}>
        <p id={questionId}>Can you see the Gnosis icon in your menu bar?</p>
        <div className="setup-desktop-actions">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={answer === 'yes'}
            onClick={() => {
              setAnswer('yes');
              onOutcome('completed');
            }}
          >
            Yes
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={answer === 'no'}
            onClick={() => {
              setAnswer('no');
              onOutcome('not-seen');
            }}
          >
            No
          </Button>
        </div>
      </div>
      {answer === 'yes' && (
        <div ref={focus} tabIndex={-1} className="setup-desktop-result" role="status">
          <p className="setup-connected">
            <Check size={18} aria-hidden="true" />
            The menu bar icon is ready.
          </p>
          <p className="setup-note">Right-click it for Open Gnosis, Settings and Quit.</p>
        </div>
      )}
      {answer === 'no' && (
        <div ref={focus} tabIndex={-1} className="setup-desktop-help" role="group" aria-label="Find the menu bar icon">
          <p>{menubarHelp(panes.menubar)}</p>
          {panes.menubar && (
            <div className="setup-desktop-actions">
              <Button type="button" variant="outline" size="sm" onClick={openSettings}>
                Open menu bar settings
              </Button>
            </div>
          )}
        </div>
      )}
      <div className="setup-badge" role="radiogroup" aria-labelledby={badgeId} aria-describedby={`${badgeId}-note`}>
        <p id={badgeId} className="setup-badge-title">
          Number on the icon
        </p>
        {MENUBAR_BADGES.map((value) => (
          <label key={value} className="setup-check">
            <input
              type="radio"
              name="setup-menubar-badge"
              value={value}
              checked={badge === value}
              onChange={() => chooseBadge(value)}
            />
            {MENUBAR_BADGE_LABELS[value]}
          </label>
        ))}
        <p id={`${badgeId}-note`} className="setup-note">
          Saved right away. Also shown on the Dock icon.
        </p>
      </div>
      {error && (
        <p className="setup-error" role="alert">
          {error}
        </p>
      )}
      {onLater && !outcome && (
        <Button type="button" variant="ghost" className="self-start" onClick={onLater}>
          Set up later
        </Button>
      )}
    </QuestionnaireItem>
  );
}

/**
 * The same steps on their own, from Help, Settings, or the one-time prompt for people who finished setup before
 * these steps existed. Closing at any point is fine; nothing here blocks the app.
 */
export function DesktopSetupDialog({
  platform,
  state,
  onOutcome,
  onClose,
}: {
  platform: string;
  state?: DesktopSetupState;
  onOutcome: (step: DesktopStep, outcome: DesktopOutcome) => void;
  onClose: () => void;
}) {
  const steps = desktopSteps(platform);
  const answered = steps.every((step) => state?.[step] === 'completed');
  const [active, setActive] = useState<DesktopStep>(steps[0]);
  const panes = useSystemSettingsPanes();
  const mac = platform === 'darwin';
  const skipUnanswered = (upTo: number) => {
    for (const step of steps.slice(0, upTo)) if (!state?.[step]) onOutcome(step, 'skipped');
  };
  const move = (step: string) => {
    const next = steps.indexOf(step as DesktopStep);
    if (next < 0) return;
    if (next > steps.indexOf(active)) skipUnanswered(next);
    setActive(step as DesktopStep);
  };
  const finish = () => {
    skipUnanswered(steps.length);
    onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="setup-dialog setup-dialog-desktop" showCloseButton={false}>
        <div className="setup-heading">
          <div>
            <DialogTitle>{mac ? 'Notifications and menu bar' : 'Notifications'}</DialogTitle>
            <DialogDescription>
              {mac
                ? 'Get notified when a PR needs you, and see what is waiting from the menu bar.'
                : 'Get notified when a PR needs you.'}
            </DialogDescription>
          </div>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
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
            const index = steps.indexOf(active);
            if (index < steps.length - 1) move(steps[index + 1]);
            else finish();
          }}
        >
          {steps.length > 1 && <QuestionnaireProgress className="setup-progress" />}
          <div className="setup-body">
            <NotificationsSetupItem
              platform={platform}
              panes={panes}
              outcome={state?.notifications}
              onOutcome={(outcome) => onOutcome('notifications', outcome)}
            />
            {steps.includes('menubar') && (
              <MenubarSetupItem
                panes={panes}
                outcome={state?.menubar}
                onOutcome={(outcome) => onOutcome('menubar', outcome)}
              />
            )}
          </div>
          <div className="setup-actions">
            <Button type="button" variant="ghost" onClick={finish}>
              {answered ? 'Close' : 'Set up later'}
            </Button>
            <div>
              {steps.length > 1 && <QuestionnairePrevious>Back</QuestionnairePrevious>}
              <QuestionnaireNext
                onClick={(event) => {
                  event.preventDefault();
                  move(steps[steps.indexOf(active) + 1]);
                }}
              >
                Next
              </QuestionnaireNext>
              <QuestionnaireSubmit
                onClick={(event) => {
                  event.preventDefault();
                  finish();
                }}
              >
                Done
              </QuestionnaireSubmit>
            </div>
          </div>
        </Questionnaire>
      </DialogContent>
    </Dialog>
  );
}
