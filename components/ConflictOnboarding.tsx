import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
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
 * The Conflicts view's first-run help (#445 onboarding): one key panel (buckets, keys, the type check) and the push
 * confirmation's Undo mention. Each shows until you dismiss it, once per GitHub account on this computer.
 */
export type ConflictTip = 'buckets' | 'undo';
const TIPS: readonly ConflictTip[] = ['buckets', 'undo'];
export const conflictTipsKey = (account: string) => `gnosis:conflict-tips:${account}`;

function readTips(key: string): Set<ConflictTip> {
  // No account yet (the session is still loading): nothing shows, so nothing flashes.
  if (!key) return new Set(TIPS);
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return new Set(Array.isArray(stored) ? TIPS.filter((tip) => stored.includes(tip)) : []);
  } catch {
    return new Set();
  }
}

export function useConflictTips(account: string | undefined) {
  const key = account ? conflictTipsKey(account) : '';
  const [stored, setStored] = useState(() => ({ key, seen: readTips(key) }));
  const seen = stored.key === key ? stored.seen : readTips(key);
  const dismiss = useCallback(
    (tip: ConflictTip) => {
      if (!key) return;
      const next = new Set([...readTips(key), tip]);
      try {
        localStorage.setItem(key, JSON.stringify([...next]));
      } catch {
        /* Storage unavailable: dismissed until the view closes. */
      }
      setStored({ key, seen: next });
    },
    [key]
  );
  return { seen: (tip: ConflictTip) => seen.has(tip), dismiss };
}

/**
 * A control that is about to unmount hands focus back to the view, so its keys keep working: to `target`, else the
 * Conflicts view itself.
 */
function keepFocus(event: MouseEvent<HTMLElement>, target?: HTMLElement | null) {
  (target ?? event.currentTarget.closest<HTMLElement>('.conflict-workspace'))?.focus({ preventScroll: true });
}

/** Opens and closes the bucket key: the summary row's way back to it after the first run. */
export function ConflictGuideButton({ id, open, onToggle }: { id: string; open: boolean; onToggle: () => void }) {
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label="What Merged, Check and Decide mean"
      title="What Merged, Check and Decide mean"
      aria-expanded={open}
      aria-controls={id}
      data-conflict-guide-toggle=""
      onClick={onToggle}
    >
      <Info aria-hidden="true" />
    </Button>
  );
}

/** One quiet status line with an optional action. */
function Note({
  icon,
  name,
  children,
  action,
}: {
  icon: React.ReactNode;
  name: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <p className="conflict-note" role="status" data-conflict-note={name}>
      {icon}
      <span>{children}</span>
      {action}
    </p>
  );
}

