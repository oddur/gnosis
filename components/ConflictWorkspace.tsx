import { LoadingIndicator } from './LoadingState';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { DropdownMenu, Popover } from 'radix-ui';
import type { DiffLineAnnotation } from '@pierre/diffs';
import { ConflictDiff, ConflictFileDiff, ConflictResult, lineRuns } from './ConflictDiff';
import type { Preferences } from '../lib/types';
import {
  ArrowRight,
  Bot,
  Check,
  CheckCheck,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  Copy,
  ExternalLink,
  Keyboard,
  RotateCcw,
  TriangleAlert,
} from 'lucide-react';
import { Button } from './ui/button';
import { RestackReview } from './RestackReview';
import { ConflictCascadeLine, useConflictCascade } from './ConflictCascade';
import { StepCard } from './StepCard';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { CONFLICT_SHORTCUTS } from '../lib/conflict-shortcuts';
import { conflictSteps } from '../lib/action-steps';
import { BranchBadge, CommitBadge, PrBadge } from './EntityBadge';
import { ConflictUndo } from './ConflictUndo';
import { undoTarget, unsettledUndoCopy } from '../lib/conflict-undo';
import { toast } from './ui/toast';
import { WrittenLegend, proposalWhat } from './ConflictCard';
import { useCodeOptions } from '../lib/use-code-options';
import type { ConflictViewHandle } from './useConflictChoices';
import { ConflictSuggestMenu, useSuggestionModel, type SuggestEngine } from './ConflictSuggestMenu';
import {
  conflictCount,
  conflictLabels,
  type BlockEdits,
  type BlockPicks,
  type ConflictLabels,
} from '../lib/conflict-blocks';
import { cardAnchors, resolverBaseline, writtenLabel } from '../lib/conflict-diff';
import {
  WRITTEN_BUDGET_MS,
  confirmCount,
  confirmGroups,
  confirmWritten,
  needsYou,
  patchNote,
  wholeNote,
  type ConfirmFile,
  type ConfirmGroups,
} from '../lib/conflict-confirm';
import type { GapHunk } from '../lib/diff-gaps';
import {
  canRetryStructural,
  conflictFileAction,
  localMergeCommands,
  describeBaseMove,
  describeConflictError,
  type ConflictErrorCopy,
} from '../lib/conflict-flow';
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
  type SavedBlockEdit,
  type ConflictTypeCheck,
} from '../lib/conflict-resolution';
import {
  conflictPushNeedsWorkflow,
  githubWriteError,
  scopePromptCopy,
  WORKFLOW_PUSH_WARNING,
} from '../lib/github-access';
import { useGitHubAccess } from '../lib/use-github-access';
import {
  blockBuckets,
  bucketSummary,
  proposalKey,
  fileStatus,
  fileStatusLine,
  fileStatusParts,
  allMerged,
  blockVerdict,
  summarySentence,
  unchosenConflicts,
  preparedDraft,
  waitingHint,
  type FileStatus,
  verifyProposals,
  verifyWholeFile,
  type ConflictBucket,
  type Verdict,
  typeCheckFor,
  typeErrorOf,
  withTypeError,
} from '../lib/conflict-verify';
import { disabledLanguages, verdictKey } from '../lib/conflict-verdict-key';
import { summaryEntry } from '../lib/conflict-header';
import { currentCodeIntelligence } from '../lib/use-syntax-contents';
import { useConflictChoiceStats } from '../lib/use-conflict-stats';
import { ModelProposalWaits, useConflictModel } from '../lib/use-conflict-model';
import { checkFormatting, checkSyntax } from '../lib/syntax-scope-client';
import { useRepositorySettings } from '../lib/use-repository-settings';
import { repositoryKey, type RepositorySettings } from '../lib/repository-settings';
import { GitHubScopeActions, GitHubScopePrompt } from './GitHubScopePrompt';
import { registerSettled, useVirtualizerSettled } from '../lib/test-settled';
import { useVirtualizer } from '@tanstack/react-virtual';

const statusIcons = {
  decide: CircleAlert,
  check: CircleHelp,
  merged: CheckCheck,
  proposal: CircleHelp,
  conflicted: CircleAlert,
  resolved: CircleDashed,
  reviewed: CheckCheck,
  unsupported: TriangleAlert,
} as const;
/**
 * A file's status (fileStatus in lib/conflict-verify.ts), the same in the file list and the file header: its conflicts
 * by bucket, or one stage. `data-stage` is the file's stage, or `proposal`.
 */
function FileStatusBadge({ status, stage }: { status: FileStatus; stage: ConflictFileStage }) {
  const parts = fileStatusParts(status).map(({ tone, text }) => {
    const Icon = statusIcons[tone];
    return { tone, text, icon: <Icon size={13} aria-hidden="true" /> };
  });
  if (status.kind === 'buckets')
    return (
      <span className="conflict-file-buckets" data-stage={stage} data-status={status.kind}>
        {parts.map(({ tone, text, icon }) => (
          <span key={tone} className="conflict-bucket" data-bucket={tone}>
            {icon}
            {text}
          </span>
        ))}
      </span>
    );
  const part = parts.at(0);
  if (!part) return null;
  return (
    <span
      className="conflict-file-status"
      data-stage={status.kind === 'proposal' || status.kind === 'unsupported' ? status.kind : stage}
      data-status={status.kind}
    >
      {part.icon}
      {part.text}
    </span>
  );
}

/**
 * A path that breaks only at its last `/`: when it doesn't fit, the file name goes to its own line and the folders are
 * cut with an ellipsis (in the file header it stays one line and the folders give way first). The full path is the
 * tooltip.
 */
function FilePath({ path }: { path: string }) {
  const cut = path.lastIndexOf('/') + 1;
  return (
    <span className="conflict-path" title={path}>
      {cut > 0 && <span className="conflict-path-dir">{path.slice(0, cut)}</span>}
      <span className="conflict-path-name">{path.slice(cut)}</span>
    </span>
  );
}

/** One way back in the Reset menu. `separated` starts the session's part: the fresh merge, after the file's. */
interface ResetItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  separated?: boolean;
  /** The item moves focus itself (Start over focuses the footer's Cancel): the menu doesn't return it to Reset. */
  movesFocus?: boolean;
}

