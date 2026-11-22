import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bot,
  CheckCheck,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Info,
  Keyboard,
  Settings,
  TriangleAlert,
  X,
} from 'lucide-react';
import { Button } from './ui/button';
import type { BucketSummary } from '../lib/conflict-verify';
import type { ConflictTypeCheck } from '../lib/conflict-resolution';

/**
 * The Conflicts view's first-run help (#445 onboarding): the bucket key, the keys hint and the opt-in mentions. Each
 * is shown until you dismiss it, once per GitHub account on this computer.
 */
export type ConflictTip = 'buckets' | 'keys' | 'type-check' | 'undo';
const TIPS: readonly ConflictTip[] = ['buckets', 'keys', 'type-check', 'undo'];
export const conflictTipsKey = (account: string) => `gnosis:conflict-tips:${account}`;
/** Dismissals when storage is unavailable: they last until the window reloads. */
const sessionTips = new Map<string, Set<ConflictTip>>();

function readTips(key: string): Set<ConflictTip> {
  // No account yet (the session is still loading): nothing shows, so nothing flashes.
  if (!key) return new Set(TIPS);
  const held = sessionTips.get(key);
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    const seen = new Set(Array.isArray(stored) ? TIPS.filter((tip) => stored.includes(tip)) : []);
    for (const tip of held ?? []) seen.add(tip);
    return seen;
  } catch {
    return new Set(held);
  }
}

export function useConflictTips(account: string | undefined) {
  const key = account ? conflictTipsKey(account) : '';
  const [version, setVersion] = useState(0);
  // `version` re-reads storage after a dismissal.
  const seen = useMemo(() => readTips(key), [key, version]);
  const dismiss = useCallback(
    (tip: ConflictTip) => {
      if (!key) return;
      const next = [...new Set([...readTips(key), tip])];
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        sessionTips.set(key, new Set(next));
      }
      setVersion((v) => v + 1);
    },
    [key]
  );
  return { seen: (tip: ConflictTip) => seen.has(tip), dismiss };
}

/** Opens and closes the bucket key: the summary row's way back to it after the first run. */
export function ConflictGuideButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label="What Merged, Check and Decide mean"
      title="What Merged, Check and Decide mean"
      aria-expanded={open}
      aria-controls="conflict-guide"
      data-conflict-guide-toggle=""
      onClick={onToggle}
    >
      <Info aria-hidden="true" />
    </Button>
  );
}

/** One quiet line with an optional link and a dismiss button. */
function Note({
  icon,
  name,
  children,
  action,
  onDismiss,
}: {
  icon: React.ReactNode;
  name: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <p className="conflict-note" data-conflict-note={name}>
      {icon}
      <span>{children}</span>
      {action}
      {onDismiss && (
        <button type="button" className="conflict-note-dismiss" aria-label="Dismiss" onClick={onDismiss}>
          <X size={13} aria-hidden="true" />
        </button>
      )}
    </p>
  );
}

const TYPED = /\.(?:[cm]?ts|tsx)$/;
const SHORTCUT_KEYS = new Set(['j', 'k', '1', '2', '3', 'm', 'n', 'p']);

/**
 * Everything the Conflicts view explains under its summary sentence: the bucket key, the keys hint, the state of the
 * whole merge (all Merged, or a file Gnosis can't write) and the type check's mention. Nothing here changes a result.
 */