/** The view's own narrow layout (760px is a shipping size): the key starts as one line there. */
const NARROW = '(max-width: 899px)';
function useNarrow() {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  useEffect(() => {
    const query = window.matchMedia(NARROW);
    const change = () => setNarrow(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  return narrow;
}
const Keys = ({ keys }: { keys: string[] }) =>
  keys.map((k) => (
    <kbd key={k} className="kbd">
      {k}
    </kbd>
  ));

/**
 * Everything the Conflicts view explains under its summary sentence: the first-run key (buckets, keys and the type
 * check's mention, in one panel), the state of the whole merge (all Merged, or a file Gnosis can't write) and a type
 * check that couldn't run. Nothing here changes a result.
 */
export function ConflictNotes({
  guideId,
  guideOpen,
  guideAsked,
  onCloseGuide,
  model,
  summary,
  stale,
  typed,
  typeCheck,
  localPath,
  onShowLocal,
  onSettings,
  onAllKeys,
}: {
  guideId: string;
  guideOpen: boolean;
  /** Opened from the summary row's help button: shown in full at any width. */
  guideAsked: boolean;
  onCloseGuide: () => void;
  model: string;
  summary: BucketSummary;
  /** The PR changed since the merge was prepared: what it says about the merge no longer holds. */
  stale: boolean;
  /** The PR has TypeScript conflicts: only then is the type check mentioned. */
  typed: boolean;
  typeCheck: ConflictTypeCheck | null | undefined;
  /** The first file Gnosis can't write, unless it is open already. */
  localPath?: string;
  onShowLocal: (path: string) => void;
  /** Opens this repository's settings, where the type check is turned on. */
  onSettings?: () => void;
  /** Opens the full legend under this view's keyboard button. */
  onAllKeys: () => void;
}) {
  const narrow = useNarrow();
  const [expanded, setExpanded] = useState(false);
  const compact = narrow && !guideAsked && !expanded;
  const panel = useRef<HTMLElement>(null);
  // Expanding replaces the button that had focus: the panel takes it.
  useEffect(() => {
    if (expanded) panel.current?.focus({ preventScroll: true });
  }, [expanded]);
  // Merged is proved only with every check in: the type check is off, or passed for this draft.
  const typeCheckSettled = typeCheck === null || typeCheck?.state === 'passed';
  const allMerged =
    !stale &&
    typeCheckSettled &&
    summary.conflicts > 0 &&
    summary.merged === summary.conflicts &&
    !summary.needs &&
    !summary.checking;
  const sentence = model.charAt(0).toUpperCase() + model.slice(1);
  const gotIt = (
    <Button
      size="xs"
      variant="outline"
      onClick={(e) => {
        keepFocus(e);
        onCloseGuide();
      }}
      data-conflict-guide-close=""
    >
      Got it
    </Button>
  );
  return (
    <div className="conflict-notes">
      {guideOpen && (
        <section
          ref={panel}
          id={guideId}
          tabIndex={-1}
          className="conflict-guide"
          aria-label="How Gnosis sorts conflicts"
          data-conflict-guide={compact ? 'compact' : 'full'}
        >
          {compact ? (
            <p className="conflict-guide-line">
              <button
                type="button"
                className="conflict-guide-expand"
                aria-expanded="false"
                onClick={() => setExpanded(true)}
              >
                <span className="conflict-bucket" data-bucket="merged">
                  Merged
                </span>
                {' · '}
                <span className="conflict-bucket" data-bucket="check">
                  Check
                </span>
                {' · '}
                <span className="conflict-bucket" data-bucket="decide">
                  Decide
                </span>
                : what these mean
              </button>
              {gotIt}
            </p>
          ) : (
            <>
              <dl>
                <div>
                  <dt className="conflict-bucket" data-bucket="merged">
                    <CheckCheck size={13} aria-hidden="true" />
                    Merged
                  </dt>
                  <dd>Structural merge or one of Gnosis’s rules resolved it, and the checks passed. Nothing to do, but you can still change it.</dd>
                </div>
                <div>
                  <dt className="conflict-bucket" data-bucket="check">
                    <CircleHelp size={13} aria-hidden="true" />
                    Check
                  </dt>
                  <dd>There is a proposal the checks couldn’t prove. Nothing is chosen until you use it or pick a side.</dd>
                </div>
                <div>
                  <dt className="conflict-bucket" data-bucket="decide">
                    <CircleAlert size={13} aria-hidden="true" />
                    Decide
                  </dt>
                  <dd>No proposal. Keep one side, keep both, or edit.</dd>
                </div>
              </dl>
              <p className="conflict-guide-more">
                <Bot size={13} aria-hidden="true" />
                <span>
                  {sentence} proposes only when you ask, and its proposals stay in Check. Nothing is pushed until you
                  push.
                </span>
              </p>
              <p className="conflict-guide-more conflict-guide-last">
                <span data-conflict-guide-keys="">
                  <Keyboard size={13} aria-hidden="true" />
                  <Keys keys={['J', 'K']} /> move · <Keys keys={['A']} /> use the proposal · <Keys keys={['1', '2', '3']} /> keep
                  · <Keys keys={['M']} /> mark reviewed ·{' '}
                  <button type="button" className="conflict-guide-link" onClick={onAllKeys}>
                    All keys
                  </button>
                </span>
                {typed && typeCheck === null && (
                  <span data-conflict-guide-type-check="">
                    <Info size={13} aria-hidden="true" />
                    Gnosis can also type-check the merge in your linked clone. It’s off.{' '}
                    {onSettings && (
                      <button type="button" className="conflict-guide-link" onClick={onSettings}>
                        Repository settings
                      </button>
                    )}
                  </span>
                )}
              </p>
              <div className="conflict-guide-close">{gotIt}</div>
            </>
          )}
        </section>
      )}
      {allMerged && (
        <Note name="all-merged" icon={<CircleCheck size={13} aria-hidden="true" className="conflict-state-ok" />}>
          The checks proved every conflict. Review and push, or look through them first.
        </Note>
      )}
      {!stale && summary.local > 0 && (
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
      {!stale && (typeCheck?.state === 'unchecked' || typeCheck?.state === 'skipped') && (
        <Note name="type-check-unavailable" icon={<Info size={13} aria-hidden="true" />}>
          The type check didn’t run on this draft. Merged results passed the other checks.
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
      <span>Undo after push is off for this repository, so undoing this push would need someone who can force-push the branch.</span>
      {onSettings && (
        <Button size="xs" variant="link" className="conflict-note-link" onClick={onSettings}>
          <Settings aria-hidden="true" />
          Repository settings
        </Button>
      )}
      <button
        type="button"
        className="conflict-note-dismiss"
        aria-label="Dismiss: Undo after push mention"
        onClick={(e) => {
          keepFocus(e, e.currentTarget.closest<HTMLElement>('[tabindex]'));
          tips.dismiss('undo');
        }}
      >
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
