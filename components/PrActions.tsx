import { openConflictWorkspace } from '../lib/open-conflict-workspace';
import { PrBadge, BranchBadge, CommitBadge } from './EntityBadge';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { GitMerge, RefreshCw, GitBranch, ChevronDown, Loader2, ExternalLink } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { SearchableSelect } from './SearchableSelect';
import {
  mergeBlockedReason,
  draftActionBlockedReason,
  branchUpdateBlockedReason,
  singleMergePlan,
  mergeMethodLabels,
  type MergeMethod,
  type PrActionKind,
  type PrActionMember,
  type PrActionState,
  type PrMergePlan,
} from '../lib/pr-actions';
import type { ReviewMember } from '../lib/workbench';

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const revision = (m: PrActionMember) => ({
  url: m.url,
  headSha: m.headSha,
  baseSha: m.baseSha,
  baseBranch: m.baseBranch,
});

/** Actions only live in the PR summary; the selected source PR is always explicit. */
export function PrActions({
  member,
  stackMembers,
  onChanged,
  trigger,
  mergeReady = false,
}: {
  member: ReviewMember;
  stackMembers?: ReviewMember[];
  onChanged?: () => void;
  mergeReady?: boolean;
  /** A contextual action loads permissions only when invoked. */
  trigger?: (open: (kind: PrActionKind) => void, busy: boolean) => ReactNode;
}) {
  const [state, setState] = useState<PrActionState>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [dialog, setDialog] = useState<{ kind: PrActionKind; plan?: PrMergePlan }>();
  const [method, setMethod] = useState<MergeMethod>('SQUASH');
  const [title, setTitle] = useState(''),
    [body, setBody] = useState('');
  const [busy, setBusy] = useState(false),
    [result, setResult] = useState('');
  const version = useRef(0),
    pending = useRef(false);
  const identity = JSON.stringify([member.url, member.headSha, stackMembers?.map((m) => [m.url, m.headSha])]);
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
    setResult('');
    if (!stackMembers && !trigger) {
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
  async function open(kind: PrActionKind) {
    if (pending.current) return;
    const n = ++version.current;
    setDialog({ kind });
    setLoading(true);
    setError('');
    setTitle('');
    setBody('');
    setResult('');
    try {
      const plan = stackMembers
        ? await window.electronAPI.getStackMergePlan(stackMembers.filter((m) => !m.merged).map((m) => m.url))
        : singleMergePlan(await window.electronAPI.getPrActionState(member.url, true));
      if (version.current !== n) return;
      setState(plan.target);
      setDialog({ kind, plan });
      setMethod(
        plan.methods.includes(plan.target.defaultMethod) ? plan.target.defaultMethod : (plan.methods[0] ?? 'SQUASH')
      );
    } catch (e) {
      if (version.current === n) setError(messageOf(e));
    } finally {
      if (version.current === n) setLoading(false);
    }
  }
  const plan = dialog?.plan;
  const nativeCount = state?.stack?.members.filter((m) => m.state !== 'MERGED').findIndex((m) => m.url === state.url);
  const blocked = state ? mergeBlockedReason(state) : 'Checking GitHub permissions…';
  const mergeLabel =
    state?.stack && nativeCount !== undefined && nativeCount > 0
      ? `Merge through #${member.number}…`
      : state?.mergeQueue
        ? 'Add to merge queue…'
        : 'Merge PR…';
  const updateBlocked = state ? branchUpdateBlockedReason(state) : 'Checking GitHub permissions…';
  const active = state?.state === 'OPEN' && !state.archived;
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
      : kind === 'enable-auto'
        ? 'Enable auto-merge'
        : kind === 'disable-auto'
          ? 'Disable auto-merge'
          : kind === 'mark-ready'
            ? 'Mark ready for review'
            : kind === 'convert-draft'
              ? 'Convert to draft'
              : kind === 'update-rebase'
                ? 'Update branch with rebase'
                : 'Update branch with merge commit';
  const actionBlock = plan
    ? kind === 'merge'
      ? plan.blockedReason
      : kind === 'enable-auto'
        ? plan.target.stack
          ? 'GitHub does not support auto-merge for native stacked PRs.'
          : !plan.target.canEnableAuto
            ? 'GitHub does not allow auto-merge for this PR right now.'
            : undefined
        : kind === 'disable-auto'
          ? !plan.target.canDisableAuto
            ? 'You cannot disable auto-merge on this PR.'
            : undefined
          : kind === 'mark-ready' || kind === 'convert-draft'
            ? draftActionBlockedReason(plan.target, kind)
            : branchUpdateBlockedReason(plan.target)
    : undefined;
  const showMethod = kind === 'enable-auto' || (kind === 'merge' && !plan?.mergeQueue);
  async function submit() {
    if (!plan || !kind || pending.current || actionBlock) return;
    pending.current = true;
    setBusy(true);
    setError('');
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
        setResult(response.message);
        void refresh();
      }
    } catch (e) {
      if (current.current === started) setError(messageOf(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  if (!member.url.startsWith('https://github.com/')) return null;
  return (
    <div className={`pr-actions ${stackMembers ? 'pr-actions-stack' : ''}`}>
      {trigger ? trigger(kind => { void open(kind); }, busy) : stackMembers ? (
        <Button
          size="sm"
          variant={mergeReady ? 'default' : 'outline'}
          onClick={() => void open('merge')}
          disabled={busy || stackMembers.every((m) => m.merged || m.state === 'closed')}
        >
          <GitMerge size={14} />
          Merge whole stack…
        </Button>
      ) : (
        <>
          <div className="pr-action-controls">
            {(state?.mergeable === 'CONFLICTING' || state?.mergeState === 'DIRTY') && <Button size="sm" variant="outline" onClick={() => openConflictWorkspace(member.url)}>Resolve conflicts…</Button>}
            <Button
              size="sm"
              onClick={() => void open('merge')}
              disabled={loading || busy || !!blocked}
              title={blocked}
            >
              <GitMerge size={14} />
              {mergeLabel}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void open(state?.autoMerge ? 'disable-auto' : 'enable-auto')}
              disabled={
                loading ||
                busy ||
                !active ||
                !!state.stack ||
                !(state.autoMerge ? state.canDisableAuto : state.canEnableAuto)
              }
              title={state?.stack ? 'GitHub does not support auto-merge for native stacked PRs.' : undefined}
            >
              {state?.autoMerge ? 'Disable auto-merge…' : 'Enable auto-merge…'}
            </Button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <Button size="sm" variant="outline" disabled={loading || busy || !!updateBlocked} title={updateBlocked}>
                  <GitBranch size={14} />
                  Update branch
                  <ChevronDown size={13} />
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="pr-update-menu" align="start" sideOffset={5}>
                  <DropdownMenu.Item onSelect={() => void open('update-merge')}>
                    <strong>Update with merge commit</strong>
                    <span>
                      Merge {state?.baseBranch ?? member.baseBranch} into {state?.headBranch ?? member.headBranch}.
                    </span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item onSelect={() => void open('update-rebase')}>
                    <strong>Update with rebase</strong>
                    <span>
                      Replay this branch’s commits on {state?.baseBranch ?? member.baseBranch}. Commit history changes.
                    </span>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void open(state?.isDraft ? 'mark-ready' : 'convert-draft')}
              disabled={loading || busy || !active || !state.canChangeDraft}
              title={
                state && !state.canChangeDraft
                  ? 'Only the PR author or someone with write permission can change draft status.'
                  : undefined
              }
            >
              {state?.isDraft ? 'Mark ready for review…' : 'Convert to draft…'}
            </Button>
            <button
              className="workbench-icon"
              aria-label="Refresh PR actions"
              title="Refresh permissions and merge options"
              disabled={loading || busy}
              onClick={() => {
                void refresh();
                onChanged?.();
              }}
            >
              <RefreshCw size={14} className={loading ? 'motion-safe:animate-spin' : undefined} />
            </button>
          </div>
          {state && (state.mergeable === 'CONFLICTING' || state.mergeState === 'DIRTY') && (
            <p className="pr-action-note">{updateBlocked}</p>
          )}
          {state?.autoMerge && (
            <p className="pr-action-note">
              Auto-merge is on · {mergeMethodLabels[state.autoMerge]}. GitHub will merge when requirements are met.
            </p>
          )}
          {state?.stack && (
            <p className="pr-action-note">
              GitHub merges stacked PRs from the base through the selected PR. Auto-merge is not supported for native
              stacks.
            </p>
          )}
          {state && !state.canWrite && (
            <p className="pr-action-note">You do not have write permission to merge this PR.</p>
          )}
        </>
      )}
      {!dialog && error && (
        <p role="alert" className="pr-action-error">
          {error}
          <button onClick={() => void (stackMembers ? open('merge') : refresh())}>Retry loading actions</button>
        </p>
      )}
      {result && (
        <p role="status" className="pr-action-note">
          {result}
        </p>
      )}
      <Dialog
        open={!!dialog}
        onOpenChange={(value) => {
          if (!value && !busy) {
            version.current++;
            setDialog(undefined);
            setLoading(false);
            setError('');
          }
        }}
      >
        <DialogContent
          showCloseButton={!busy}
          className="pr-action-dialog"
          onEscapeKeyDown={(e) => {
            if (busy) e.preventDefault();
          }}
          onPointerDownOutside={(e) => {
            if (busy) e.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>{heading}</DialogTitle>
            <DialogDescription>
              {plan
                ? `${plan.target.repository} · ${kind?.startsWith('update-') ? `${plan.target.baseBranch} → ${plan.target.headBranch}` : `${members.length} PR${members.length === 1 ? '' : 's'} → ${plan.baseBranch}`}`
                : 'Checking GitHub permissions and current revisions…'}
            </DialogDescription>
          </DialogHeader>
          {loading && (
            <p className="pr-action-note" role="status">
              <Loader2 size={16} className="motion-safe:animate-spin" />
              Checking GitHub…
            </p>
          )}
          {plan && (
            <>
              <ol className="pr-action-members">
                {members.map((m) => {
                  const source =
                    stackMembers?.find((candidate) => candidate.url === m.url) ??
                    (member.url === m.url ? member : undefined);
                  return (
                    <li key={m.url}>
                      <div className="entity-badge-group">
                        <PrBadge url={m.url} number={m.number} title={m.title} />
                        <a href={m.url} target="_blank" rel="noreferrer">
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
              {plan.createStack && kind === 'merge' && (
                <p className="pr-action-note">
                  This will first create a GitHub stack from these branches, then request an atomic merge. If merging is
                  blocked, the GitHub stack remains.
                </p>
              )}
              {kind === 'merge' && members.length > 1 && (
                <p className="pr-action-note">
                  GitHub checks every PR’s requirements. All listed PRs merge together, or none do.
                  {plan.mergeQueue ? ' They will enter the base branch’s merge queue.' : ''}
                </p>
              )}
              {(kind === 'mark-ready' || kind === 'convert-draft') && (
                <p className="pr-action-note">
                  {kind === 'mark-ready'
                    ? 'This PR will be ready for review. It will still need to meet GitHub’s requirements before merging.'
                    : 'Draft PRs cannot be merged. Mark it ready for review again when the work is ready.'}
                </p>
              )}
              {kind === 'enable-auto' && (
                <p className="pr-action-note">
                  GitHub will merge automatically when the requirements are met, including after new commits. Turn
                  auto-merge off to stop it.
                </p>
              )}
              {kind === 'disable-auto' && (
                <p className="pr-action-note">GitHub will stop waiting to automatically merge this PR.</p>
              )}
              {kind?.startsWith('update-') && (
                <p className="pr-action-note">
                  {kind === 'update-rebase'
                    ? 'Rebase rewrites the PR’s commits on top of the base branch. Collaborators may need to resynchronize their local branches.'
                    : 'A merge commit brings the base branch’s changes into this PR.'}{' '}
                  Checks may run again and approvals may be dismissed by repository rules.
                </p>
              )}
              {showMethod && (
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
              {actionBlock && (
                <p role="status" className="pr-action-note">
                  {actionBlock}
                </p>
              )}
            </>
          )}
          {error && (
            <div role="alert" className="pr-action-error">
              <p>{error}</p>
              <p>If GitHub may have received the request, check the PR before trying again.</p>
              <a href={plan?.target.url ?? member.url} target="_blank" rel="noreferrer">
                Open on GitHub
              </a>
              <button disabled={busy} onClick={() => kind && void open(kind)}>
                Refresh confirmation
              </button>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                version.current++;
                setDialog(undefined);
                setLoading(false);
                setError('');
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void submit()}
              disabled={
                !plan || loading || busy || !!actionBlock || !!error || (showMethod && !plan.methods.includes(method))
              }
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
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
