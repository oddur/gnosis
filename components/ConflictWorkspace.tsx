import { LoadingIndicator } from './LoadingState';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { CodeView, EditProvider, File } from '@pierre/diffs/react';
import {
  ArrowRight,
  CheckCheck,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  ExternalLink,
  RotateCcw,
} from 'lucide-react';
import { Button } from './ui/button';
import { RestackReview } from './RestackReview';
import { StepCard, StepList } from './StepCard';
import { conflictSteps } from '../lib/action-steps';
import { ToastHost } from './ui/toast';
import { BranchBadge, CommitBadge, PrBadge, RepositoryBadge } from './EntityBadge';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import {
  ConflictView,
  DiffColumns,
  ResultDiff,
  ResultEditor,
  createEditor,
  useCodeOptions,
  useElementWidth,
  type ConflictViewHandle,
} from './ConflictBlocks';
import { ConflictSuggestMenu, useSuggestionModel, type SuggestEngine, type SuggestScope } from './ConflictSuggestMenu';
import { conflictCount, conflictLabels } from '../lib/conflict-blocks';
import { conflictFileAction, describeConflictError, type ConflictErrorCopy } from '../lib/conflict-flow';
import { workbenchStore } from '../lib/workbench-store';
import type { ActivityTask } from '../lib/activity';
import {
  hasConflictMarkers,
  conflictFileStage,
  type ConflictFile,
  type ConflictFileStage,
  type ConflictReply,
  type ConflictRequest,
  type ConflictSession,
} from '../lib/conflict-resolution';

const GUIDE_KEY = 'gnosis-conflict-guide';
const guideDismissed = () => {
  try {
    return localStorage.getItem(GUIDE_KEY) === 'dismissed';
  } catch {
    return false;
  }
};
const dismissGuide = () => {
  try {
    localStorage.setItem(GUIDE_KEY, 'dismissed');
  } catch {
    /* Optional preference. */
  }
};

const fileStageLabels = {
  conflicted: 'Conflicted',
  resolved: 'Resolved · needs review',
  reviewed: 'Reviewed',
} as const;
const fileStageIcons = { conflicted: CircleAlert, resolved: CircleDashed, reviewed: CheckCheck };
function FileStageBadge({ stage, conflicts }: { stage: ConflictFileStage; conflicts?: number }) {
  const Icon = fileStageIcons[stage];
  return (
    <span className="conflict-file-status" data-stage={stage}>
      <Icon size={13} aria-hidden="true" />
      {stage === 'conflicted' && conflicts
        ? `${conflicts} ${conflicts === 1 ? 'conflict' : 'conflicts'}`
        : fileStageLabels[stage]}
    </span>
  );
}

/** The PR author, from the queue the app already holds. Unknown authors get neutral copy. */
function findAuthor(url: string) {
  const queue = workbenchStore.getQueue();
  for (const subject of [...queue.items.map((item) => item.subject), ...(queue.stacks ?? [])])
    for (const member of subject.members) if (member.url === url && member.author) return member.author;
  return undefined;
}

/** Live progress for the conflict operation that is running in Activity. */
function useConflictActivity(targets: (string | undefined)[], enabled: boolean) {
  const [task, setTask] = useState<ActivityTask>();
  const key = targets.filter(Boolean).join('\n');
  useEffect(() => {
    if (!enabled) {
      setTask(undefined);
      return;
    }
    let live = true;
    const wanted = new Set(key.split('\n'));
    const read = async () => {
      try {
        const tasks = await window.electronAPI.listActivity();
        const match = tasks.find(
          (entry) => entry.conflictTarget && wanted.has(entry.conflictTarget) && entry.status === 'running'
        );
        if (live) setTask(match);
      } catch {
        /* Progress is optional; the operation itself reports failures. */
      }
    };
    void read();
    const stop = window.electronAPI.onActivityChanged?.(() => void read());
    const timer = setInterval(() => void read(), 1500);
    return () => {
      live = false;
      clearInterval(timer);
      stop?.();
    };
  }, [key, enabled]);
  return task;
}

function useElapsed(running: boolean, after: number) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    setLate(false);
    if (!running) return;
    const timer = setTimeout(() => setLate(true), after);
    return () => clearTimeout(timer);
  }, [running, after]);
  return late;
}

