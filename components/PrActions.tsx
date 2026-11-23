import { openConflictWorkspace } from '../lib/open-conflict-workspace';
import { hasMergeConflicts } from '../lib/merge-conflicts';
import { useConflictHeader } from '../lib/use-conflict-header';
import { useConflictPushed } from '../lib/use-conflict-pushed';
import { ConflictUndo } from './ConflictUndo';
import { conflictHeaderLine } from '../lib/conflict-header';
import { PrStateIcon } from './PrStateIcon';
import { PrBadge, BranchBadge, CommitBadge } from './EntityBadge';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { GitMerge, Loader2, ExternalLink, Trash2, Undo2, GitPullRequestArrow } from 'lucide-react';
import { conflictIcon as ConflictIcon } from '../lib/interface-icons';
import { Popover } from 'radix-ui';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { toast } from './ui/toast';
import { SearchableSelect } from './SearchableSelect';
import { StepCard } from './StepCard';
import { ActionToggle, CloseWhenHidden, HeaderAction, MergeSplit, MethodMenu, UpdateMenu } from './PrActionControls';
import type { EntryActionGroups } from './EntryActions';
import { stackMergeSteps, type StackMergePage } from '../lib/action-steps';
import {
  mergeBlockedReason,
  blockedButMet,
  draftActionBlockedReason,
  branchUpdateBlockedReason,
  closeBlockedReason,
  deleteBranchBlockedReason,
  reopenBlockedReason,
  singleMergePlan,
  workflowPermissionReason,
  mergeMethodLabels,
  type MergeMethod,
  type PrActionKind,
  type PrActionMember,
  type PrActionRequest,
  type PrActionState,
  type PrMergePlan,
} from '../lib/pr-actions';
import type { ReviewMember } from '../lib/workbench';
import { applyToActionState, prActionChange, type OptimisticChange } from '../lib/optimistic-patches';
import { optimisticWrite } from '../lib/write-failures';
import { WriteFailureNotice } from './WriteFailureNotice';
import { startGitHubSignIn, startGitHubTokenSignIn as requestTokenSignIn, useGitHubAccess } from '../lib/use-github-access';
import { useWorkflowFiles } from '../lib/use-workflow-files';
import { githubWriteError, lacksWorkflow, WORKFLOW_WRITE_MESSAGE } from '../lib/github-access';
import { GitHubScopePrompt } from './GitHubScopePrompt';

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const revision = (m: PrActionMember) => ({
  url: m.url,
  headSha: m.headSha,
  baseSha: m.baseSha,
  baseBranch: m.baseBranch,
});
const NATIVE_STACK_AUTO = 'GitHub does not support auto-merge for native stacked PRs.';
const CHECKING = 'Checking GitHub permissions…';
const methodShort: Record<MergeMethod, string> = { SQUASH: 'Squash', MERGE: 'Merge commit', REBASE: 'Rebase' };
/** What undoes a toggle, so its toast can offer Undo. */
const inverse: Partial<Record<PrActionKind, PrActionKind>> = {
  'convert-draft': 'mark-ready',
  'mark-ready': 'convert-draft',
  'enable-auto': 'disable-auto',
  'disable-auto': 'enable-auto',
};
const toggleDone: Partial<Record<PrActionKind, string>> = {
  'convert-draft': 'Converted to draft',
  'mark-ready': 'Marked ready for review',
  'enable-auto': 'Auto-merge on',
  'disable-auto': 'Auto-merge off',
};
export const mac = () => window.electronAPI.platform === 'darwin';
export const shortcutLabel = (key: string) => (mac() ? `⌘⇧${key}` : `Ctrl+Shift+${key}`);
/** Cmd+Shift+<key> on macOS, Ctrl+Shift+<key> elsewhere. */
export const isShortcut = (event: KeyboardEvent, key: string) =>
  event.shiftKey && !event.altKey && (mac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
  event.key.toLowerCase() === key;

/** Why a PR action cannot run on GitHub's current state, if it cannot. */
function actionBlockedReason(kind: PrActionKind, target: PrActionState, workflowReason: (action: 'merge' | 'update-rebase') => string | undefined, plan?: PrMergePlan) {
  switch (kind) {
    case 'merge':
      return plan?.blockedReason ?? ((plan?.members.length ?? 1) === 1 ? workflowReason('merge') : undefined);
    case 'update-rebase':
      return branchUpdateBlockedReason(target) ?? workflowReason('update-rebase');
    case 'update-merge':
      return branchUpdateBlockedReason(target);
    case 'enable-auto':
      return target.state !== 'OPEN' || target.archived
        ? 'Only open PRs in active repositories can merge automatically.'
        : target.stack
          ? NATIVE_STACK_AUTO
          : !target.canEnableAuto
            ? 'GitHub does not allow auto-merge for this PR right now.'
            : undefined;
    case 'disable-auto':
      return !target.canDisableAuto ? 'You cannot turn off auto-merge on this PR.' : undefined;
    case 'mark-ready':
    case 'convert-draft':
      return draftActionBlockedReason(target, kind);
    case 'reopen':
      return reopenBlockedReason(target);
    case 'delete-branch':
      return deleteBranchBlockedReason(target);
    case 'close':
      return closeBlockedReason(target);
  }
}

/**
 * A PR's GitHub actions (#542). Without `trigger` or `stackMembers` they are the PR header's: Draft and Auto-merge
 * toggles, the Update menu and the Merge split button, or Resolve conflicts in Merge's place; Delete branch and Revert
 * on a merged PR, Reopen on a closed one. Toggles act at once, shown optimistically, with Undo in their toast. Merge,
 * Update and Delete branch never run without a click or Enter in their confirmation. The selected PR is always explicit.
 */
export function PrActions({
  member,
  stackMembers,
  onChanged,
  trigger,
  mergeReady = false,
  hasConflicts = false,
  onResult,
  review,
  collapse = 0,
  onOverflow,
  notes,
  shortcuts = false,
  refreshKey = 0,
}: {
  member: ReviewMember;
  stackMembers?: ReviewMember[];
  onChanged?: () => void;
  /** GitHub reports the PR mergeable and reviewed: Merge is the primary action. */
  mergeReady?: boolean;
  hasConflicts?: boolean;
  /**
   * A contextual action loads permissions only when invoked. `quick` runs a toggle at once; `open` opens a
   * confirmation, merge with an optional method.
   */
  trigger?: (
    open: (kind: PrActionKind, method?: MergeMethod) => void,
    busy: boolean,
    quick: (kind: PrActionKind) => void,
    /** The repository's merge methods, read on demand (`load`) for a method menu. */
    methods: { allowed?: MergeMethod[]; load: () => void }
  ) => ReactNode;
  /** Receives GitHub's answer instead of a toast, for a trigger inside a compact row (the Overview). */
  onResult?: (message: string) => void;
  /** The header's review actions, placed before Merge. `primary`: Merge is not the primary action. */
  review?: (primary: boolean) => ReactNode;
  /** The row is short of room: 1 moves the toggles to the header's ⋯ menu, through `onOverflow`; 2 moves Update too. */
  collapse?: 0 | 1 | 2;
  onOverflow?: (groups: EntryActionGroups) => void;
  /** Where the header's notes go: conflicts, a pushed update, failures. */
  notes?: HTMLElement | null;
  /** Cmd+Shift+M opens the merge confirmation, Cmd+Shift+U the Update menu. The page's Cmd+Shift+V is the review action. */
  shortcuts?: boolean;
  /** A new value reads GitHub's permissions and merge options again, as ⋯ › Refresh does. */
  refreshKey?: number;
}) {
  const header = !trigger && !stackMembers;
  const [loaded, setState] = useState<PrActionState>();
  // A draft or auto-merge change shows at once, while GitHub applies it. Main shows it everywhere else.
  // One slot per setting, so Draft and Auto-merge each show their own pending change over GitHub's state.
  const [sendingBySetting, setSendingBySetting] = useState<Partial<Record<'draft' | 'auto', OptimisticChange>>>({});
  const settingOf = (change: OptimisticChange): 'draft' | 'auto' => (change.action === 'mark-ready' || change.action === 'convert-draft' ? 'draft' : 'auto');
  const setSending = (setting: 'draft' | 'auto', change: OptimisticChange | undefined) =>
    setSendingBySetting((all) => ({ ...all, [setting]: change }));
  const sendingChanges = [sendingBySetting.draft, sendingBySetting.auto].filter((change): change is OptimisticChange => change !== undefined);
  const sending = sendingChanges.at(0);
  const sendingRef = useRef(sendingChanges.length);
  sendingRef.current = sendingChanges.length;
  const state = loaded && sendingChanges.reduce((value, change) => applyToActionState(value, change), loaded);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [dialog, setDialog] = useState<{ kind: PrActionKind; plan?: PrMergePlan }>();
  const [method, setMethod] = useState<MergeMethod>('SQUASH');
  const chosenMethod = useRef<MergeMethod | undefined>(undefined);
  const [title, setTitle] = useState(''),
    [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  // Merging several PRs is paged: review, method, then the merge itself.
  const [page, setPage] = useState<StackMergePage>('review');
  const [errorStep, setErrorStep] = useState<'load' | 'submit'>('load');
  const version = useRef(0),
    pending = useRef(false);
  const confirmContent = useRef<HTMLDivElement>(null);
  // A PR read again as merged or closed loads its actions again: they change with it.
  const identity = JSON.stringify([member.url, member.headSha, member.merged, member.state, stackMembers?.map((m) => [m.url, m.headSha])]);
  const current = useRef(identity);
  current.current = identity;
  async function refresh() {
    const n = ++version.current;
    setLoading(true);
    setError('');
    try {
      const next = await window.electronAPI.getPrActionState(member.url, true);
      if (version.current === n) setState(next);
    } catch (e) {
      if (version.current === n) setError(messageOf(e));
    } finally {
      if (version.current === n) setLoading(false);
    }
  }
  useEffect(() => {
    const n = ++version.current;
    setState(undefined);
    setDialog(undefined);
    setError('');
    if (header) {
      setLoading(true);
      void window.electronAPI
        .getPrActionState(member.url)
        .then((next) => {
          if (version.current === n) setState(next);
        })
        .catch((e: unknown) => {
          if (version.current === n) setError(messageOf(e));
        })
        .finally(() => {
          if (version.current === n) setLoading(false);
        });
    }
    return () => {
      version.current++;
    };
  }, [identity]);
  useEffect(() => {
    if (refreshKey && header && !pending.current) void refresh();
  }, [refreshKey]);
  async function open(kind: PrActionKind, preferred?: MergeMethod) {
    if (pending.current) return;
    const n = ++version.current;
    chosenMethod.current = preferred;
    setDialog({ kind });
    setPage('review');
    setErrorStep('load');
    setLoading(true);
    setError('');
    setTitle('');
    setBody('');
    try {
      const plan = stackMembers
        ? await window.electronAPI.getStackMergePlan(stackMembers.filter((m) => !m.merged).map((m) => m.url))
        : singleMergePlan(await window.electronAPI.getPrActionState(member.url, true));
      if (version.current !== n) return;
      setState(plan.target);
      setDialog({ kind, plan });
      // A method picked from the chevron stays picked: if the repository does not allow it, the confirmation says so
      // and cannot merge, rather than quietly using another method.
      const wanted = chosenMethod.current ?? plan.target.defaultMethod;
      setMethod(chosenMethod.current || plan.methods.includes(wanted) ? wanted : (plan.methods[0] ?? 'SQUASH'));
    } catch (e) {
      if (version.current === n) setError(messageOf(e));
    } finally {
      if (version.current === n) setLoading(false);
    }
  }
  /** GitHub's answer: a toast, with Undo for a toggle, or the caller's `onResult`. */
  function announce(message: string, undo?: () => void) {
    if (onResult) {
      onResult(message);
      return;
    }
    const id = toast.add({
      type: 'success',
      title: message,
      ...(undo ? { actionProps: { children: 'Undo', onClick: () => { toast.close(id); undo(); } } } : {}),
    });
  }
  /** Sends a change GitHub shows at once. A failure rolls it back and keeps a retry (`WriteFailureNotice`). */
  function sendOptimistic(change: OptimisticChange, request: PrActionRequest, done?: string, undo?: () => void) {
    const started = current.current;
    const setting = settingOf(change);
    void optimisticWrite({
      key: `pr-action:${request.url}:${change.action}`,
      action: change.action,
      write: async () => {
        setSending(setting, change);
        try {
          const response = await window.electronAPI.performPrAction(request);
          onChanged?.();
          window.dispatchEvent(new CustomEvent('gnosis-pr-action-completed', { detail: request.revisions.map((r) => r.url) }));
          if (current.current === started) {
            announce(done ?? response.message, undo);
            await refresh();
          }
        } finally {
          setSending(setting, undefined);
        }
      },
    });
  }
  /**
   * A toggle, or Reopen: acts at once on GitHub's current state, with no confirmation. `undoing` is the state the
   * user's change set: Undo applies only while GitHub still shows it.
   */
  async function quick(kind: PrActionKind, preferred?: MergeMethod, undoing?: (state: PrActionState) => boolean) {
    if (pending.current || sendingRef.current) {
      if (undoing) toast.add({ type: 'info', title: 'Nothing undone', description: 'Another change to this PR is still being sent. Try Undo again once it finishes.' });
      return;
    }
    pending.current = true;
    setBusy(true);
    const started = current.current;
    let request: PrActionRequest | undefined;
    let previous: MergeMethod | null = null;
    try {
      const fresh = await window.electronAPI.getPrActionState(member.url, true);
      if (current.current !== started) return;
      setState(fresh);
      previous = fresh.autoMerge;
      if (undoing && !undoing(fresh)) {
        toast.add({ type: 'info', title: 'Changed on GitHub since; nothing undone' });
        return;
      }
      const reason = actionBlockedReason(kind, fresh, (action) => workflowReason(fresh, action));
      if (reason) throw new Error(reason);
      if (preferred && !fresh.methods.includes(preferred)) throw new Error(`${mergeMethodLabels[preferred]} is not allowed in ${fresh.repository}.`);
      const chosen = preferred ?? fresh.defaultMethod;
      request = { account: fresh.account, kind, url: fresh.url, revisions: [revision(fresh)], ...(kind === 'enable-auto' ? { method: chosen } : {}) };
    } catch (e) {
      if (current.current === started) toast.add({ type: 'error', title: 'Nothing changed', description: githubWriteError(e).message });
    } finally {
      pending.current = false;
      setBusy(false);
    }
    if (!request) return;
    const change = prActionChange(kind, request.method);
    const back = inverse[kind];
    const undoMethod = previous ?? undefined;
    if (change) {
      // What the change set, as GitHub must still show it for Undo to apply.
      const method = request.method;
      const set = (now: PrActionState) =>
        kind === 'convert-draft' ? now.isDraft : kind === 'mark-ready' ? !now.isDraft : kind === 'enable-auto' ? now.autoMerge === method : now.autoMerge === null;
      sendOptimistic(change, request, toggleDone[kind], back && (() => void quick(back, undoMethod, set)));
      return;
    }
    pending.current = true;
    setBusy(true);
    try {
      const response = await window.electronAPI.performPrAction(request);
      onChanged?.();
      window.dispatchEvent(new CustomEvent('gnosis-pr-action-completed', { detail: [request.url] }));
      if (current.current === started) {
        announce(response.message);
        void refresh();
      }
    } catch (e) {
      toast.add({ type: 'error', title: 'Nothing changed', description: githubWriteError(e).message });
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const plan = dialog?.plan;
  const nativeCount = state?.stack?.members.filter((m) => m.state !== 'MERGED').findIndex((m) => m.url === state.url);
  // A PR that changes workflow files needs a sign-in with `workflow` to merge or rebase; GitHub refuses otherwise.
  const access = useGitHubAccess();
  const workflowFiles = useWorkflowFiles(member);
  const noWorkflow = lacksWorkflow(access?.scopes);
  const workflowReason = (target: PrActionState, action: 'merge' | 'update-rebase') =>
    workflowPermissionReason(target, action, noWorkflow, workflowFiles);
  const blocked = state
    ? (mergeBlockedReason(state) ?? (stackMembers ? undefined : workflowReason(state, 'merge')))
    : CHECKING;
  const mergeLabel =
    state?.stack && nativeCount !== undefined && nativeCount > 0
      ? `Merge through #${member.number}`
      : state?.mergeQueue
        ? 'Add to merge queue'
        : 'Merge';
  const updateBlocked = state ? branchUpdateBlockedReason(state) : CHECKING;
  const conflicted = hasConflicts || (!!state && hasMergeConflicts(state));
  // "3 files conflict. 7 of 9 conflicts are merged and checked. 2 need you.", from background preparation.
  const conflictLine = useConflictHeader(member.url, member.headSha, conflicted && header);
  const rebaseBlocked = updateBlocked ?? (state ? workflowReason(state, 'update-rebase') : undefined);
  // Either copy saying merged or closed is enough: Merge never shows for a PR that may be done.
  const merged = member.merged || state?.state === 'MERGED';
  const closed = !merged && (member.state === 'closed' || state?.state === 'CLOSED');
  const active = !merged && !closed && !state?.archived;
  // "Merged main into this PR · Undo this update", while your pushed merge commit is the head (#445 item 25).
  const [pushedUpdate, rereadPushed] = useConflictPushed(member.url, state?.headSha ?? member.headSha, active && header);
  const kind = dialog?.kind;
  const members = plan ? (kind === 'merge' ? plan.members : [plan.target]) : [];
  const heading =
    kind === 'merge'
      ? plan?.createStack
        ? 'Create GitHub stack and merge'
        : plan?.mergeQueue
          ? 'Add to merge queue'
          : members.length > 1
            ? 'Merge stack'
            : 'Merge pull request'
      : kind === 'delete-branch'
        ? 'Delete branch'
        : kind === 'update-rebase'
          ? 'Update branch with rebase'
          : 'Update branch with merge commit';
  const showMethod = kind === 'merge' && !plan?.mergeQueue;
  const actionBlock = plan && kind
    ? (actionBlockedReason(kind, plan.target, (action) => workflowReason(plan.target, action), plan) ??
      (showMethod && !plan.methods.includes(method) ? `${mergeMethodLabels[method]} is not allowed in ${plan.target.repository}. Choose another method.` : undefined))
    : undefined;
  // Several consequential steps get a step card; a single PR keeps one short confirmation beside Merge.
  const stepFlow =
    kind === 'merge' && (plan ? plan.members.length > 1 : !!stackMembers || (!!state?.stack && (nativeCount ?? 0) > 0));
  const popover = kind === 'merge' && !stepFlow;
  // Draft and Auto-merge on GitHub's state, as shown.
  const isDraft = !!state?.isDraft || (!state && member.isDraft);
  const draftReason = state ? draftActionBlockedReason(state, isDraft ? 'mark-ready' : 'convert-draft') : CHECKING;
  const autoMerge = state?.autoMerge ?? null;
  const autoReason = state ? actionBlockedReason(autoMerge ? 'disable-auto' : 'enable-auto', state, (action) => workflowReason(state, action)) : CHECKING;
  // While either setting is being sent, both wait: each reads GitHub's state before it acts.
  const anySending = sendingChanges.length > 0;
  const mergePrimary = mergeReady && !blocked && !conflicted && active;
  // The header's shortcuts read the latest state through a ref, so the listener stays put.
  const shortcut = useRef<(key: 'm' | 'u') => void>(() => {});
  shortcut.current = (key) => {
    if (key === 'u') {
      // Collapsed into ⋯, Update has no menu of its own to open here.
      if (!updateBlocked && !busy && collapse < 2) setUpdateOpen(true);
    } else if (conflicted) openConflictWorkspace(member.url);
    else if (!blocked && !busy && !loading) void open('merge');
  };
  useEffect(() => {
    if (!shortcuts || !header) return;
    const keydown = (event: KeyboardEvent) => {
      const key = isShortcut(event, 'm') ? 'm' : isShortcut(event, 'u') ? 'u' : undefined;
      if (!key || event.defaultPrevented) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.isContentEditable || target?.closest('input, textarea, select, [role=dialog], [role=menu]')) return;
      event.preventDefault();
      shortcut.current(key);
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [shortcuts, header]);
  // In a short row, the toggles and then Update join the header's ⋯ menu.
  const overflow: EntryActionGroups =
    header && collapse && active
      ? [[
          { label: isDraft ? 'Mark ready for review' : 'Convert to draft', disabled: !!draftReason || busy || anySending, detail: draftReason, run: () => void quick(isDraft ? 'mark-ready' : 'convert-draft') },
          { label: autoMerge ? 'Turn off auto-merge' : 'Turn on auto-merge', disabled: !!autoReason || busy || anySending, detail: autoReason, run: () => void quick(autoMerge ? 'disable-auto' : 'enable-auto') },
          ...(collapse > 1 ? [
            { label: 'Update with merge commit…', disabled: !!updateBlocked || busy, detail: updateBlocked, run: () => void open('update-merge') },
            { label: 'Update with rebase…', disabled: !!rebaseBlocked || busy, detail: rebaseBlocked, run: () => void open('update-rebase') },
          ] : []),
        ]]
      : [];
  const overflowKey = JSON.stringify(overflow.flat().map((action) => [action.label, action.disabled, action.detail]));
  const latestOverflow = useRef(overflow);
  latestOverflow.current = overflow;
  useEffect(() => {
    onOverflow?.(latestOverflow.current);
  }, [overflowKey, onOverflow]);
  useEffect(() => () => onOverflow?.([]), [onOverflow]);
  const membersList = plan ? (
    <ol className="pr-action-members">
      {members.map((m) => {
        const source =
          stackMembers?.find((candidate) => candidate.url === m.url) ?? (member.url === m.url ? member : undefined);
        return (
          <li key={m.url}>
            <div className="entity-badge-group">
              <PrBadge url={m.url} number={m.number} title={m.title} />
              <PrStateIcon pr={source ?? { url: m.url }} size={14} />
              <a href={m.url} target="_blank" rel="noreferrer" tabIndex={popover ? -1 : undefined}>
                {m.title}
                <ExternalLink size={12} />
              </a>
            </div>
            <span>
              <BranchBadge branch={m.headBranch} repo={source?.headRepo} /> ·{' '}
              <CommitBadge sha={m.headSha} repo={source?.headRepo} />
            </span>
          </li>
        );
      })}
    </ol>
  ) : null;
  const methodFields = plan ? (
    <>
      {showMethod && popover && (
        // Beside Merge, the repository's two or three methods are one choice away.
        <fieldset className="pr-merge-methods" aria-label="Merge method" disabled={busy}>
          <legend>Merge method</legend>
          {plan.methods.map((value) => (
            <label key={value}>
              <input type="radio" name="merge-method" value={value} checked={method === value} onChange={() => setMethod(value)} />
              {mergeMethodLabels[value]}
            </label>
          ))}
        </fieldset>
      )}
      {showMethod && !popover && (
        <label className="pr-action-field">
          Merge method
          <SearchableSelect
            label="Merge method"
            value={method}
            options={plan.methods.map((value) => ({ value, label: mergeMethodLabels[value] }))}
            onValueChange={(v) => setMethod(v as MergeMethod)}
            disabled={busy}
          />
        </label>
      )}
      {showMethod && method !== 'REBASE' && (
        <details className="pr-action-message">
          <summary>Customize commit message</summary>
          <p>Leave blank to use GitHub’s repository defaults.</p>
          <label>
            Commit title
            <input
              aria-label="Commit title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={256}
              disabled={busy}
            />
          </label>
          <label>
            Commit message
            <textarea
              aria-label="Commit message"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={65536}
              rows={3}
              disabled={busy}
            />
          </label>
        </details>
      )}
    </>
  ) : null;
  async function submit() {
    if (!plan || !kind || pending.current || actionBlock) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setErrorStep('submit');
    const started = current.current;
    try {
      const response = await window.electronAPI.performPrAction({
        account: plan.target.account,
        kind,
        url: plan.target.url,
        revisions: members.map(revision),
        method: showMethod ? method : undefined,
        createStack: kind === 'merge' && plan.createStack,
        ...(showMethod && method !== 'REBASE' ? { commitTitle: title, commitBody: body } : {}),
      });
      onChanged?.();
      window.dispatchEvent(new CustomEvent('gnosis-pr-action-completed', { detail: members.map((m) => m.url) }));
      if (current.current === started) {
        setDialog(undefined);
        announce(response.message);
        void refresh();
      }
    } catch (e) {
      // GitHub's workflow-scope refusal reads as "Needs the workflow permission", with Sign in again.
      if (current.current === started) setError(githubWriteError(e).message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const stepPlan = stackMergeSteps(plan, {
    page,
    method,
    loading,
    running: busy,
    count: stackMembers?.filter((m) => !m.merged).length,
    failure: error
      ? {
          step: errorStep === 'submit' ? 'merge' : 'review',
          message:
            errorStep === 'submit' && error !== WORKFLOW_WRITE_MESSAGE
              ? `${error} If GitHub may have received the request, check the PR before trying again.`
              : error,
        }
      : undefined,
  });
  const cancel = () => {
    version.current++;
    setDialog(undefined);
    setLoading(false);
    setError('');
  };
  if (!member.url.startsWith('https://github.com/')) return null;
  const description = plan
    ? `${plan.target.repository} · ${kind?.startsWith('update-') ? `${plan.target.baseBranch} → ${plan.target.headBranch}` : kind === 'delete-branch' ? plan.target.headBranch : `${members.length} PR${members.length === 1 ? '' : 's'} → ${plan.baseBranch}`}`
    : 'Checking GitHub permissions and current revisions…';
  // One confirmation's body, in the Merge popover or a dialog.
  const confirmation = (
    <>
      {loading && (
        <p className="pr-action-note" role="status">
          <Loader2 size={16} className="motion-safe:animate-spin" />
          Checking GitHub…
        </p>
      )}
      {plan && (
        <>
          {membersList}
          {plan.createStack && kind === 'merge' && (
            <p className="pr-action-note">
              This will first create a GitHub stack from these branches, then request an atomic merge. If
              merging is blocked, the GitHub stack remains.
            </p>
          )}
          {kind === 'merge' && members.length === 1 && blockedButMet(plan.target) && !actionBlock && (
            <p className="pr-action-note" data-github-blocked>
              GitHub reports this PR as blocked to Gnosis’s sign-in, though every requirement Gnosis can see is
              met. If GitHub refuses the merge, its reason shows here and nothing merges.
            </p>
          )}
          {kind === 'merge' && members.length > 1 && (
            <p className="pr-action-note">
              GitHub checks every PR’s requirements. All listed PRs merge together, or none do.
              {plan.mergeQueue ? ' They will enter the base branch’s merge queue.' : ''}
            </p>
          )}
          {kind === 'delete-branch' && (
            <p className="pr-action-note">
              GitHub deletes {plan.target.headBranch} only while it still ends at this PR’s last commit. The PR keeps
              its commits, and GitHub can restore the branch from the PR page.
            </p>
          )}
          {kind?.startsWith('update-') && (
            <p className="pr-action-note">
              {kind === 'update-rebase'
                ? 'Rebase rewrites the PR’s commits on top of the base branch. Collaborators may need to resynchronize their local branches.'
                : 'A merge commit brings the base branch’s changes into this PR.'}{' '}
              Checks may run again and approvals may be dismissed by repository rules.
            </p>
          )}
          {methodFields}
          {actionBlock && (
            <p role="status" className="pr-action-note">
              {actionBlock}
            </p>
          )}
        </>
      )}
      {error === WORKFLOW_WRITE_MESSAGE ? (
        // GitHub refused the write outright, so nothing changed and there is nothing to check first.
        <div role="alert" className="pr-action-error" data-workflow-permission>
          <GitHubScopePrompt
            message={WORKFLOW_WRITE_MESSAGE}
            onSignIn={() => {
              cancel();
              startGitHubSignIn();
            }}
            onUseToken={() => {
              cancel();
              requestTokenSignIn();
            }}
          />
        </div>
      ) : error && (
        <div role="alert" className="pr-action-error">
          <p>{error}</p>
          <p>If GitHub may have received the request, check the PR before trying again.</p>
          <a href={plan?.target.url ?? member.url} target="_blank" rel="noreferrer">
            Open on GitHub
          </a>
          <button disabled={busy} onClick={() => kind && void open(kind, method)}>
            Refresh confirmation
          </button>
        </div>
      )}
    </>
  );
  const confirmButtons = (
    <>
      <Button variant="outline" size={popover ? 'sm' : 'default'} disabled={busy} onClick={cancel}>
        Cancel
      </Button>
      <Button
        size={popover ? 'sm' : 'default'}
        variant={kind === 'delete-branch' ? 'destructive' : 'default'}
        onClick={() => void submit()}
        disabled={!plan || loading || busy || !!actionBlock || !!error || (showMethod && !plan.methods.includes(method))}
      >
        {busy ? (
          <>
            <Loader2 size={14} className="motion-safe:animate-spin" />
            Submitting…
          </>
        ) : (
          heading
        )}
      </Button>
    </>
  );
  const mergeShortcut = shortcuts ? shortcutLabel('M') : undefined;
  const mergeMethods = state && !state.mergeQueue ? state.methods : undefined;
  const mergeControl = (
    <Popover.Root open={popover} onOpenChange={(value) => { if (!value && !busy) cancel(); }}>
      <CloseWhenHidden open={popover} onClose={() => { if (!pending.current) cancel(); }} content={confirmContent} />
      <Popover.Anchor asChild>
        <span className="pr-merge-anchor">
          {trigger ? (
            trigger((next, preferred) => void open(next, preferred), busy, (next) => void quick(next), {
              allowed: state?.methods,
              load: () => {
                if (state) return;
                const n = version.current;
                void window.electronAPI.getPrActionState(member.url).then((next) => {
                  if (version.current === n) setState(next);
                }, () => undefined);
              },
            })
          ) : conflicted ? (
            <Button size="sm" title={conflictLine ? conflictHeaderLine(conflictLine) : mergeShortcut && `Resolve conflicts (${mergeShortcut})`} onClick={() => openConflictWorkspace(member.url)}>
              <ConflictIcon size={14} aria-hidden="true" />
              {conflictLine?.state === 'ready' && conflictLine.merged ? 'Review and push…' : 'Resolve conflicts…'}
            </Button>
          ) : (
            <MergeSplit label={mergeLabel} primary={mergePrimary} reason={loading && !state ? CHECKING : blocked} busy={busy && kind === 'merge'}
              shortcut={mergeShortcut} methods={mergeMethods} current={state?.defaultMethod} icon={<GitMerge size={14} aria-hidden="true" />}
              onMerge={(preferred) => void open('merge', preferred)} />
          )}
        </span>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content ref={confirmContent} className="pr-merge-confirm" align="end" sideOffset={6} collisionPadding={12} aria-label={heading} tabIndex={-1}
          onOpenAutoFocus={(event) => { event.preventDefault(); (event.currentTarget as HTMLElement).focus(); }}
          onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
          onInteractOutside={(event) => {
            // The method list and other pickers open in their own layer; using them keeps the confirmation open.
            const target = event.target instanceof Element ? event.target : null;
            if (busy || target?.closest('.selection-positioner, [data-slot="combobox-content"], [role=menu]')) event.preventDefault();
          }}>
          <h2>{heading}</h2>
          <p className="pr-merge-confirm-description">{description}</p>
          {confirmation}
          <div className="pr-merge-confirm-footer">{confirmButtons}</div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
  const noteContent = (
    <>
      {header && conflictLine && (
        <p role="status" className="pr-action-note pr-conflict-line" data-conflict-header={conflictLine.state}>
          {conflictLine.state === 'checking' && (
            <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden="true" />
          )}
          {conflictHeaderLine(conflictLine)}
        </p>
      )}
      {header && pushedUpdate && (
        <p role="note" className="pr-action-note pr-conflict-line" data-conflict-pushed="">
          <span>Merged {pushedUpdate.baseBranch} into this PR</span>
          <span aria-hidden="true">·</span>
          <ConflictUndo
            update={pushedUpdate}
            onUndone={() => {
              // The head moves back only once GitHub's read catches up: read the saved draft again now.
              rereadPushed();
              void refresh();
              onChanged?.();
            }}
          />
        </p>
      )}
      {!dialog && error && (
        <p role="alert" className="pr-action-error">
          {error}
          <button onClick={() => void (stackMembers ? open('merge') : refresh())}>Retry loading actions</button>
        </p>
      )}
      {sending && (
        <p role="status" className="sr-only github-sending">
          {sending.action === 'mark-ready'
            ? 'Marking ready for review…'
            : sending.action === 'convert-draft'
              ? 'Converting to draft…'
              : sending.action === 'enable-auto-merge'
                ? 'Turning on auto-merge…'
                : 'Turning off auto-merge…'}
        </p>
      )}
      {(['mark-ready', 'convert-draft', 'enable-auto-merge', 'disable-auto-merge'] as const).map((action) => (
        <WriteFailureNotice key={action} failureKey={`pr-action:${member.url}:${action}`} className="pr-action-error" />
      ))}
    </>
  );
  return (
    <div className={`pr-actions ${stackMembers ? 'pr-actions-stack' : ''} ${header ? 'pr-header-actions' : ''}`} data-collapse={header ? collapse : undefined}>
      {stackMembers ? (
        <Button
          size="sm"
          variant={mergeReady ? 'default' : 'outline'}
          data-merge-action
          onClick={() => void open('merge')}
          disabled={busy || stackMembers.every((m) => m.merged || m.state === 'closed')}
        >
          <GitMerge size={14} />
          Merge whole stack…
        </Button>
      ) : trigger ? (
        mergeControl
      ) : (
        <>
          {active && !collapse && (
            <span className="pr-action-group" data-collapse-at="1">
              <ActionToggle label="Draft" checked={isDraft} reason={draftReason} busy={anySending || busy} onToggle={() => void quick(isDraft ? 'mark-ready' : 'convert-draft')} />
              <ActionToggle label="Auto-merge" checked={!!autoMerge} detail={autoMerge ? methodShort[autoMerge] : undefined} reason={autoReason} busy={anySending || busy}
                onToggle={() => void quick(autoMerge ? 'disable-auto' : 'enable-auto')}>
                <MethodMenu label="Auto-merge method" methods={state?.methods ?? []} allowed={state?.methods} current={autoMerge ?? state?.defaultMethod}
                  reason={autoMerge ? 'Turn auto-merge off to change its method.' : (autoReason ?? (busy ? CHECKING : undefined))} onPick={(picked) => void quick('enable-auto', picked)} />
              </ActionToggle>
            </span>
          )}
          {active && collapse < 2 && (
            <span className="pr-action-group" data-collapse-at="2">
              <UpdateMenu reason={updateBlocked} rebaseReason={rebaseBlocked} baseBranch={state?.baseBranch ?? member.baseBranch} headBranch={state?.headBranch ?? member.headBranch}
                busy={busy} open={updateOpen} onOpenChange={setUpdateOpen} shortcut={shortcuts ? shortcutLabel('U') : undefined}
                onUpdate={(next) => void open(next)} />
            </span>
          )}
          {merged && state?.headBranchExists !== false && (
            <HeaderAction reason={state ? deleteBranchBlockedReason(state) : CHECKING} busy={busy} onClick={() => void open('delete-branch')}>
              <Trash2 size={14} aria-hidden="true" />
              Delete branch…
            </HeaderAction>
          )}
          {merged && (
            <HeaderAction title="Opens the PR on GitHub, where Revert makes a new PR that undoes it" onClick={() => void window.electronAPI.openExternal(member.url)}>
              <Undo2 size={14} aria-hidden="true" />
              Revert…
            </HeaderAction>
          )}
          {closed && (
            <HeaderAction reason={state ? reopenBlockedReason(state) : CHECKING} busy={busy} onClick={() => void quick('reopen')}>
              <GitPullRequestArrow size={14} aria-hidden="true" />
              Reopen
            </HeaderAction>
          )}
          {/* Resolve conflicts in Merge's place is the next step, so it is the primary action then. */}
          {review?.(!mergePrimary && !(conflicted && active))}
          {active && mergeControl}
        </>
      )}
      {header && notes ? createPortal(noteContent, notes) : noteContent}
      <Dialog
        open={!!dialog && !popover}
        onOpenChange={(value) => {
          if (!value && !busy) cancel();
        }}
      >
        <DialogContent
          showCloseButton={!busy}
          className="pr-action-dialog"
          onOpenAutoFocus={(e) => {
            // The step card focuses its first step once the plan loads, so Enter continues from there.
            if (stepFlow) {
              e.preventDefault();
              (e.currentTarget as HTMLElement | null)?.focus();
            }
          }}
          onEscapeKeyDown={(e) => {
            if (busy) e.preventDefault();
          }}
          onPointerDownOutside={(e) => {
            if (busy) e.preventDefault();
          }}
        >
          {stepFlow ? (
            <StepCard
              autoFocus
              className="pr-action-steps"
              title={<DialogTitle>{heading}</DialogTitle>}
              description={
                <DialogDescription>
                  {plan
                    ? `${plan.target.repository} · ${members.length} PRs → ${plan.baseBranch}`
                    : 'Checking GitHub permissions and current revisions…'}
                </DialogDescription>
              }
              steps={stepPlan.steps}
              current={stepPlan.current}
              busy={busy}
              onCancel={cancel}
              onBack={
                plan && page !== 'review'
                  ? () => setPage(page === 'confirm' && !plan.mergeQueue ? 'method' : 'review')
                  : undefined
              }
              onRetry={() => void open('merge')}
              retryLabel={errorStep === 'submit' && error ? 'Refresh confirmation' : 'Refresh'}
              continueLabel={
                page === 'confirm' ? (
                  busy ? (
                    <>
                      <Loader2 size={14} className="motion-safe:animate-spin" />
                      Submitting…
                    </>
                  ) : (
                    heading
                  )
                ) : (
                  'Continue'
                )
              }
              continueDisabled={
                !plan ||
                loading ||
                !!error ||
                !!actionBlock ||
                (page !== 'review' && showMethod && !plan.methods.includes(method))
              }
              onContinue={() => {
                if (page === 'review') setPage(plan?.mergeQueue ? 'confirm' : 'method');
                else if (page === 'method') setPage('confirm');
                else void submit();
              }}
            >
              {plan ? (
                <>
                  {page === 'review' && (
                    <>
                      {membersList}
                      <p className="pr-action-note">
                        GitHub checks every PR’s requirements at the revisions listed here. If a PR changes, nothing
                        merges and you confirm again.
                      </p>
                    </>
                  )}
                  {page === 'method' && methodFields}
                  {page === 'confirm' && (
                    <div className="pr-action-confirm">
                      <p>Gnosis will send {plan.createStack ? 'two GitHub requests' : 'one GitHub request'}:</p>
                      <ol>
                        {plan.createStack && (
                          <li>
                            Create a GitHub stack from {members.map((m) => `#${m.number}`).join(', ')}. It remains if
                            merging is blocked.
                          </li>
                        )}
                        <li>
                          {plan.mergeQueue
                            ? `Add all ${members.length} PRs to the ${plan.baseBranch} merge queue together.`
                            : `Merge all ${members.length} PRs into ${plan.baseBranch} together with “${mergeMethodLabels[method]}”${title.trim() ? `, titled “${title.trim()}”` : ''}.`}
                        </li>
                      </ol>
                      <p className="pr-action-note">
                        This cannot be undone from Gnosis. GitHub merges all of them or none; follow its progress in
                        Activity.
                      </p>
                    </div>
                  )}
                </>
              ) : undefined}
            </StepCard>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{heading}</DialogTitle>
                <DialogDescription>{description}</DialogDescription>
              </DialogHeader>
              {confirmation}
              <DialogFooter>{confirmButtons}</DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