/** Reset file, Start from Git's conflict, Try structural merge again and Start over, in one menu (#445 distill). */
function ResetMenu({ items, disabled }: { items: ResetItem[]; disabled: boolean }) {
  const moved = useRef(false);
  if (!items.length) return null;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button size="sm" variant="ghost" disabled={disabled} data-conflict-reset="">
          <RotateCcw aria-hidden="true" />
          Reset
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="pr-update-menu conflict-reset-menu"
          align="end"
          sideOffset={4}
          onCloseAutoFocus={(event) => {
            if (moved.current) event.preventDefault();
            moved.current = false;
          }}
        >
          {items.map((item, index) => (
            <Fragment key={item.label}>
              {item.separated && index > 0 && <DropdownMenu.Separator className="conflict-menu-separator" />}
              <DropdownMenu.Item
                disabled={item.disabled}
                onSelect={() => {
                  moved.current = !!item.movesFocus;
                  item.onSelect();
                }}
              >
                {item.label}
              </DropdownMenu.Item>
            </Fragment>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * Below 900px the file list gives its width to the code (#445 distill): the open file, its place and a list of every file
 * with its status, in a popover.
 */
function FilePicker({
  file,
  status,
  position,
  total,
  disabled,
  children,
}: {
  file?: ConflictFile;
  /** The open file's status, as its row in the list shows it: the band's one count of the file at this width. */
  status?: React.ReactNode;
  position: number;
  total: number;
  disabled: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button size="sm" variant="outline" disabled={disabled} className="conflict-file-picker" data-conflict-file-picker="">
          {file && <FilePath path={file.path} />}
          {status}
          {total > 1 && (
            <span className="conflict-file-picker-count">
              {position} of {total}
            </span>
          )}
          <ChevronDown aria-hidden="true" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          collisionPadding={12}
          aria-label="Files"
          className="conflict-files conflict-file-picker-menu z-50 rounded-md border bg-popover text-popover-foreground shadow-md"
          // A choice closes the list; the file opens behind it.
          onClick={(event) => {
            if ((event.target as Element).closest('button')) setOpen(false);
          }}
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The workspace's shortcuts, on hover or focus: the same list as the keyboard shortcut overlay. */
function KeyboardHelp() {
  return (
    <TooltipProvider delayDuration={350}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label="Keyboard shortcuts" data-conflict-keys="">
            <Keyboard aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" className="conflict-keys">
          <dl>
            {CONFLICT_SHORTCUTS.map(({ keys, label }) => (
              <div key={keys}>
                <dt>
                  {keys.split(/\s+/).map((k) => (
                    <kbd key={k} className="kbd">
                      {k.toUpperCase()}
                    </kbd>
                  ))}
                </dt>
                <dd>{label}</dd>
              </div>
            ))}
          </dl>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** The type check's one line (#445 item 24), "Type check: …". */
export function typeCheckLine(status: ConflictTypeCheck) {
  switch (status.state) {
    case 'waiting':
      return 'Type check: waiting for your changes';
    case 'running':
      return 'Type check: running…';
    case 'passed':
      return 'Type check: passed';
    case 'errors':
      return `Type check: ${status.count} new ${status.count === 1 ? 'error' : 'errors'}`;
    case 'skipped':
      return `Type check: skipped (${status.reason})`;
    case 'unchecked':
      return `Type check: couldn’t check (${status.reason})`;
    case 'cancelled':
      return 'Type check: stopped';
  }
}

/**
 * The opt-in type check's status in the summary row (#445 item 24). New errors list on hover or focus: those in a
 * conflicted file keep its proposals in Check, the rest are for your information. A running check can be stopped.
 */
function TypeCheckStatus({ status, onStop }: { status: ConflictTypeCheck; onStop: () => void }) {
  const line = typeCheckLine(status);
  const detail =
    status.state === 'errors'
      ? status.errors
      : status.state === 'passed' && status.preExisting
        ? []
        : undefined;
  const already =
    (status.state === 'errors' || status.state === 'passed') && status.preExisting
      ? `Not counted: ${status.preExisting} ${status.preExisting === 1 ? 'error' : 'errors'} the PR or its base already has.`
      : undefined;
  return (
    <span className="conflict-type-check" role="status" data-type-check={status.state}>
      {detail ? (
        <TooltipProvider delayDuration={350}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="conflict-type-check-detail">
                {line}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="end" className="conflict-type-check-errors">
              {status.state === 'errors' && (
                <>
                  <p>Any new error keeps every merged conflict in Check: an error in one file can come from a conflict in another.</p>
                  <ul>
                    {detail.map((error, i) => (
                      <li key={i}>{error}</li>
                    ))}
                  </ul>
                  {status.count > detail.length && <p>{status.count - detail.length} more not shown.</p>}
                </>
              )}
              {already && <p>{already}</p>}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        line
      )}
      {(status.state === 'running' || status.state === 'waiting') && (
        <Button size="xs" variant="ghost" onClick={onStop}>
          Stop
        </Button>
      )}
    </span>
  );
}

/**
 * A conflict Gnosis can't write as text (a rename on both sides, a deletion, a binary file). The whole merge then
 * happens on your computer: say why, and give the commands that start it.
 */
function LocalMerge({ session, reason }: { session: ConflictSession; reason: string }) {
  // Names come from the PR's author: quoted, and no commands at all for a name a shell could read as code.
  const commands = localMergeCommands(session);
  const [copied, setCopied] = useState(false);
  return (
    <div className="conflict-local" data-conflict-local="">
      <h2>Merge this PR on your computer</h2>
      {commands ? (
        <>
          <p>
            {reason} Gnosis pushes only a merge it can resolve completely, so this PR needs a local merge. In a clone of{' '}
            {session.headRepo}, run:
          </p>
          <pre className="selectable">{commands}</pre>
        </>
      ) : (
        <p data-conflict-local-unsafe="">
          {reason} Gnosis pushes only a merge it can resolve completely, so this PR needs a local merge. A branch or
          repository name here has characters a shell could run as code, so Gnosis shows no commands to copy. Merge{' '}
          {session.baseBranch} into {session.headBranch} in your clone by hand.
        </p>
      )}
      <p>
        Resolve the conflicts in your editor or merge tool, commit, and push. GitHub then shows whether conflicts
        remain.
      </p>
      <div className="conflict-state-actions">
        {commands && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void navigator.clipboard.writeText(commands).then(
                () => setCopied(true),
                () => setCopied(false)
              )
            }
          >
            <Copy aria-hidden="true" />
            {copied ? 'Copied' : 'Copy commands'}
          </Button>
        )}
        <Button size="sm" variant="ghost" asChild>
          <a href={session.url} target="_blank" rel="noreferrer">
            Open PR on GitHub
            <ExternalLink aria-hidden="true" />
          </a>
        </Button>
      </div>
    </div>
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

/** In-place edits as the draft saves them (ConflictFile.edits): null for none, every field present. */
function savedEdits(edits: BlockEdits | undefined): (SavedBlockEdit | null)[] {
  return Array.from(edits ?? [], (edit) =>
    edit
      ? {
          text: edit.text,
          before: edit.before ?? null,
          pick: edit.pick ?? null,
          ...(edit.written?.length ? { written: [...edit.written] } : {}),
        }
      : null
  );
}
/** A file's saved Keep choices, the same array for the same saved file, so memoized buckets stay valid. */
const savedPickCache = new WeakMap<ConflictFile, BlockPicks>();
function savedPicks(f: ConflictFile): BlockPicks | undefined {
  if (!f.picks) return undefined;
  let picks = savedPickCache.get(f);
  if (!picks) savedPickCache.set(f, (picks = f.picks.map((pick) => pick ?? undefined)));
  return picks;
}

export function ConflictWorkspace({
  url,
  onClose,
  preferences,
}: {
  url: string;
  onClose: () => void;
  /** The reader's diff appearance, layout, theme and code intelligence: the diffs are Changes' (#445 item 8). */
  preferences?: Preferences | null;
}) {
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
  const [epoch, setEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'failed'>('idle');
  const [error, setError] = useState('');
  const [failedKind, setFailedKind] = useState<ConflictRequest['kind'] | 'open'>();
  // GitHub refuses a push that changes workflow files from a sign-in without `workflow`. The sign-in it refused, so
  // Push returns once you have signed in again; a refusal is definite, so there is nothing to check first.
  const access = useGitHubAccess();
  const accessKey = JSON.stringify(access ?? null);
  const accessNow = useRef(accessKey);
  accessNow.current = accessKey;
  const [refusedAccess, setRefusedAccess] = useState<string>();
  const [preview, setPreview] = useState<ConflictReply['preview']>();
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState('');
  const [resetPrompt, setResetPrompt] = useState(false);
  // Cancel takes focus once the prompt is on screen, after any menu that opened it has closed.
  const cancelReset = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!resetPrompt) return;
    const frame = requestAnimationFrame(() => cancelReset.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [resetPrompt]);
  const [outcome, setOutcome] = useState('');
  // One line after Gnosis merged new commits from the base branch again.
  const [baseNote, setBaseNote] = useState('');
  const [hint, setHint] = useState('');
  // Your Keep choices per file, so a choice that equals the proposal reads as yours. They are saved with the draft;
  // Reset and a suggestion clear them.
  const [picks, setPicks] = useState<Partial<Record<string, { original: string; picks: BlockPicks }>>>({});
  // A file whose conflict changed (main moved, or a fresh merge) starts without your earlier choices.
  // Choices are saved with the draft (ConflictFile.picks): after a reopen they come from there.
  const picksOf = (f: ConflictFile): BlockPicks | undefined => {
    const entry = picks[f.path];
    return entry?.original === f.original ? entry.picks : savedPicks(f);
  };
  const picksRef = useRef(picksOf);
  picksRef.current = picksOf;
  // Your in-place edits per file (#445 item 11), as your picks are: kept here as you edit, saved with the draft
  // (ConflictFile.edits), and read from there after a reopen. A file whose conflict changed starts without them.
  const [edits, setEdits] = useState<Partial<Record<string, { original: string; edits: BlockEdits }>>>({});
  const editsOf = (f: ConflictFile): BlockEdits | undefined => {
    const entry = edits[f.path];
    return entry?.original === f.original ? entry.edits : f.edits;
  };
  const editsRef = useRef(editsOf);
  editsRef.current = editsOf;
  /** The choices to save for a file, when they differ from the saved ones. */
  const picksToSave = (f: ConflictFile) => {
    const own = Array.from(picksRef.current(f) ?? [], (pick) => pick ?? null);
    return JSON.stringify(own.some(Boolean) ? own : []) === JSON.stringify(f.picks ?? []) ? undefined : own;
  };
  /** The in-place edits to save for a file, when they differ from the saved ones. */
  const editsToSave = (f: ConflictFile) => {
    const own = savedEdits(editsRef.current(f));
    return JSON.stringify(own.some(Boolean) ? own : []) === JSON.stringify(f.edits ?? []) ? undefined : own;
  };
  /** Your picks and edits for a save request, where they changed. */
  const ownToSave = (f: ConflictFile) => {
    const own = picksToSave(f);
    const typed = editsToSave(f);
    return { ...(own ? { picks: own } : {}), ...(typed ? { edits: typed } : {}) };
  };
  // Each saved draft's buckets, per file: a Keep press or a check result recomputes only the file it changed.
  const bucketCache = useRef(
    new WeakMap<
      ConflictFile,
      {
        verdict: Verdict | undefined;
        picks: BlockPicks | undefined;
        edits: BlockEdits | undefined;
        buckets: ConflictBucket[];
      }
    >()
  );
  const view = useRef<ConflictViewHandle>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  const focusIntent = useRef(true);
  const author = useMemo(() => (session ? findAuthor(session.url) : undefined), [session?.url]);
  // Checks of each file's proposals, by path, with the fingerprint of the proposals they checked. A result for other
  // proposals never counts: the file's proposals are Check until their own checks finish.
  const [verdicts, setVerdicts] = useState<Record<string, { key: string; verdict: Verdict }>>({});
  const checking = useRef(new Map<string, string>());
  // The main process checks proposals and saves the result with the draft (src/conflict-checks.ts). The worker checks
  // only a file whose draft has no result for its proposals: a draft from an earlier build, or a session made in a test.
  // The opt-in type check (#445 item 24): its status, from the main process while this draft is open.
  // Kept across saves of the same draft, so files don't flash between buckets while the status is read again.
  const [typeCheckOf, setTypeCheck] = useState<{ id: string; status: ConflictTypeCheck | null | undefined }>();
  const sessionId = session?.id;
  // Undefined until read for this draft, or on but not run: the demotions saved on the files apply.
  // Only a result for this draft counts; one for an earlier draft reads as waiting (lib/conflict-verify.ts).
  const typeCheck = useMemo(
    () => typeCheckFor(typeCheckOf && typeCheckOf.id === sessionId ? typeCheckOf.status : undefined, session?.files ?? []),
    [typeCheckOf, sessionId, session?.files]
  );
  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    const refresh = () =>
      void window.electronAPI.conflictTypeCheck(sessionId).then(
        (status) => active && setTypeCheck({ id: sessionId, status }),
        () => {}
      );
    refresh();
    const off = window.electronAPI.onConflictTypeCheckChanged((id) => id === sessionId && refresh());
    return () => {
      active = false;
      off();
    };
  }, [sessionId, session?.version]);
  // New type errors keep Merged proposals in Check: the same overlay as the PR header's (lib/conflict-verify.ts).
  const typeNoteOf = (f: ConflictFile) => typeErrorOf(f, typeCheck);
  const verdictOf = (f: ConflictFile) => {
    if (f.verdict?.key === verdictKey(f, disabledLanguages(currentCodeIntelligence())))
      return withTypeError(f.verdict.verdict, typeNoteOf(f));
    const entry = f.proposals || f.wholeFile ? verdicts[f.path] : undefined;
    return entry?.key === proposalKey(f) ? withTypeError(entry.verdict, typeNoteOf(f)) : undefined;
  };
  useEffect(() => {
    for (const f of session?.files ?? []) {
      if (!f.proposals && !f.wholeFile) continue;
      const key = proposalKey(f);
      if (verdictOf(f) || checking.current.get(f.path) === key) continue;
      checking.current.set(f.path, key);
      void (
        f.wholeFile
          ? verifyWholeFile(f, f.wholeFile, checkSyntax)
          : verifyProposals(f, checkSyntax, false, checkFormatting)
      )
        .catch(() => ({ merged: false, note: 'Gnosis couldn’t check this result.' }))
        // A slower check of earlier proposals never replaces the result for the current ones.
        .then((verdict) => {
          if (checking.current.get(f.path) === key)
            setVerdicts((previous) => ({ ...previous, [f.path]: { key, verdict } }));
        });
    }
  }, [session?.files]);
  const { settings: repositories, setShowMergedConflicts } = useRepositorySettings();
  // Undo and re-choice counts for Settings › Diagnostics (lib/conflict-stats.ts).
  const choiceStats = useConflictChoiceStats();
  const repo = session ? repositoryKey(session.baseRepo) : '';
  // Unset means on: Merged conflicts still wait for your review.
  const showMerged = (repositories[repo] as RepositorySettings | undefined)?.showMergedConflicts !== false;

  const file = session?.files.find((f) => f.path === selected);
  // Saved drafts' buckets change only with the session or a check result; the open draft's follow each keystroke.
  const savedBuckets = useMemo(
    () =>
      new Map(
        session?.files.map((f) => {
          const verdict = verdictOf(f);
          const own = picksOf(f);
          const typed = editsOf(f);
          const cached = bucketCache.current.get(f);
          if (cached && cached.verdict === verdict && cached.picks === own && cached.edits === typed)
            return [f.path, cached.buckets];
          const buckets = blockBuckets(f, f.result, verdict, own, typed);
          bucketCache.current.set(f, { verdict, picks: own, edits: typed, buckets });
          return [f.path, buckets];
        })
      ),
    [session?.files, verdicts, picks, edits, typeCheck]
  );
  const fileStates = useMemo(
    () =>
      session?.files.map((f) => {
        const text = f.path === selected ? contents : f.result;
        const stage = conflictFileStage(f, text);
        const buckets =
          text === f.result
            ? (savedBuckets.get(f.path) ?? [])
            : blockBuckets(f, text, verdictOf(f), picksOf(f), editsOf(f));
        return {
          file: f,
          stage,
          contents: text,
          buckets,
          // The one status the file list, the header, the footer and the summary show.
          status: fileStatus(f, text, stage, buckets),
        };
      }) ?? [],
    [session, selected, contents, savedBuckets, edits]
  );
  const summary = bucketSummary(
    fileStates.map((s) => summaryEntry(s.file, s.status, s.buckets, verdictOf(s.file), showMerged))
  );
  const reviewedCount = fileStates.filter((s) => s.stage === 'reviewed').length;
  const selectedState = fileStates.find(({ file: f }) => f.path === selected);
  const fileStage = selectedState?.stage;
  const nextPending = (
    from: string,
    states: { file: ConflictSession['files'][number]; stage: ConflictFileStage }[] = fileStates
  ) => {
    const index = states.findIndex((s) => s.file.path === from);
    const ordered = [...states.slice(index + 1), ...states.slice(0, Math.max(0, index))];
    return ordered.find((s) => s.stage !== 'reviewed' && !s.file.unsupported)?.file;
  };
  const markersRemain = hasConflictMarkers(contents);
  const ready = selectedState?.status.kind === 'proposal';
  // The conflicts behind a whole-file proposal, once you ask for them, until the view changes.
  const [blocksShown, setBlocksShown] = useState('');
  const viewKey = `${selected}:${epoch}`;
  /** The file's one stop is the whole-file proposal. */
  const proposalOnly = ready && blocksShown !== viewKey;
  // The result is always on screen, in the diff (PR shows it against the PR's version): Mark reviewed needs no separate
  // step. The push confirmation shows the whole update once more before anything is pushed.
  // Conflicts in Check with no choice of yours: nothing is accepted by default, so Mark reviewed waits for them.
  const unchosen = file ? unchosenConflicts(file, contents, verdictOf(file), picksOf(file), editsOf(file)) : [];
  const action = conflictFileAction({
    stage: fileStage,
    otherFilesPending: !!nextPending(selected),
    unsupported: !!file?.unsupported,
    unchosen: unchosen.length > 0,
  });
  const diffKey = `conflict:${session?.id ?? url}:${selected}`;
  const labels = useMemo(
    () => conflictLabels('merge', { head: session?.headBranch ?? 'PR', base: session?.baseBranch ?? 'base' }),
    [session?.headBranch, session?.baseBranch]
  );
  const dirty =
    (!!file && (contents !== file.result || !!picksToSave(file) || !!editsToSave(file))) || restackDirty;

  function select(path: string, value: ConflictSession) {
    const next: ConflictFile | undefined = value.files.find((f) => f.path === path) ?? value.files.at(0);
    if (next?.path !== selectedRef.current) setOutcome('');
    selectedRef.current = next?.path ?? '';
    setSelectedState(next?.path ?? '');
    setContents(next?.result ?? '');
    setEpoch((n) => n + 1);
    focusIntent.current = true;
  }
  function apply(reply: ConflictReply, selection = selectedRef.current) {
    setSession(reply.session);
    select(selection, reply.session);
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
      const own = current ? ownToSave(current) : {};
      if (
        value.status === 'editing' &&
        !value.stale &&
        current &&
        !current.unsupported &&
        (text !== current.result || Object.keys(own).length > 0)
      ) {
        setSaveState('saving');
        value = (
          await window.electronAPI.conflictResolution({
            kind: 'save',
            id: value.id,
            version: value.version,
            path,
            contents: text,
            resolved: text === current.result && current.resolved,
            ...own,
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

  // The model's proposals, one conflict at a time (#445 items 6 and 7). Each goes into the saved draft after your edits,
  // never during a request of yours, and only into its own conflict; the service checks it there.
  const models = useConflictModel({
    session,
    file,
    contents,
    edits: file ? editsOf(file) : undefined,
    label: model,
    busy,
    root,
    apply: (path, index) => {
      if (pending.current) return Promise.reject(new ModelProposalWaits());
      const task = persist().then(async (saved) => {
        if (pending.current) throw new ModelProposalWaits();
        const before = saved.files.find((f) => f.path === path)?.result;
        const reply = await window.electronAPI.conflictResolution({ kind: 'model', id: saved.id, version: saved.version, path, index });
        const after = reply.session.files.find((f) => f.path === path);
        setSession(reply.session);
        // Typing meanwhile wins: your next save keeps your text, and the proposal stays one choice away.
        if (selectedRef.current === path && contentsRef.current === before && after) setContents(after.result);
      });
      saveChain.current = task.catch(() => {});
      return task;
    },
  });
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
      setRefusedAccess(kind === 'publish' && githubWriteError(e).workflowPermission ? accessNow.current : undefined);
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  /** `keep` carries over resolutions whose conflicts did not change; Start over drops them. */
  async function load(restart = false, keep = false) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setFailedKind(undefined);
    try {
      await saveChain.current;
      const reply = await window.electronAPI.conflictResolution({
        kind: 'open',
        url,
        restart,
        ...(keep ? { keep } : {}),
      });
      setPreview(undefined);
      setConfirming(false);
      // Load latest changes keeps your resolutions, and your choices on the conflicts that did not change (the service
      // carries them with the draft). Start over drops them. In-place edits stay only on files whose conflicts are the
      // same (editsOf).
      if (!keep) {
        setPicks({});
        setEdits({});
      }
      // A merge prepared again: earlier model requests and their cards belong to the old one.
      if (restart) models.reset();
      apply(reply, selectedRef.current);
      setResetPrompt(false);
      setOutcome('');
      setBaseNote('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setFailedKind('open');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  // The view stays mounted while another PR tab shows (Activity re-runs its effects): it opens the session once.
  const opened = useRef(false);
  useEffect(() => {
    // Each time the Conflicts tab shows, the view takes the keys.
    if (!root.current?.contains(document.activeElement)) root.current?.focus({ preventScroll: true });
    if (opened.current) return;
    opened.current = true;
    void load();
  }, []);

  /** New base commits brought new conflicts: back to the files, on the first one that needs work. */
  function showNewConflicts(reply: ConflictReply) {
    setPicks({});
    setEdits({});
    setPreview(undefined);
    setConfirming(false);
    const first = reply.session.files.find((f) => !f.resolved && !f.unsupported) ?? reply.session.files.at(0);
    apply(reply, first?.path ?? selectedRef.current);
  }
  /** Undo this update (#445 item 25) moved the branch back: the draft is editable again, with your choices. */
  function undone(next: ConflictSession) {
    setPicks({});
    setEdits({});
    setPreview(undefined);
    setConfirming(false);
    setBaseNote('');
    apply({ session: next }, next.files.at(0)?.path ?? selectedRef.current);
    setOutcome(`${next.headBranch} is back at ${next.headSha.slice(0, 7)}. Your resolutions are saved.`);
  }
  function confirm() {
    // The confirmation opens only when nothing needs you: every file reviewed, none with a marker left or a local merge.
    const waiting = sessionRef.current?.files.find((f) => needsYou(f));
    if (waiting) {
      setHint(`${waiting.path} still needs you. Review every file before you push.`);
      return;
    }
    void run(
      (s) => ({ kind: 'preview', id: s.id, version: s.version }),
      (reply) => {
        setBaseNote(
          reply.baseMoved
            ? describeBaseMove(reply.baseMoved, { baseBranch: reply.session.baseBranch, stage: 'preview' })
            : ''
        );
        if (!reply.preview) {
          showNewConflicts(reply);
          return;
        }
        setSession(reply.session);
        setPreview(reply.preview);
        setConfirming(true);
      }
    );
  }
  function markReviewed() {
    if (!file || markersRemain || file.unsupported) return;
    if (unchosen.length) {
      setHint(waitingHint(file, contents, unchosen.length));
      view.current?.move(1);
      return;
    }
    const path = selected;
    let finished = false;
    void run(
      (s) => {
        const saved = s.files.find((f) => f.path === path);
        const own = saved ? ownToSave(saved) : {};
        return { kind: 'save', id: s.id, version: s.version, path, contents, resolved: true, ...own };
      },
      (reply) => {
        const states = reply.session.files.map((f) => ({ file: f, stage: conflictFileStage(f) }));
        const next = nextPending(path, states);
        apply(reply, next?.path ?? path);
        setBaseNote('');
        finished = !next;
      }
    ).then((ok) => {
      // Every file is reviewed: go straight to the confirmation, which shows the final update.
      if (ok && finished) confirm();
    });
  }
  // With "Show me every merged conflict" off, a file whose every conflict is Merged needs no review from you.
  useEffect(() => {
    if (showMerged || busy || error || confirming || !session || session.stale || session.status !== 'editing') return;
    const ready = fileStates.find((s) => !s.file.resolved && s.contents === s.file.result && allMerged(s.buckets));
    if (!ready) return;
    const { path, result } = ready.file;
    void run(
      (v) => ({ kind: 'save', id: v.id, version: v.version, path, contents: result, resolved: true }),
      (reply) => setSession(reply.session)
    );
  }, [showMerged, busy, error, confirming, session, verdicts]);
  // What preparation left: the original conflict with only the proposals nobody has to choose in place (the checks'
  // Merged ones, and remembered resolutions). Every other proposal stays on its card.
  const resetTarget = (f: ConflictFile) => preparedDraft(f, verdictOf(f));
  // A new choice starts from the saved ones, so it never erases a Keep made before a reopen.
  const pickFor = (f: ConflictFile, index: number, choice: BlockPicks[number]) =>
    setPicks((previous) => {
      const entry = previous[f.path];
      const next = [...(entry?.original === f.original ? entry.picks : (savedPicks(f) ?? []))];
      next[index] = choice;
      return { ...previous, [f.path]: { original: f.original, picks: next } };
    });
  // No choices and no edits, also over the saved ones: Reset and a suggestion start the file again.
  const dropPicks = (path: string) => {
    setPicks((previous) => {
      const f = sessionRef.current?.files.find((file) => file.path === path);
      return f ? { ...previous, [path]: { original: f.original, picks: [] } } : previous;
    });
    setEdits((previous) => {
      const f = sessionRef.current?.files.find((file) => file.path === path);
      return f ? { ...previous, [path]: { original: f.original, edits: [] } } : previous;
    });
  };
  const editsFor = (f: ConflictFile, next: BlockEdits) =>
    setEdits((previous) => ({ ...previous, [f.path]: { original: f.original, edits: next } }));
  function resetTo(text: string) {
    if (file) dropPicks(file.path);
    // The footer speaks of the draft on screen: a suggestion's note goes with it.
    setOutcome('');
    setContents(text);
    setEpoch((n) => n + 1);
    focusIntent.current = true;
  }
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
  /** One file's result: the whole-file proposal (`whole-file`), structural merge's, or the model's, with your instructions. */
  function suggest(engine: SuggestEngine | 'whole-file', instructions?: string) {
    const path = selected;
    void run(
      (s) => ({
        kind: 'resolve',
        engine,
        id: s.id,
        version: s.version,
        path,
        ...(engine === 'agent' ? { instructions: instructions ?? '' } : {}),
      }),
      (reply) => {
        const current = reply.session.files.find((f) => f.path === path);
        const who = engine === 'mergiraf' ? 'Structural merge' : model.replace(/^the /, 'The ');
        // A suggestion is offered as proposals (fail closed): the service says what it offered, and what it left to your
        // decisions.
        setOutcome(
          engine === 'whole-file'
            ? 'The draft is the whole-file proposal now. Review it before you mark the file reviewed.'
            : engine === 'mergiraf'
              ? // Structural merge's own words already name it; a timeout says so in its note.
                (current?.explanation ?? current?.structuralNote ?? 'Structural merge proposed nothing new.')
              : current?.explanation
                ? `${who}: ${current.explanation}`
                : `${who} proposed nothing new.`
        );
        // Only using a whole-file result replaces your choices; a suggestion never overrides them.
        const before = sessionRef.current?.files.find((f) => f.path === path)?.result;
        if (engine === 'whole-file' && current?.result !== before) dropPicks(path);
        apply(reply, path);
      }
    );
  }
  async function close() {
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
      if (view.current?.focusFirst()) return;
      primary.current?.focus();
    });
  }, [session, selected, epoch, confirming]);
  const upToDate = session?.status === 'editing' && !session.files.length && session.preparation === 'up-to-date';
  const pushed = session ? undoTarget(session) : undefined;
  const reopened = !!session?.reopened;
  useEffect(() => {
    if ((session?.status === 'published' && !session.dependents?.length) || upToDate || reopened)
      requestAnimationFrame(() => done.current?.focus());
  }, [session?.status, upToDate, reopened]);

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
  // Browser checks wait on this (lib/test-settled.ts): opened or failed, nothing running or saving, every check done.
  // A failed save, a failed open and a stale session are settled too: the screen says what went wrong.
  const committed = useRef({ session, busy, error, dirty, saveState, verdictOf });
  useEffect(() => {
    committed.current = { session, busy, error, dirty, saveState, verdictOf };
  });
  // Notifications sit above the footer while it shows, so they never cover its controls.
  const footer = useRef<HTMLElement>(null);
  const footerShown = !!session && session.status === 'editing' && session.files.length > 0 && !confirming;
  useEffect(() => {
    const element = footer.current;
    if (!element) return;
    const style = document.documentElement.style;
    const write = () => style.setProperty('--conflict-footer-reserve', `${Math.ceil(element.getBoundingClientRect().height) + 12}px`);
    write();
    const observer = new ResizeObserver(write);
    observer.observe(element);
    return () => {
      observer.disconnect();
      style.removeProperty('--conflict-footer-reserve');
    };
  }, [footerShown]);
  // Leaving the view, for another tab or another PR, saves the open draft: there is no Close step to wait for.
  useEffect(
    () => () => {
      if (committed.current.dirty && !pending.current)
        void persist().catch((e: unknown) =>
          toast.add({
            type: 'error',
            title: `Could not save your conflict draft for ${committed.current.session?.title ?? url}`,
            description: `${e instanceof Error ? e.message : String(e)} Open Resolve conflicts again before you push.`,
            timeout: 0,
          })
        );
    },
    []
  );
  useEffect(
    () =>
      registerSettled('conflict-workspace', () => {
        const now = committed.current;
        if (!now.session) return now.error ? true : 'opening';
        if (now.busy) return 'working';
        if (now.session.stale || now.saveState === 'failed') return true;
        if (now.dirty || now.saveState === 'saving') return 'saving';
        if (now.session.files.some((f) => (f.proposals || f.wholeFile) && !now.verdictOf(f)))
          return 'checking proposals';
        return true;
      }),
    []
  );

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    // Escape leaves the view, as it closed the dialog. Drafts save first; nothing is pushed.
    if (event.key === 'Escape' && !event.defaultPrevented) {
      const origin = (event.nativeEvent.composedPath()[0] ?? event.target) as HTMLElement;
      if (origin.closest('[role=menu],[role=dialog],.conflict-suggest-menu')) return;
      event.preventDefault();
      void close();
      return;
    }
    if (!shortcutsActive || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const origin = (event.nativeEvent.composedPath()[0] ?? event.target) as HTMLElement;
    // The in-place editor's card is yours while it is open: no key chooses, moves or marks from there (#445 item 11).
    if (
      origin.isContentEditable ||
      origin.closest(
        'input,textarea,select,[contenteditable=true],[role=menu],[role=dialog],.conflict-suggest-menu,.conflict-block[data-state=editing]'
      )
    )
      return;
    const key = event.key;
    const handled = (() => {
      if (key === 'j' || key === 'k') {
        if (!view.current?.move(key === 'j' ? 1 : -1)) primary.current?.focus();
        return true;
      }
      if (key === '1' || key === '2' || key === '3') {
        if (!canEdit) return false;
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
  const describedError = error
    ? describeConflictError(error, {
        stage: failedKind === 'publish' ? 'push' : failedKind === 'open' ? 'prepare' : 'other',
        headBranch: session?.headBranch,
        baseBranch: session?.baseBranch,
      })
    : undefined;
  // A personal access token can't sign in again for the workflow permission: its instructions follow the copy.
  const errorCopy =
    describedError?.recovery === 'sign-in'
      ? { ...describedError, body: scopePromptCopy(access, describedError.body).text }
      : describedError;
  // The preview lists every file the merge commit changes against the PR head. Push waits for the workflow permission.
  const pushNeedsWorkflow = conflictPushNeedsWorkflow(access?.scopes, preview?.files);
  // The dependent PRs' dry run (#445 item 22): starts once every file is reviewed, shown in the confirmation.
  const cascade = useConflictCascade(session, busy);
  // The confirmation's three groups (#445 item 12), from the saved drafts the preview was made from.
  const groups = useMemo(
    () =>
      preview && session
        ? confirmGroups(
            session.files.map((f) => ({
              file: f,
              buckets: savedBuckets.get(f.path) ?? [],
              picks: picksOf(f),
            })),
            preview.files
          )
        : undefined,
    [preview, session, savedBuckets]
  );
  const workflowRefused = !!pushError && refusedAccess !== undefined;
  const signedInSinceRefusal = workflowRefused && refusedAccess !== accessKey;
  const recover = (copy: ConflictErrorCopy) =>
    copy.recovery === 'sign-in' ? (
      <GitHubScopeActions disabled={busy} />
    ) : copy.recovery === 'load-latest' ? (
      <Button size="sm" disabled={busy} onClick={() => void load(true, true)}>
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
  const staleSummary =
    session?.staleReason === 'retargeted'
      ? 'This PR now targets a different base branch.'
      : `Someone pushed to ${session?.headBranch ?? 'the PR branch'} after you started.`;

  const primaryButton = (() => {
    if (!session || !file || session.stale) return null;
    const common = { ref: primary, size: 'sm' as const, 'data-conflict-primary': action };
    if (proposalOnly)
      return (
        <Button
          {...common}
          data-conflict-primary="use-proposal"
          disabled={!canEdit}
          onClick={() => suggest('whole-file')}
        >
          Use this result
        </Button>
      );
    switch (action) {
      case 'next-conflict':
        return (
          <Button
            {...common}
            disabled={busy}
            aria-keyshortcuts="J"
            onClick={() => view.current?.move(1)}
          >
            Next conflict
            <kbd className="kbd" aria-hidden="true">
              J
            </kbd>
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
  const summaryShown = editing && summary.conflicts > 0;
  const mergedToggle = !!session?.files.some((f) => f.proposals);
  const fileButtons = fileStates.map(({ file: f, stage, status }) => (
    <button
      key={f.path}
      disabled={busy}
      aria-current={f.path === selected ? 'true' : undefined}
      onClick={() => chooseFile(f.path)}
    >
      <FilePath path={f.path} />
      <small>
        <FileStatusBadge status={status} stage={stage} />
      </small>
    </button>
  ));
  // Every way back, in one menu (#445 distill): the file's three, then the fresh merge, which asks first.
  const resetItems: ResetItem[] =
    file && !file.unsupported && editing
      ? [
          ...(contents !== resetTarget(file)
            ? [{ label: 'Reset file', disabled: !canEdit, onSelect: () => resetTo(resetTarget(file)) }]
            : []),
          // Reset returns to what preparation proposed; Git's conflict is a separate step back.
          ...(file.proposals && contents !== file.original
            ? [{ label: 'Start from Git’s conflict', disabled: !canEdit, onSelect: () => resetTo(file.original) }]
            : []),
          ...(canRetryStructural(file, contents === resetTarget(file))
            ? [{ label: 'Try structural merge again', disabled: !canEdit, onSelect: () => suggest('mergiraf') }]
            : []),
        ]
      : [];
  if (editing && !session.stale)
    resetItems.push({
      label: 'Start over with latest code…',
      separated: true,
      movesFocus: true,
      onSelect: () => setResetPrompt(true),
    });
  const footerStatus = busy
    ? activity?.detail || 'Working…'
    : hint ||
      outcome ||
      baseNote ||
      (session
        ? [
            selectedState && fileStatusLine(selectedState.status),
            `${reviewedCount} of ${session.files.length} ${session.files.length === 1 ? 'file' : 'files'} reviewed`,
          ]
            .filter(Boolean)
            .join(' · ')
        : '');

  return (
    // The Conflicts view (#445 item 8): a tab of the PR, so its header, chat and other tabs stay reachable.
    <section
      ref={root}
      className="conflict-workspace"
      data-model-answers={models.handled}
      data-conflict-url={url}
      data-conflict-id={session?.id}
      tabIndex={-1}
      aria-labelledby="conflict-workspace-title"
      onKeyDown={onKeyDown}
    >
        {/* One band over the code (#445 distill): the direction and the count of what's left, then the file's tools. */}
        <div className="conflict-heading">
          <div className="conflict-heading-text">
            <h2 id="conflict-workspace-title">{title}</h2>
            {!session && (
              <p className="conflict-heading-description">
                Gnosis prepares the merge privately. Your checkout stays unchanged.
              </p>
            )}
            {summaryShown && (
              <p role="status" data-conflict-summary="">
                {summarySentence(summary)}
              </p>
            )}
          </div>
          <div className="conflict-heading-tools">
            {editing && (
              <FilePicker
                disabled={busy}
                file={file}
                status={selectedState && <FileStatusBadge status={selectedState.status} stage={selectedState.stage} />}
                position={session.files.findIndex((f) => f.path === selected) + 1}
                total={session.files.length}
              >
                {fileButtons}
              </FilePicker>
            )}
            {editing && (models.waiting > 0 || (file && !file.unsupported)) && (
              <ConflictSuggestMenu
                disabled={!canEdit}
                fileName={file && !file.unsupported ? (file.path.split('/').pop() ?? file.path) : undefined}
                model={model}
                onAsk={(instructions) => suggest('agent', instructions)}
                // Nothing goes to the model until you ask (#445 item 7). The cards show both sides meanwhile.
                all={models.waiting > 0 ? { count: models.waiting, onAsk: models.askAll } : undefined}
              />
            )}
            {editing && <ResetMenu disabled={busy} items={resetItems} />}
            {summaryShown && (
              <span className="conflict-save-state" role="status">
                {saveState === 'failed'
                  ? 'Couldn’t save · retrying'
                  : dirty || saveState === 'saving'
                    ? 'Saving…'
                    : 'Saved'}
              </span>
            )}
            {summaryShown && <KeyboardHelp />}
            <Button variant="outline" size="sm" onClick={() => void close()}>
              {busy && !session ? 'Close · keeps preparing' : busy ? 'Continue in background' : 'Close'}
            </Button>
          </div>
          {summaryShown && (models.notice || session.lastPush || typeCheck || mergedToggle) && (
            <div className="conflict-summary-notes">
              {models.notice && (
                <p className="conflict-model-notice" role="status" data-conflict-model-notice="">
                  <Bot size={13} aria-hidden="true" />
                  {models.notice} Gnosis didn’t ask it about these conflicts.
                </p>
              )}
              {session.lastPush && <LastPush session={session} push={session.lastPush} onUndone={undone} />}
              {mergedToggle && (
                <label>
                  <input
                    type="checkbox"
                    checked={showMerged}
                    disabled={!setShowMergedConflicts}
                    onChange={(e) => void setShowMergedConflicts?.(repo, e.target.checked)}
                  />
                  Show me every merged conflict
                </label>
              )}
              {typeCheck && (
                <TypeCheckStatus
                  status={typeCheck}
                  onStop={() => void window.electronAPI.cancelConflictTypeCheck(session.id)}
                />
              )}
            </div>
          )}
        </div>
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
        ) : session.reopened ? (
          // An earlier session pushed, and the PR merges cleanly now. Its result is history, not news.
          <div className="conflict-state" role="status" data-conflict-reopened="">
            <CircleCheck size={24} aria-hidden="true" className="conflict-state-ok" />
            <h2>Nothing to resolve</h2>
            <p>This PR merges cleanly with {session.baseBranch}.</p>
            {session.lastPush && <LastPush session={session} push={session.lastPush} onUndone={undone} />}
            <div className="conflict-state-actions">
              <Button ref={done} size="sm" onClick={() => void close()}>
                Done
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void load()}>
                Check again
              </Button>
            </div>
          </div>
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
                    <li data-base-moved={baseNote ? '' : undefined}>
                      {baseNote || `${session.baseBranch}’s changes included`}
                    </li>
                    <li>Checks restarting on GitHub</li>
                  </ul>
                  {session.undoing && (
                    <div className="conflict-undo-unsettled" data-conflict-undo-unsettled={session.undoUnsettled ?? ''}>
                      <p role="status">{unsettledUndoCopy(session.undoUnsettled, session.headBranch)}</p>
                      <div className="conflict-outcome-actions">
                        <Button size="sm" disabled={busy} onClick={() => void load(true, true)}>
                          Keep my resolutions and start over
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              (s) => ({ kind: 'discard', id: s.id, version: s.version }),
                              () => onClose()
                            )
                          }
                        >
                          Discard
                        </Button>
                      </div>
                    </div>
                  )}
                  <p className="conflict-outcome-undo">
                    To undo, reset {session.headBranch} to <CommitBadge sha={session.headSha} repo={session.headRepo} />
                    {pushed && (
                      <>
                        <span aria-hidden="true">·</span>
                        <ConflictUndo update={pushed} onUndone={undone} />
                      </>
                    )}
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
                preferences={preferences}
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
                onSave={(path, text, resolved, picks, edits) =>
                  void run(
                    (s) => ({
                      kind: 'restack-save',
                      id: s.id,
                      version: s.version,
                      path,
                      contents: text,
                      resolved,
                      picks,
                      edits,
                    }),
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
              // The bar under the page holds the message and Push (#445 distill): it stays in view however long the diff.
              status={
                <div className="conflict-confirm-bar">
                  <label className="conflict-confirm-message">
                    Merge commit message
                    <input
                      value={message}
                      maxLength={2000}
                      disabled={busy}
                      onChange={(e) => setMessage(e.target.value)}
                    />
                  </label>
                  <span>Nothing is pushed until you select Push.</span>
                </div>
              }
              continueLabel={busy ? 'Pushing…' : 'Push merge commit'}
              continueDisabled={
                !message.trim() ||
                pushNeedsWorkflow ||
                !groups ||
                groups.pending.length > 0 ||
                (failedKind === 'publish' && !signedInSinceRefusal)
              }
              continueOnModEnter
              onContinue={() =>
                void run(
                  (s) => ({ kind: 'publish', id: s.id, version: s.version, previewToken: preview.token, message }),
                  (reply) => {
                    if (reply.baseMoved)
                      setBaseNote(
                        describeBaseMove(reply.baseMoved, { baseBranch: reply.session.baseBranch, stage: 'push' })
                      );
                    if (reply.session.status !== 'published') {
                      showNewConflicts(reply);
                      return;
                    }
                    setSession(reply.session);
                    setConfirming(false);
                  }
                )
              }
            >
              {pushError && errorCopy && !signedInSinceRefusal && (
                <ErrorPanel copy={errorCopy} actions={recover(errorCopy)} focus />
              )}
              {pushNeedsWorkflow && !workflowRefused && (
                <div data-workflow-push-warning>
                  <GitHubScopePrompt message={WORKFLOW_PUSH_WARNING} disabled={busy} />
                </div>
              )}
              <ul className="conflict-confirm-facts">
                {baseNote && <li data-base-moved="">{baseNote}</li>}
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
                <ConflictCascadeLine cascade={cascade} />
                <li>
                  Pushes only if the branch is still at <code>{session.headSha.slice(0, 7)}</code>. The PR stays open;
                  checks run again.
                </li>
              </ul>
              {groups && (
                <ConfirmDiff
                  session={session}
                  preview={preview}
                  groups={groups}
                  labels={labels}
                  verdictOf={verdictOf}
                  preferences={preferences}
                />
              )}
            </StepCard>
          </div>
        ) : !session.files.length ? (
          <div className="conflict-state" role="status">
            {session.stale ? (
              <>
                <h2>The PR changed</h2>
                <p>{staleSummary} Nothing was pushed.</p>
                <Button size="sm" disabled={busy} onClick={() => void load(true, true)}>
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
                {session.lastPush && <LastPush session={session} push={session.lastPush} onUndone={undone} />}
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
                {session.lastPush && <LastPush session={session} push={session.lastPush} onUndone={undone} />}
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
                {fileButtons}
              </nav>
              <section className="conflict-file-pane" aria-label={file ? `File ${file.path}` : 'File'}>
                {file && (
                  <>
                    <div className="conflict-scroll selectable" data-diff-scroller="" inert={busy || session.stale}>
                      {file.unsupported ? (
                        <LocalMerge session={session} reason={file.unsupported} />
                      ) : (
                        <>
                          {file.source !== 'manual' && !file.proposals && contents === file.result && (
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
                          {hasConflictMarkers(file.original) || markersRemain ? (
                              <ConflictDiff
                                key={`${selected}:${epoch}`}
                                handle={view}
                                name={selected}
                                ours={file.ours}
                                theirs={file.theirs}
                                fileKey={diffKey}
                                preferences={preferences}
                                original={file.original}
                                contents={contents}
                                labels={labels}
                                shortcuts
                                disabled={!canEdit}
                                onChange={setContents}
                                onAllResolved={() => primary.current?.focus()}
                                proposals={file.proposals}
                                verdict={verdictOf(file)}
                                note={file.structuralNote}
                                models={models.cards(file)}
                                picks={picksOf(file)}
                                onPick={(index, choice) => pickFor(file, index, choice)}
                                edits={editsOf(file)}
                                onEdits={(next) => editsFor(file, next)}
                                resolverText={resolverBaseline(file, contents)}
                                onChoice={(key, before, after, picked) => choiceStats(session.id, file.path, key, before, after, picked)}
                                wholeFile={
                                  file.wholeFile && contents === file.original
                                    ? {
                                        proposal: file.wholeFile,
                                        ours: file.ours,
                                        theirs: file.theirs,
                                        // The proposal as it is, structural merge's or the move rule's: nothing runs again.
                                        onUse: () => suggest('whole-file'),
                                        // The footer's primary uses it while it is the file's one stop: no second button.
                                        inlineUse: !proposalOnly,
                                        shown: blocksShown === viewKey,
                                        onShow: () => setBlocksShown(viewKey),
                                      }
                                    : undefined
                                }
                              />
                            ) : (
                              <ConflictResult
                                name={selected}
                                before={file.ours}
                                after={contents}
                                beforeLabel={labels.ours}
                                afterLabel="Result after the merge"
                                fileKey={diffKey}
                                preferences={preferences}
                                file={file}
                                picks={picksOf(file)}
                              />
                          )}
                        </>
                      )}
                    </div>
                  </>
                )}
              </section>
            </div>
            <footer ref={footer} className="conflict-footer">
              {session.stale ? (
                <>
                  <span className="conflict-footer-status" role="status">
                    {staleSummary} Your resolutions are saved; Load latest changes reuses the ones that still apply.
                  </span>
                  <Button size="sm" disabled={busy} onClick={() => void load(true, true)}>
                    Load latest changes
                  </Button>
                </>
              ) : resetPrompt ? (
                <>
                  <span className="conflict-footer-status">
                    Start over with the latest code? Your current resolutions are replaced by a fresh merge.
                  </span>
                  {/* Cancel has focus: Enter or a stray Space never discards your resolutions. */}
                  <Button ref={cancelReset} size="sm" variant="ghost" autoFocus onClick={() => setResetPrompt(false)}>
                    Cancel
                  </Button>
                  <Button size="sm" variant="destructive" disabled={busy} onClick={() => void load(true)}>
                    Start over
                  </Button>
                </>
              ) : (
                <>
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
                  {/* The error names Load latest changes, so the footer offers it in place of the file action. */}
                  {error && errorCopy?.recovery === 'load-latest' ? recover(errorCopy) : primaryButton}
                </>
              )}
            </footer>
          </>
        )}
    </section>
  );
}

/** One file's part of a confirmation group, in the Conflicts view's diff, with a note under each conflict. */
function ConfirmFileDiff({
  part,
  group,
  session,
  labels,
  verdict,
  preferences,
}: {
  part: ConfirmFile;
  group: 'decided' | 'merged' | 'main';
  session: ConflictSession;
  labels: ConflictLabels;
  verdict: Verdict | undefined;
  preferences?: Preferences | null;
}) {
  // The marked lines, computed as this file's diff mounts: opening the confirmation does no line diff (#445 item 10).
  const marked = useMemo(() => confirmWritten(part, markBudget()), [part]);
  // Each conflict's lines, and every marked line, stay in view: a mark never sits in a hidden gap.
  const pins = useMemo(
    () => [
      ...part.blocks.filter((b) => b.end >= b.start).map((b) => [b.start, b.end] as const),
      ...lineRuns(new Set(marked)),
    ],
    [part.blocks, marked]
  );
  const annotate = useCallback(
    (hunks: readonly GapHunk[]) => {
      const byPlace = new Map<string, DiffLineAnnotation<{ indexes: number[] }>>();
      for (const anchor of cardAnchors(part.blocks, hunks)) {
        const place = `${anchor.side}:${anchor.line}`;
        const existing = byPlace.get(place);
        if (existing) existing.metadata.indexes.push(anchor.index);
        else byPlace.set(place, { side: anchor.side, lineNumber: anchor.line, metadata: { indexes: [anchor.index] } });
      }
      return [...byPlace.values()];
    },
    [part.blocks]
  );
  const saved = session.files.find((f) => f.path === part.path);
  const written = useMemo(() => new Set(marked), [marked]);
  const total = useMemo(() => conflictCount(saved?.original ?? ''), [saved?.original]);
  const note = (index: number) => {
    const item = part.items.find((i) => i.index === index);
    if (!item) return null;
    const proposal = saved?.proposals?.[index];
    const text =
      item.how === 'merged'
        ? `Merged · ${proposal ? proposalWhat(proposal, blockVerdict(verdict, index)) : 'Checked'}`
        : item.how === 'proposal'
          ? `Proposal you reviewed${proposal ? ` · ${proposalWhat(proposal)}` : ''}`
          : item.how === 'used'
            ? `Used the proposal${proposal ? ` · ${proposalWhat(proposal)}` : ''}`
            : labels.kept[item.how];
    const block = part.blocks.find((b) => b.index === index);
    const wrote = block ? marked.filter((line) => line >= block.start && line <= block.end).length : 0;
    const Icon = item.how === 'merged' ? CheckCheck : Check;
    return (
      <p key={index} className="conflict-confirm-note" data-confirm-how={item.how}>
        <Icon size={13} aria-hidden="true" />
        <span>
          Conflict {index + 1} of {total} · {text}
          {wrote > 0 && ` · ${writtenLabel(wrote)}`}
        </span>
      </p>
    );
  };
  const renderNotes = useCallback(
    ({ metadata }: DiffLineAnnotation<{ indexes: number[] }>) => (
      <div className="conflict-diff-cards">{metadata.indexes.map(note)}</div>
    ),
    // The notes read the part and the verdict; the diff re-renders its annotations with them.
    [part, verdict, total, labels, saved]
  );
  return (
    <div className="conflict-confirm-file" data-confirm-file={part.path} data-confirm-whole={part.whole}>
      {part.whole && (
        <p className="conflict-confirm-note" data-confirm-how={part.whole}>
          <Check size={13} aria-hidden="true" />
          <span>{wholeNote(part.whole, part.conflicts, session.baseBranch)}</span>
        </p>
      )}
      {part.whole && marked.length > 0 && <WrittenLegend count={marked.length} />}
      <ConflictFileDiff
        name={part.path}
        previousPath={part.previousPath}
        note={part.previousPath && part.before === part.after ? 'no line changes' : undefined}
        before={part.before}
        after={part.after}
        fileKey={`confirm:${session.id}:${group}:${part.path}`}
        pins={pins}
        annotate={annotate}
        renderAnnotation={renderNotes}
        preferences={preferences}
        written={written}
      />
    </div>
  );
}

/**
 * The time the confirmation's files that mount together share for their marks' line diffs: it refills a second after
 * it was opened, so a file scrolled into view later gets time of its own. Past it, the cautious rule marks.
 */
let marksWindow = { opened: 0, until: 0 };
function markBudget() {
  const now = Date.now();
  if (now - marksWindow.opened > 1000) marksWindow = { opened: now, until: now + WRITTEN_BUDGET_MS };
  return marksWindow;
}

/** A file's rough height before it is measured: its header and the rows of its hunks. */
const estimate = (lines: number) => 60 + Math.min(lines, 400) * 20;
const ARRIVING_MAX = 560;
/**
 * Arriving from main can hold hundreds of files (a clean merge of a busy base branch). Its list is virtualized in a
 * height-capped scroller: a file's diff mounts only when it scrolls into view.
 */
function ArrivingList({
  main,
  incoming,
  render,
  session,
  preferences,
}: {
  main: ConfirmFile[];
  incoming: PreviewFile[];
  render: (part: ConfirmFile) => React.ReactNode;
  session: ConflictSession;
  preferences?: Preferences | null;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const count = main.length + incoming.length;
  const virtual = useVirtualizer({
    count,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => {
      if (i < main.length) return estimate(Math.abs(main[i].after.split('\n').length - main[i].before.split('\n').length) + 8);
      const f = incoming[i - main.length];
      return estimate(f.hunks.reduce((n, h) => n + Math.max(h.additionCount, h.deletionCount) + 1, 0));
    },
    overscan: 2,
    gap: 12,
  });
  useVirtualizerSettled('conflict-confirm-arriving', virtual);
  const total = virtual.getTotalSize();
  return (
    <div
      ref={scroller}
      className="conflict-confirm-arriving"
      data-confirm-arriving=""
      style={{ height: Math.min(total, ARRIVING_MAX) }}
    >
      <div style={{ height: total, position: 'relative' }}>
        {virtual.getVirtualItems().map((item) => {
          const f = item.index >= main.length ? incoming[item.index - main.length] : undefined;
          return (
            <div
              key={item.key}
              ref={virtual.measureElement}
              data-index={item.index}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}
            >
              {f ? (
                <ConflictFileDiff
                  name={f.name}
                  patch={f}
                  note={patchNote(f)}
                  fileKey={`confirm:${session.id}:incoming:${f.name}`}
                  preferences={preferences}
                />
              ) : (
                render(main[item.index])
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A group of the confirmation: its heading is the disclosure, with what it counts. */
function ConfirmSection({
  id,
  title,
  count,
  open,
  onToggle,
  children,
}: {
  id: 'decided' | 'merged' | 'main';
  title: string;
  count: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="conflict-confirm-group" data-confirm-group={id}>
      <h3>
        <button type="button" className="conflict-disclosure" aria-expanded={open} onClick={onToggle}>
          <ArrowRight size={14} aria-hidden="true" />
          {title} · <span data-confirm-count="">{count}</span>
        </button>
      </h3>
      {open && <div className="conflict-confirm-group-body">{children}</div>}
    </section>
  );
}

type PreviewFile = NonNullable<ConflictReply['preview']>['files'][number];
/**
 * The final update in three groups (#445 item 12): You decided (open), Merged for you and Arriving from main
 * (collapsed). The three diffs add up to the update (lib/conflict-confirm.ts). While a file still needs you no group
 * shows, so no count can hide it, and Push stays off.
 */
function ConfirmDiff({
  session,
  preview,
  groups,
  labels,
  verdictOf,
  preferences,
}: {
  session: ConflictSession;
  preview: NonNullable<ConflictReply['preview']>;
  groups: ConfirmGroups<PreviewFile>;
  labels: ConflictLabels;
  verdictOf: (f: ConflictFile) => Verdict | undefined;
  preferences?: Preferences | null;
}) {
  const clean = !session.files.length;
  // A clean merge has only main's changes: that group opens.
  const [open, setOpen] = useState({ decided: true, merged: false, main: clean });
  const toggle = (id: keyof typeof open) => setOpen((previous) => ({ ...previous, [id]: !previous[id] }));
  const verdict = (path: string) => {
    const f = session.files.find((file) => file.path === path);
    return f ? verdictOf(f) : undefined;
  };
  if (groups.pending.length)
    return (
      <div className="conflict-error" role="alert" data-confirm-pending="">
        <CircleAlert size={16} aria-hidden="true" />
        <div>
          <p className="conflict-error-title">
            {groups.pending.length === 1
              ? `${groups.pending[0].path} still needs you.`
              : `${groups.pending.length} files still need you.`}
          </p>
          <p>Nothing is pushed until you decide every conflict and review every file. Go back to the files.</p>
        </div>
      </div>
    );
  const { decided, merged, main, incoming, counts } = groups;
  // Only the groups with something in them show (#445 distill), each counted once more at the top, as a way to it.
  const shown = [
    ...(!clean && decided.length ? [{ id: 'decided' as const, title: 'You decided', count: confirmCount(counts.decided, decided.length) }] : []),
    ...(!clean && merged.length ? [{ id: 'merged' as const, title: 'Merged for you', count: confirmCount(counts.merged, merged.length) }] : []),
    ...(counts.mainFiles ? [{ id: 'main' as const, title: `Arriving from ${session.baseBranch}`, count: confirmCount(0, counts.mainFiles) }] : []),
  ];
  const jump = (id: keyof typeof open) => {
    setOpen((previous) => ({ ...previous, [id]: true }));
    requestAnimationFrame(() =>
      document.querySelector(`.conflict-confirm [data-confirm-group=${id}]`)?.scrollIntoView({ block: 'start' })
    );
  };
  const part = (group: 'decided' | 'merged' | 'main') => (p: ConfirmFile) => (
    <ConfirmFileDiff
      key={p.path}
      part={p}
      group={group}
      session={session}
      labels={labels}
      verdict={group === 'main' ? undefined : verdict(p.path)}
      preferences={preferences}
    />
  );
  return (
    <div className="conflict-confirm-diff">
      {shown.length > 1 && (
        <nav className="conflict-confirm-jump" aria-label="What the merge commit holds">
          {shown.map(({ id, title, count }) => (
            <button key={id} type="button" data-confirm-jump={id} onClick={() => jump(id)}>
              {title} <span>{count}</span>
            </button>
          ))}
        </nav>
      )}
      {shown.map(({ id, title, count }) => (
        <ConfirmSection key={id} id={id} title={title} count={count} open={open[id]} onToggle={() => toggle(id)}>
          {id === 'decided' && decided.map(part('decided'))}
          {id === 'merged' && (
            <>
              <p className="conflict-confirm-lead">Proposals that passed every check. You didn’t change them.</p>
              {merged.map(part('merged'))}
            </>
          )}
          {id === 'main' && (
            <>
              <p className="conflict-confirm-lead">
                {main.length
                  ? `${session.baseBranch}’s changes that didn’t conflict: first its lines in the conflicted files, then the files Git merged on its own.`
                  : `${session.baseBranch}’s changes that didn’t conflict.`}
              </p>
              <ArrivingList main={main} incoming={incoming} render={part('main')} session={session} preferences={preferences} />
            </>
          )}
        </ConfirmSection>
      ))}
      {preview.validation && (
        <details className="conflict-whitespace">
          <summary>Whitespace warnings</summary>
          <pre>{preview.validation}</pre>
        </details>
      )}
    </div>
  );
}

/** The push from an earlier session, as history: its merge commit, how to undo it, and a restack it left undone. */
function LastPush({
  session,
  push,
  onUndone,
}: {
  session: ConflictSession;
  push: NonNullable<ConflictSession['lastPush']>;
  onUndone: (session: ConflictSession) => void;
}) {
  // Only the saved push itself can be undone: a fresh preparation since has no choices to return to.
  const update = session.commitSha === push.commitSha ? undoTarget(session) : undefined;
  return (
    <div className="conflict-state-muted" data-conflict-last-push="">
      <p>
        Last update: merge commit <CommitBadge sha={push.commitSha} repo={session.headRepo} />
      </p>
      {/* Someone pushed on top: resetting would drop their commits, so no undo hint. */}
      {(session.status !== 'editing' || session.headSha === push.commitSha) && (
        <p>
          To undo it, reset {session.headBranch} to <CommitBadge sha={push.headSha} repo={session.headRepo} />
          {update && (
            <>
              {' · '}
              <ConflictUndo update={update} onUndone={onUndone} />
            </>
          )}
        </p>
      )}
      {!!push.unrestacked?.length && (
        <p>
          Its dependent PRs were not restacked:{' '}
          {push.unrestacked.map((url) => (
            <PrBadge key={url} url={url} />
          ))}
        </p>
      )}
    </div>
  );
}