export function ConflictNotes({
  tips,
  guideOpen,
  onCloseGuide,
  model,
  summary,
  paths,
  typeCheck,
  localPath,
  onShowLocal,
  onSettings,
}: {
  tips: ReturnType<typeof useConflictTips>;
  guideOpen: boolean;
  onCloseGuide: () => void;
  model: string;
  summary: BucketSummary;
  /** Every conflicted file's path: the type check is mentioned only for TypeScript. */
  paths: readonly string[];
  typeCheck: ConflictTypeCheck | null | undefined;
  /** The first file Gnosis can't write, unless it is open already. */
  localPath?: string;
  onShowLocal: (path: string) => void;
  /** Opens this repository's settings, where both opt-ins live. */
  onSettings?: () => void;
}) {
  const keysHint = !tips.seen('keys');
  const { dismiss } = tips;
  // The hint goes with the first key you press: you have found them.
  useEffect(() => {
    if (!keysHint) return;
    const used = (e: globalThis.KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || target?.closest('input, textarea, [contenteditable=true]')) return;
      if (SHORTCUT_KEYS.has(e.key.toLowerCase())) dismiss('keys');
    };
    document.addEventListener('keydown', used, true);
    return () => document.removeEventListener('keydown', used, true);
  }, [keysHint, dismiss]);

  const allMerged =
    summary.conflicts > 0 && summary.merged === summary.conflicts && !summary.needs && !summary.checking;
  const typed = paths.some((path) => TYPED.test(path));
  const settingsLink = onSettings && (
    <Button size="xs" variant="link" className="conflict-note-link" onClick={onSettings}>
      <Settings aria-hidden="true" />
      Repository settings
    </Button>
  );
  return (
    <div className="conflict-notes">
      {guideOpen && (
        <section
          id="conflict-guide"
          className="conflict-guide"
          aria-label="How Gnosis sorts conflicts"
          data-conflict-guide=""
        >
          <dl>
            <div>
              <dt className="conflict-bucket" data-bucket="merged">
                <CheckCheck size={13} aria-hidden="true" />
                Merged
              </dt>
              <dd>Gnosis resolved it and every check passed. Nothing to do, but you can still change it.</dd>
            </div>
            <div>
              <dt className="conflict-bucket" data-bucket="check">
                <CircleHelp size={13} aria-hidden="true" />
                Check
              </dt>
              <dd>Gnosis has a proposal it couldn’t prove. Nothing is chosen until you use it or pick a side.</dd>
            </div>
            <div>
              <dt className="conflict-bucket" data-bucket="decide">
                <CircleAlert size={13} aria-hidden="true" />
                Decide
              </dt>
              <dd>No proposal. Keep one side, keep both, or edit.</dd>
            </div>
          </dl>
          <p className="conflict-guide-foot">
            <Bot size={13} aria-hidden="true" />
            <span>
              {model} proposes only when you ask, and its proposals stay in Check. Nothing is pushed until you push.
            </span>
            <Button size="xs" variant="outline" onClick={onCloseGuide} data-conflict-guide-close="">
              Got it
            </Button>
          </p>
        </section>
      )}
      {keysHint && (
        <Note name="keys" icon={<Keyboard size={13} aria-hidden="true" />} onDismiss={() => dismiss('keys')}>
          Keys: <kbd className="kbd">J</kbd> <kbd className="kbd">K</kbd> next and previous conflict ·{' '}
          <kbd className="kbd">1</kbd> <kbd className="kbd">2</kbd> <kbd className="kbd">3</kbd> keep a side or both ·{' '}
          <kbd className="kbd">M</kbd> mark reviewed
        </Note>
      )}
      {allMerged && (
        <Note name="all-merged" icon={<CircleCheck size={13} aria-hidden="true" className="conflict-state-ok" />}>
          Gnosis proved every conflict. Review and push, or look through them first.
        </Note>
      )}
      {summary.local > 0 && (
        <Note
          name="local"
          icon={<TriangleAlert size={13} aria-hidden="true" />}
          action={
            localPath && (
              <Button size="xs" variant="link" className="conflict-note-link" onClick={() => onShowLocal(localPath)}>
                Show the commands
              </Button>
            )
          }
        >
          Gnosis pushes only a complete merge, and {summary.local === 1 ? '1 file' : `${summary.local} files`} here
          can’t be merged as text. Merge this PR on your computer.
        </Note>
      )}
      {typed && typeCheck === null && !tips.seen('type-check') && (
        <Note
          name="type-check"
          icon={<Info size={13} aria-hidden="true" />}
          action={settingsLink}
          onDismiss={() => dismiss('type-check')}
        >
          Gnosis can also type-check the merge in your linked clone of this repository. It’s off.
        </Note>
      )}
      {(typeCheck?.state === 'unchecked' || typeCheck?.state === 'skipped') && (
        <Note name="type-check-unavailable" icon={<Info size={13} aria-hidden="true" />}>
          The type check didn’t run on this draft. Merged results passed Gnosis’s other checks.
        </Note>
      )}
    </div>
  );
}

/** The push confirmation's mention of Undo after push while it is off for the repository. */
export function ConflictUndoTip({
  tips,
  onSettings,
}: {
  tips: ReturnType<typeof useConflictTips>;
  onSettings?: () => void;
}) {
  if (tips.seen('undo')) return null;
  return (
    <li className="conflict-note" data-conflict-note="undo">
      <span>Undo after push is off for this repository, so you’d undo this push on GitHub or in Git.</span>
      {onSettings && (
        <Button size="xs" variant="link" className="conflict-note-link" onClick={onSettings}>
          <Settings aria-hidden="true" />
          Repository settings
        </Button>
      )}
      <button type="button" className="conflict-note-dismiss" aria-label="Dismiss" onClick={() => tips.dismiss('undo')}>
        <X size={13} aria-hidden="true" />
      </button>
    </li>
  );
}

/** Seconds since preparation started, after the first five: a long preparation shows it is still moving. */
export function PreparingElapsed({ since }: { since?: string }) {
  const [mounted] = useState(() => Date.now());
  const start = (since && Date.parse(since)) || mounted;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  if (seconds < 5) return null;
  const text = seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  return (
    <p className="conflict-state-muted conflict-elapsed" data-conflict-elapsed="">
      {text} so far
    </p>
  );
}