function ErrorPanel({
  copy,
  actions,
  focus = false,
}: {
  copy: ConflictErrorCopy;
  actions?: React.ReactNode;
  focus?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus, copy.title]);
  return (
    <div ref={ref} className="conflict-error" role="alert" tabIndex={-1}>
      <CircleAlert size={16} aria-hidden="true" />
      <div>
        <p className="conflict-error-title">{copy.title}</p>
        {copy.body && <p>{copy.body}</p>}
        {actions && <div className="conflict-error-actions">{actions}</div>}
        {copy.details && (
          <details className="conflict-error-details">
            <summary>Details</summary>
            <pre>{copy.details}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

/** Estimated height for a virtualized diff list inside a scrolling card. */
function diffHeight(files: { hunks: { additionCount: number; deletionCount: number }[] }[], max = 480) {
  const lines = files.reduce(
    (height, file) =>
      height +
      60 +
      file.hunks.reduce((sum, hunk) => sum + Math.max(hunk.additionCount, hunk.deletionCount) + 1, 0) * 20,
    0
  );
  return Math.min(max, Math.max(100, lines));
}

function PreviewDiff({
  id,
  files,
  before,
  after,
}: {
  id: string;
  files: NonNullable<ConflictReply['preview']>['files'];
  before: string;
  after: string;
}) {
  const options = useCodeOptions();
  const root = useRef<HTMLDivElement>(null);
  const width = useElementWidth(root);
  const split = width === 0 || width >= 720;
  const diffOptions = useMemo(
    () => ({ ...options, diffStyle: split ? ('split' as const) : ('unified' as const) }),
    [options, split]
  );
  const items = useMemo(
    () => files.map((fileDiff, i) => ({ id: `${id}:${i}`, type: 'diff' as const, fileDiff })),
    [files, id]
  );
  return (
    <div ref={root} className="conflict-preview-diff">
      <DiffColumns split={split} before={before} after={after} />
      <CodeView
        className="conflict-preview selectable"
        items={items}
        options={diffOptions}
        style={{ height: diffHeight(files), overflow: 'auto' }}
      />
    </div>
  );
}

export function ConflictWorkspace({ url, onClose }: { url: string; onClose: () => void }) {
  const options = useCodeOptions();
  const model = useSuggestionModel();
  const restackDrafts = useRef<Record<string, string>>({});
  const [restackDirty, setRestackDirty] = useState(false);
  const [session, setSessionState] = useState<ConflictSession>();
  const sessionRef = useRef<ConflictSession>(undefined);
  const setSession = (value: ConflictSession) => {
    sessionRef.current = value;
    setSessionState(value);
  };
  const [selected, setSelectedState] = useState('');
  const selectedRef = useRef('');
  const [contents, setContentsState] = useState('');
  const contentsRef = useRef('');
  const setContents = (value: string) => {
    contentsRef.current = value;
    setContentsState(value);
  };
  const [mode, setMode] = useState<'conflicts' | 'edit' | 'result'>('conflicts');
  const [epoch, setEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'failed'>('idle');
  const [error, setError] = useState('');
  const [failedKind, setFailedKind] = useState<ConflictRequest['kind'] | 'open'>();
  const [preview, setPreview] = useState<ConflictReply['preview']>();
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState('');
  const [resetPrompt, setResetPrompt] = useState(false);
  const [outcome, setOutcome] = useState('');
  const [hint, setHint] = useState('');
  const [guideOpen, setGuideOpen] = useState(() => !guideDismissed());
  // The draft each file had when its result was last shown next to the PR. Mark reviewed needs it.
  const [shown, setShown] = useState<Record<string, string>>({});
  const view = useRef<ConflictViewHandle>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  const focusIntent = useRef(true);
  const author = useMemo(() => (session ? findAuthor(session.url) : undefined), [session?.url]);

  const file = session?.files.find((f) => f.path === selected);
  const fileStates = useMemo(
    () =>
      session?.files.map((f) => {
        const text = f.path === selected ? contents : f.result;
        return { file: f, stage: conflictFileStage(f, text), conflicts: f.unsupported ? 0 : conflictCount(text) };
      }) ?? [],
    [session, selected, contents]
  );
  const reviewedCount = fileStates.filter((s) => s.stage === 'reviewed').length;
  const fileStage = fileStates.find(({ file: f }) => f.path === selected)?.stage;
  const pendingFiles = fileStates.filter((s) => s.stage !== 'reviewed').length;
  const nextPending = (
    from: string,
    states: { file: ConflictSession['files'][number]; stage: ConflictFileStage }[] = fileStates
  ) => {
    const index = states.findIndex((s) => s.file.path === from);
    const ordered = [...states.slice(index + 1), ...states.slice(0, Math.max(0, index))];
    return ordered.find((s) => s.stage !== 'reviewed' && !s.file.unsupported)?.file;
  };
  const markersRemain = hasConflictMarkers(contents);
  const resultShown = !!file && shown[file.path] === contents;
  const action = conflictFileAction({
    stage: fileStage,
    resultShown,
    otherFilesPending: !!nextPending(selected),
    unsupported: !!file?.unsupported,
  });
  const labels = useMemo(
    () => conflictLabels('merge', { head: session?.headBranch ?? 'PR', base: session?.baseBranch ?? 'base' }),
    [session?.headBranch, session?.baseBranch]
  );
  const dirty = (!!file && contents !== file.result) || restackDirty;

  function select(path: string, value: ConflictSession, nextMode?: typeof mode) {
    const next: ConflictFile | undefined = value.files.find((f) => f.path === path) ?? value.files.at(0);
    selectedRef.current = next?.path ?? '';
    setSelectedState(next?.path ?? '');
    setContents(next?.result ?? '');
    setEpoch((n) => n + 1);
    setMode(nextMode ?? (next && !next.unsupported && !hasConflictMarkers(next.result) ? 'result' : 'conflicts'));
    focusIntent.current = true;
  }
  function apply(reply: ConflictReply, selection = selectedRef.current, nextMode?: typeof mode) {
    setSession(reply.session);
    select(selection, reply.session, nextMode);
    setMessage((previous) => previous || `Merge ${reply.session.baseBranch} into ${reply.session.headBranch}`);
  }
  /** Saves the open draft and paused restack drafts. Saves run one at a time, in order. */
  function persist(): Promise<ConflictSession> {
    const run = async () => {
      const start = sessionRef.current;
      if (!start) throw new Error('Open the conflict workspace again.');
      let value = start;
      for (const [path, text] of Object.entries(restackDrafts.current)) {
        const saved = value.restack?.blocked?.files.find((f) => f.path === path);
        if (saved && saved.result !== text)
          value = (
            await window.electronAPI.conflictResolution({
              kind: 'restack-save',
              id: value.id,
              version: value.version,
              path,
              contents: text,
              resolved: false,
            })
          ).session;
      }
      restackDrafts.current = {};
      setRestackDirty(false);
      const path = selectedRef.current;
      const text = contentsRef.current;
      const current = value.files.find((f) => f.path === path);
      if (value.status === 'editing' && !value.stale && current && !current.unsupported && text !== current.result) {
        setSaveState('saving');
        value = (
          await window.electronAPI.conflictResolution({
            kind: 'save',
            id: value.id,
            version: value.version,
            path,
            contents: text,
            resolved: false,
          })
        ).session;
      }
      if (value !== sessionRef.current) setSession(value);
      setSaveState('idle');
      return value;
    };
    const next = saveChain.current.then(run, run);
    saveChain.current = next.catch(() => setSaveState('failed'));
    return next;
  }
  // Drafts save on their own; there is no Save button.
  useEffect(() => {
    if (!dirty || busy || !session || session.stale) return;
    // A failed save retries on its own, a little later.
    const timer = setTimeout(
      () => {
        if (!pending.current) void persist().catch(() => {});
      },
      saveState === 'failed' ? 3000 : 600
    );
    return () => clearTimeout(timer);
  }, [contents, dirty, busy, session, saveState]);

  async function run(
    build: (value: ConflictSession) => ConflictRequest,
    after: (reply: ConflictReply, request: ConflictRequest) => void
  ) {
    if (!sessionRef.current || pending.current) return false;
    pending.current = true;
    setBusy(true);
    setError('');
    setFailedKind(undefined);
    setHint('');
    let kind: ConflictRequest['kind'] | undefined;
    try {
      const saved = await persist();
      const request = build(saved);
      kind = request.kind;
      const reply = await window.electronAPI.conflictResolution(request);
      after(reply, request);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setFailedKind(kind);
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function load(restart = false) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setFailedKind(undefined);
    try {
      await saveChain.current;
      const reply = await window.electronAPI.conflictResolution({ kind: 'open', url, restart });
      setPreview(undefined);
      setConfirming(false);
      setShown({});
      apply(reply, selectedRef.current);
      setResetPrompt(false);
      setOutcome('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setFailedKind('open');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  function confirm() {
    void run(
      (s) => ({ kind: 'preview', id: s.id, version: s.version }),
      (reply) => {
        setSession(reply.session);
        setPreview(reply.preview);
        setConfirming(true);
      }
    );
  }
  function markReviewed() {
    if (!file || markersRemain || file.unsupported) return;
    if (!resultShown) {
      showResult();
      setHint('Check the result next to the PR, then mark the file reviewed.');
      return;
    }
    const path = selected;
    let finished = false;
    void run(
      (s) => ({ kind: 'save', id: s.id, version: s.version, path, contents, resolved: true }),
      (reply) => {
        const states = reply.session.files.map((f) => ({ file: f, stage: conflictFileStage(f) }));
        const next = nextPending(path, states);
        apply(reply, next?.path ?? path);
        finished = !next;
      }
    ).then((ok) => {
      // Every file is reviewed: go straight to the confirmation, which shows the final update.
      if (ok && finished) confirm();
    });
  }
  function showResult() {
    setMode('result');
    setEpoch((n) => n + 1);
  }
  useEffect(() => {
    if (mode === 'result' && file && !file.unsupported && !markersRemain)
      setShown((previous) => (previous[file.path] === contents ? previous : { ...previous, [file.path]: contents }));
  }, [mode, file, contents, markersRemain]);
  function chooseFile(path: string) {
    if (!sessionRef.current || pending.current || path === selected) return;
    void persist()
      .then((saved) => select(path, saved))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }
  function stepFile(direction: 1 | -1) {
    const files = session?.files ?? [];
    if (files.length < 2) return;
    const index = files.findIndex((f) => f.path === selected);
    chooseFile(files[(index + direction + files.length) % files.length].path);
  }
  function suggest(engine: SuggestEngine, scope: SuggestScope, instructions?: string) {
    const path = selected;
    void run(
      (s) => ({
        kind: 'resolve',
        engine,
        id: s.id,
        version: s.version,
        ...(scope === 'file' ? { path } : {}),
        ...(engine === 'agent' ? { instructions: instructions ?? '' } : {}),
      }),
      (reply, request) => {
        const proposed = reply.session.files.filter(
          (f) => !f.unsupported && (request.kind === 'resolve' && request.path ? f.path === request.path : !f.resolved)
        );
        const remaining = proposed.filter((f) => hasConflictMarkers(f.result)).length;
        const ready = proposed.length - remaining;
        const who = engine === 'mergiraf' ? 'Structural merge' : model.replace(/^the /, 'The ');
        setOutcome(
          proposed.length === 1
            ? remaining
              ? `${who} couldn’t resolve every conflict. Choose the rest yourself.`
              : `${who} suggested a result. Review it before you mark the file reviewed.`
            : `${who} suggested ${ready} of ${proposed.length} files. Review each result before you mark it reviewed.`
        );
        const current = reply.session.files.find((f) => f.path === path);
        apply(reply, path, current && !hasConflictMarkers(current.result) ? 'result' : 'conflicts');
      }
    );
  }
  async function close() {
    dismissGuide();
    // Long operations continue in Activity; their inputs were saved before starting.
    if (pending.current || !session || !dirty) {
      if (pending.current && dirty) {
        setError('Wait for your draft to finish saving before closing.');
        return;
      }
      onClose();
      return;
    }
    try {
      await persist();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Focus the first open conflict, or the next action, when a file opens. Never the Close button.
  useEffect(() => {
    if (!focusIntent.current || !session || confirming) return;
    focusIntent.current = false;
    requestAnimationFrame(() => {
      if (session.status !== 'editing') return;
      if (mode === 'conflicts' && view.current?.focusFirst()) return;
      primary.current?.focus();
    });
  }, [session, selected, epoch, confirming, mode]);
  const upToDateState = session?.status === 'editing' && !session.files.length && session.preparation === 'up-to-date';
  useEffect(() => {
    if ((session?.status === 'published' && !session.dependents?.length) || upToDateState)
      requestAnimationFrame(() => done.current?.focus());
  }, [session?.status, upToDateState]);

  const pushError = failedKind === 'publish' && error;
  const steps = session
    ? conflictSteps(session, {
        confirming,
        running: busy && confirming,
        failure: pushError ? { step: 'push', message: 'The push did not complete.' } : undefined,
      })
    : undefined;
  const activity = useConflictActivity([url, session?.id], busy);
  const slow = useElapsed(busy && !session, 5000);
  const canEdit = !!session && !!file && !file.unsupported && !busy && !session.stale && session.status === 'editing';
  const editing = session?.status === 'editing' && session.files.length > 0 && !confirming;
  const shortcutsActive = !!session && editing && !busy && !session.stale;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!shortcutsActive || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const origin = (event.nativeEvent.composedPath()[0] ?? event.target) as HTMLElement;
    if (origin.isContentEditable || origin.closest('input,textarea,select,[contenteditable=true],[role=menu],.conflict-suggest-menu')) return;
    const key = event.key;
    const handled = (() => {
      if (key === 'j' || key === 'k') {
        if (mode !== 'conflicts') setMode('conflicts');
        if (!view.current?.move(key === 'j' ? 1 : -1)) primary.current?.focus();
        return true;
      }
      if (key === '1' || key === '2' || key === '3') {
        if (mode !== 'conflicts' || !canEdit) return false;
        return !!view.current?.choose(key === '1' ? 'ours' : key === '2' ? 'theirs' : 'both');
      }
      if (key === 'm') {
        if (markersRemain) setHint('Resolve the remaining conflicts first.');
        else markReviewed();
        return true;
      }
      if (key === 'n' || key === 'p') {
        stepFile(key === 'n' ? 1 : -1);
        return true;
      }
      return false;
    })();
    if (handled) event.preventDefault();
  }

  const headLabel = session ? (author ? `@${author}’s ${session.headBranch}` : session.headBranch) : '';
  const ownBranch = !!session && !!author && author === session.account;
  const title = session
    ? `Bring ${session.baseBranch} into ${ownBranch ? `your ${session.headBranch}` : headLabel}`
    : 'Resolve conflicts';
  const errorCopy = error
    ? describeConflictError(error, {
        stage: failedKind === 'publish' ? 'push' : failedKind === 'open' ? 'prepare' : 'other',
        headBranch: session?.headBranch,
        baseBranch: session?.baseBranch,
      })
    : undefined;
  const recover = (copy: ConflictErrorCopy) =>
    copy.recovery === 'load-latest' ? (
      <Button size="sm" disabled={busy} onClick={() => void load(true)}>
        Load latest changes
      </Button>
    ) : copy.recovery === 'check-again' ? (
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>
        Check again
      </Button>
    ) : copy.recovery === 'retry' ? (
      <Button size="sm" disabled={busy} onClick={() => void load()}>
        Try again
      </Button>
    ) : undefined;
  const upToDate = session?.status === 'editing' && !session.files.length && session.preparation === 'up-to-date';
  const showRail = !!steps && !!session && !upToDate && !(session.stale && !session.files.length);

  const primaryButton = (() => {
    if (!session || !file || session.stale) return null;
    const common = { ref: primary, size: 'sm' as const, 'data-conflict-primary': action };
    switch (action) {
      case 'next-conflict':
        return (
          <Button
            {...common}
            disabled={busy}
            aria-keyshortcuts="J"
            onClick={() => {
              if (mode !== 'conflicts') {
                setMode('conflicts');
                focusIntent.current = true;
                setEpoch((n) => n + 1);
              } else view.current?.move(1);
            }}
          >
            Next conflict
            <kbd className="kbd" aria-hidden="true">
              J
            </kbd>
          </Button>
        );
      case 'review-result':
        return (
          <Button {...common} disabled={busy} onClick={showResult}>
            Review result
          </Button>
        );
      case 'mark-reviewed':
        return (
          <Button {...common} disabled={busy || !canEdit} aria-keyshortcuts="M" onClick={markReviewed}>
            {nextPending(selected) ? 'Mark reviewed & next file' : 'Mark reviewed'}
            <kbd className="kbd" aria-hidden="true">
              M
            </kbd>
          </Button>
        );
      case 'next-file':
        return (
          <Button
            {...common}
            disabled={busy}
            aria-keyshortcuts="N"
            onClick={() => {
              const next = nextPending(selected);
              if (next) chooseFile(next.path);
            }}
          >
            Next file
            <kbd className="kbd" aria-hidden="true">
              N
            </kbd>
          </Button>
        );
      case 'confirm':
        return (
          <Button {...common} disabled={busy} onClick={confirm}>
            Review and push…
          </Button>
        );
      default:
        return null;
    }
  })();
  const footerStatus = busy
    ? activity?.detail || 'Working…'
    : hint ||
      outcome ||
      (session
        ? markersRemain && fileStates.find((s) => s.file.path === selected)?.conflicts
          ? `${fileStates.find((s) => s.file.path === selected)?.conflicts} ${
              fileStates.find((s) => s.file.path === selected)?.conflicts === 1 ? 'conflict' : 'conflicts'
            } left in this file · ${reviewedCount} of ${session.files.length} files reviewed`
          : `${reviewedCount} of ${session.files.length} ${session.files.length === 1 ? 'file' : 'files'} reviewed`
        : '');

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <DialogContent
        ref={dialog}
        className="conflict-workspace"
        data-conflict-url={url}
        data-conflict-id={session?.id}
        showCloseButton={false}
        tabIndex={-1}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          dialog.current?.focus();
        }}
        onKeyDown={onKeyDown}
      >
        <div className="conflict-heading">
          <div>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {session ? (
                <>
                  <RepositoryBadge repo={session.baseRepo} /> <PrBadge url={session.url} title={session.title} />{' '}
                  <span className="conflict-heading-title">{session.title}</span>
                </>
              ) : (
                'Gnosis prepares the merge privately. Your checkout stays unchanged.'
              )}
            </DialogDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void close()}>
            {busy && !session ? 'Close · keeps preparing' : busy ? 'Continue in background' : 'Close'}
          </Button>
        </div>
        <ToastHost />
        {showRail && (
          <div className="conflict-workflow">
            <StepList
              compact
              steps={steps.steps.map((step) => ({ ...step, error: undefined }))}
              current={steps.current}
              label="Steps to update this PR"
            />
            {editing && (
              <>
                <span className="conflict-save-state" role="status">
                  {saveState === 'failed'
                    ? 'Couldn’t save · retrying'
                    : dirty || saveState === 'saving'
                      ? 'Saving…'
                      : 'Saved'}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={guideOpen}
                  aria-controls="conflict-help"
                  onClick={() => {
                    if (guideOpen) dismissGuide();
                    setGuideOpen(!guideOpen);
                  }}
                >
                  <CircleHelp aria-hidden="true" />
                  {guideOpen ? 'Hide guide' : 'Guide'}
                </Button>
              </>
            )}
          </div>
        )}
        {!session ? (
          busy ? (
            <div className="conflict-state" role="status">
              <LoadingIndicator announce={false}>Preparing the merge…</LoadingIndicator>
              <p>{activity?.detail || 'Reading the PR and its base branch.'}</p>
              {slow && (
                <p className="conflict-state-muted">
                  Large repositories can take a minute. You can close this window; preparation continues in Activity.
                </p>
              )}
              {slow && activity?.canCancel && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void window.electronAPI.activityAction(activity.id, 'cancel')}
                >
                  Cancel preparation
                </Button>
              )}
            </div>
          ) : (
            <div className="conflict-state" data-state="failed">
              {errorCopy ? (
                <ErrorPanel copy={errorCopy} actions={recover(errorCopy)} focus />
              ) : (
                <p>The merge could not be prepared.</p>
              )}
            </div>
          )
        ) : session.status === 'published' ? (
          <div
            className="conflict-published"
            data-restack={!!session.dependents?.length}
            data-compact={!!session.restack || undefined}
          >
            {session.restack ? (
              // While restacking, the outcome stays one line so the restack has room.
              <section className="conflict-outcome" aria-labelledby="conflict-outcome-title">
                <CircleCheck size={16} aria-hidden="true" />
                <p className="conflict-outcome-line">
                  <strong id="conflict-outcome-title">{session.headBranch} updated</strong>
                  {session.commitSha && (
                    <span>
                      Merge commit <CommitBadge sha={session.commitSha} repo={session.headRepo} />
                    </span>
                  )}
                  <span className="conflict-outcome-undo">
                    To undo, reset to <CommitBadge sha={session.headSha} repo={session.headRepo} />
                  </span>
                  <a href={session.url} target="_blank" rel="noreferrer">
                    Open PR on GitHub
                  </a>
                </p>
              </section>
            ) : (
              <section className="conflict-outcome" aria-labelledby="conflict-outcome-title">
                <CircleCheck size={20} aria-hidden="true" />
                <div>
                  <h2 id="conflict-outcome-title">{session.headBranch} updated</h2>
                  <ul className="conflict-outcome-facts">
                    {session.commitSha && (
                      <li>
                        Merge commit <CommitBadge sha={session.commitSha} repo={session.headRepo} />
                      </li>
                    )}
                    <li>
                      {session.files.length
                        ? `${session.files.length} ${session.files.length === 1 ? 'file' : 'files'} resolved by you`
                        : 'No conflicts to resolve'}
                    </li>
                    <li>{session.baseBranch}’s changes included</li>
                    <li>Checks restarting on GitHub</li>
                  </ul>
                  <p className="conflict-outcome-undo">
                    To undo, reset {session.headBranch} to <CommitBadge sha={session.headSha} repo={session.headRepo} />
                  </p>
                  <div className="conflict-outcome-actions">
                    {!session.dependents?.length && (
                      <Button ref={done} size="sm" onClick={() => void close()}>
                        Done
                      </Button>
                    )}
                    <Button size="sm" variant="outline" asChild>
                      <a href={session.url} target="_blank" rel="noreferrer">
                        Open PR on GitHub
                        <ExternalLink aria-hidden="true" />
                      </a>
                    </Button>
                  </div>
                </div>
              </section>
            )}
            {session.stale && (
              <ErrorPanel
                copy={{
                  title: 'The branches changed since this restack was prepared.',
                  body: 'Nothing was pushed to the dependent PRs. Start over to restack the latest code.',
                }}
                actions={
                  resetPrompt ? (
                    <>
                      <Button size="sm" disabled={busy} onClick={() => void load(true)}>
                        Start over
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setResetPrompt(false)}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => setResetPrompt(true)}>
                      Start over with latest code…
                    </Button>
                  )
                }
              />
            )}
            {!!session.dependents?.length && (
              <RestackReview
                session={session}
                busy={busy}
                options={options}
                error={failedKind?.startsWith('restack-') ? error : undefined}
                failedKind={failedKind === 'open' ? undefined : failedKind}
                onRecheck={() => void load()}
                onSkip={() => void close()}
                onDrafts={(drafts) => {
                  restackDrafts.current = drafts;
                  setRestackDirty(
                    Object.entries(drafts).some(
                      ([path, text]) => session.restack?.blocked?.files.find((f) => f.path === path)?.result !== text
                    )
                  );
                }}
                onContinue={() =>
                  void run(
                    (s) => ({ kind: 'restack-continue', id: s.id, version: s.version }),
                    (reply) => apply(reply)
                  )
                }
                onSave={(path, text, resolved) =>
                  void run(
                    (s) => ({ kind: 'restack-save', id: s.id, version: s.version, path, contents: text, resolved }),
                    (reply) => apply(reply)
                  )
                }
                onPrepare={() =>
                  void run(
                    (s) => ({ kind: 'restack-prepare', id: s.id, version: s.version }),
                    (reply) => apply(reply)
                  )
                }
                onPublish={(previewToken, reviewed) =>
                  void run(
                    (s) => ({ kind: 'restack-publish', id: s.id, version: s.version, previewToken, reviewed }),
                    (reply) => apply(reply)
                  )
                }
              />
            )}
          </div>
        ) : confirming && preview && steps ? (
          <div className="conflict-confirm">
            <StepCard
              autoFocus
              showSteps={false}
              title={<h2>Push the merge commit to {session.headBranch}</h2>}
              steps={steps.steps}
              current={steps.current}
              busy={busy}
              onBack={() => {
                setConfirming(false);
                setError('');
                setFailedKind(undefined);
                focusIntent.current = true;
              }}
              backLabel={session.files.length ? 'Back to files' : 'Back'}
              status="Nothing is pushed until you select Push."
              continueLabel={busy ? 'Pushing…' : 'Push merge commit'}
              continueDisabled={!message.trim() || failedKind === 'publish'}
              onContinue={() =>
                void run(
                  (s) => ({ kind: 'publish', id: s.id, version: s.version, previewToken: preview.token, message }),
                  (reply) => {
                    setSession(reply.session);
                    setConfirming(false);
                  }
                )
              }
            >
              {pushError && errorCopy && <ErrorPanel copy={errorCopy} actions={recover(errorCopy)} focus />}
              <ul className="conflict-confirm-facts">
                <li>
                  {ownBranch ? (
                    <>
                      Pushes to your branch <BranchBadge branch={session.headBranch} repo={session.headRepo} />.
                    </>
                  ) : (
                    <>
                      Pushes to {author ? `@${author}’s` : 'the author’s'} branch{' '}
                      <BranchBadge branch={session.headBranch} repo={session.headRepo} />. They’ll see a merge commit
                      from you.
                    </>
                  )}
                </li>
                <li>Approvals may be dismissed if the repository requires it.</li>
                <li>
                  Pushes only if the branch is still at <code>{session.headSha.slice(0, 7)}</code>. The PR stays open;
                  checks run again.
                </li>
              </ul>
              <label className="conflict-confirm-message">
                Merge commit message
                <input value={message} maxLength={2000} disabled={busy} onChange={(e) => setMessage(e.target.value)} />
              </label>
              <ConfirmDiff session={session} preview={preview} />
            </StepCard>
          </div>
        ) : !session.files.length ? (
          <div className="conflict-state" role="status">
            {session.stale ? (
              <>
                <h2>The branches changed</h2>
                <p>
                  {session.headBranch} or {session.baseBranch} changed since this was prepared. Nothing was pushed.
                </p>
                <Button size="sm" disabled={busy} onClick={() => void load(true)}>
                  Load latest changes
                </Button>
              </>
            ) : upToDate ? (
              <>
                <CircleCheck size={24} aria-hidden="true" className="conflict-state-ok" />
                <h2>
                  {session.headBranch} already includes {session.baseBranch}
                </h2>
                <p>There’s nothing to merge. The PR is up to date with its base branch.</p>
                <div className="conflict-state-actions">
                  <Button ref={done} size="sm" autoFocus onClick={() => void close()}>
                    Done
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void load()}>
                    Check again
                  </Button>
                </div>
              </>
            ) : (
              <>
                <CircleCheck size={24} aria-hidden="true" className="conflict-state-ok" />
                <h2>No conflicts to resolve</h2>
                <p>
                  Git can bring {session.baseBranch} into {session.headBranch} cleanly. Review the changes, then push.
                </p>
                <Button ref={primary} size="sm" disabled={busy} onClick={confirm}>
                  {busy ? 'Preparing…' : 'Review and push…'}
                </Button>
              </>
            )}
            {errorCopy && <ErrorPanel copy={errorCopy} actions={recover(errorCopy)} />}
          </div>
        ) : (
          <>
            <div className="conflict-body">
              <nav aria-label="Files" className="conflict-files">
                {fileStates.map(({ file: f, stage, conflicts }) => (
                  <button
                    key={f.path}
                    disabled={busy}
                    aria-current={f.path === selected ? 'true' : undefined}
                    onClick={() => chooseFile(f.path)}
                  >
                    <span title={f.path}>{f.path}</span>
                    <small>
                      {f.unsupported ? (
                        <span className="conflict-file-limitation">Needs a local merge tool</span>
                      ) : (
                        <FileStageBadge stage={stage} conflicts={conflicts} />
                      )}
                    </small>
                  </button>
                ))}
              </nav>
              <section className="conflict-file-pane" aria-label={file ? `File ${file.path}` : 'File'}>
                {file && (
                  <>
                    <header className="conflict-file-header">
                      <div className="conflict-file-title">
                        <strong>{file.path}</strong>
                        {fileStage && !file.unsupported && <FileStageBadge stage={fileStage} />}
                      </div>
                      {!file.unsupported && (
                        <div className="conflict-file-tools">
                          <div className="conflict-modes" role="group" aria-label="View">
                            {(['conflicts', 'edit', 'result'] as const).map((value) => (
                              <Button
                                key={value}
                                size="sm"
                                variant={mode === value ? 'secondary' : 'ghost'}
                                disabled={busy}
                                aria-pressed={mode === value}
                                onClick={() => {
                                  setMode(value);
                                  setEpoch((n) => n + 1);
                                  if (value === 'conflicts') focusIntent.current = true;
                                }}
                              >
                                {value === 'conflicts'
                                  ? 'Choose changes'
                                  : value === 'edit'
                                    ? 'Edit result'
                                    : 'Review result'}
                              </Button>
                            ))}
                          </div>
                          <ConflictSuggestMenu
                            disabled={!canEdit}
                            fileName={file.path.split('/').pop() ?? file.path}
                            pendingFiles={pendingFiles}
                            model={model}
                            onSuggest={suggest}
                          />
                          {contents !== file.original && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={!canEdit}
                              onClick={() => {
                                setContents(file.original);
                                setMode('conflicts');
                                setEpoch((n) => n + 1);
                                focusIntent.current = true;
                              }}
                            >
                              <RotateCcw aria-hidden="true" />
                              Reset file
                            </Button>
                          )}
                        </div>
                      )}
                    </header>
                    <div className="conflict-scroll selectable" inert={busy || session.stale}>
                      {guideOpen && (
                        <div id="conflict-help" className="conflict-help">
                          <ol>
                            <li>
                              <strong>Choose what to keep</strong> in each conflict: the PR’s change,{' '}
                              {session.baseBranch}’s change, or both. Use Edit result to write your own.
                            </li>
                            <li>
                              <strong>Review the result</strong> next to the PR, then mark the file reviewed.
                              Suggestions never mark files reviewed.
                            </li>
                            <li>
                              <strong>Confirm and push.</strong> Gnosis adds a merge commit to the PR branch. It doesn’t
                              merge the PR.
                            </li>
                          </ol>
                          <p className="conflict-help-keys">
                            <kbd className="kbd">J</kbd> <kbd className="kbd">K</kbd> next or previous conflict ·{' '}
                            <kbd className="kbd">1</kbd> <kbd className="kbd">2</kbd> <kbd className="kbd">3</kbd> keep
                            PR, {session.baseBranch} or both · <kbd className="kbd">M</kbd> mark reviewed ·{' '}
                            <kbd className="kbd">N</kbd> <kbd className="kbd">P</kbd> next or previous file
                          </p>
                        </div>
                      )}
                      {file.unsupported ? (
                        <div className="conflict-state">
                          <p>{file.unsupported}</p>
                          <Button size="sm" variant="outline" asChild>
                            <a href={session.url} target="_blank" rel="noreferrer">
                              Open PR on GitHub
                              <ExternalLink aria-hidden="true" />
                            </a>
                          </Button>
                        </div>
                      ) : (
                        <>
                          {file.source !== 'manual' && contents === file.result && (
                            <details className="conflict-proposal" open={!!file.explanation}>
                              <summary>
                                {file.source === 'rerere'
                                  ? 'Reused a resolution you reviewed before'
                                  : file.source === 'mergiraf'
                                    ? 'Suggested by structural merge'
                                    : `Suggested by ${model}`}{' '}
                                · Not tested
                              </summary>
                              {file.explanation && <p>{file.explanation}</p>}
                            </details>
                          )}
                          {mode === 'conflicts' ? (
                            hasConflictMarkers(file.original) || markersRemain ? (
                              <ConflictView
                                key={`${selected}:${epoch}`}
                                handle={view}
                                name={selected}
                                original={file.original}
                                contents={contents}
                                labels={labels}
                                shortcuts
                                disabled={!canEdit}
                                onChange={setContents}
                                onAllResolved={() => primary.current?.focus()}
                              />
                            ) : (
                              <File file={{ name: selected, contents }} options={options} />
                            )
                          ) : mode === 'edit' ? (
                            <EditProvider createEditor={createEditor}>
                              <ResultEditor
                                key={`${selected}:${epoch}`}
                                name={selected}
                                initial={contents}
                                onChange={setContents}
                              />
                            </EditProvider>
                          ) : markersRemain ? (
                            <p className="conflict-side-empty">
                              Resolve the remaining conflicts first. The result appears here when no conflict is left.
                            </p>
                          ) : (
                            <ResultDiff
                              name={selected}
                              before={file.ours}
                              after={contents}
                              beforeLabel={labels.ours}
                              afterLabel="Result after the merge"
                            />
                          )}
                        </>
                      )}
                    </div>
                  </>
                )}
              </section>
            </div>
            <footer className="conflict-footer">
              {session.stale ? (
                <>
                  <span className="conflict-footer-status" role="status">
                    {session.baseBranch} or {session.headBranch} changed since you started. Your resolutions are saved.
                  </span>
                  {resetPrompt ? (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setResetPrompt(false)}>
                        Cancel
                      </Button>
                      <Button size="sm" disabled={busy} onClick={() => void load(true)}>
                        Start over
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" disabled={busy} onClick={() => setResetPrompt(true)}>
                      Start over with latest code…
                    </Button>
                  )}
                </>
              ) : resetPrompt ? (
                <>
                  <span className="conflict-footer-status">
                    Start over with the latest code? Your current resolutions are replaced by a fresh merge.
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setResetPrompt(false)}>
                    Cancel
                  </Button>
                  <Button size="sm" disabled={busy} onClick={() => void load(true)}>
                    Start over
                  </Button>
                </>
              ) : (
                <>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setResetPrompt(true)}>
                    Start over with latest code…
                  </Button>
                  {error && errorCopy ? (
                    <span className="conflict-footer-status" data-error="" role="alert" title={errorCopy.details}>
                      {errorCopy.title} {errorCopy.body}
                    </span>
                  ) : (
                    <span className="conflict-footer-status" role="status">
                      {busy && <LoadingIndicator announce={false}>{footerStatus}</LoadingIndicator>}
                      {!busy && footerStatus}
                    </span>
                  )}
                  {primaryButton}
                </>
              )}
            </footer>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The final update, split into the files you resolved and the changes Git merged from the base. */
function ConfirmDiff({
  session,
  preview,
}: {
  session: ConflictSession;
  preview: NonNullable<ConflictReply['preview']>;
}) {
  const resolvedPaths = new Set(session.files.map((f) => f.path));
  const yours = preview.files.filter((f) => resolvedPaths.has(f.name) || (f.prevName && resolvedPaths.has(f.prevName)));
  const incoming = preview.files.filter((f) => !yours.includes(f));
  const [showIncoming, setShowIncoming] = useState(!yours.length);
  const before = `${session.headBranch} now`;
  const after = 'After the merge commit';
  return (
    <div className="conflict-confirm-diff">
      {!!yours.length && (
        <section>
          <h3>
            Your resolutions · {yours.length} {yours.length === 1 ? 'file' : 'files'}
          </h3>
          <PreviewDiff id="yours" files={yours} before={before} after={after} />
        </section>
      )}
      <section>
        <h3>
          <button
            type="button"
            className="conflict-disclosure"
            aria-expanded={showIncoming}
            onClick={() => setShowIncoming(!showIncoming)}
          >
            <ArrowRight size={14} aria-hidden="true" />
            Changes coming from {session.baseBranch} · {incoming.length} {incoming.length === 1 ? 'file' : 'files'}
          </button>
        </h3>
        {showIncoming &&
          (incoming.length ? (
            <PreviewDiff id="incoming" files={incoming} before={before} after={after} />
          ) : (
            <p className="conflict-side-empty">No other files change.</p>
          ))}
      </section>
      {preview.validation && (
        <details className="conflict-whitespace">
          <summary>Whitespace warnings</summary>
          <pre>{preview.validation}</pre>
        </details>
      )}
    </div>
  );
}
