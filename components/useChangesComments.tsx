import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DiffLineAnnotation, SelectedLineRange } from '@pierre/diffs';
import type { PrChanges } from '../lib/pr-changes';
import type { GitHubReviewThread as Thread } from '../lib/review-threads';
import { useChangesReviewDrafts, type ChangesReviewDraft } from '../lib/changes-review-drafts';
import { briefAppliesTo, briefLines, useAgentBrief, type AgentBriefComment, type AgentBriefPin } from '../lib/agent-brief';
import { toast } from './ui/toast';
import { ReviewDraftScope, useSessionDraft } from '../lib/session-drafts';
import { GitHubReviewThread } from './GitHubReviewThread';
import { ChangesCommentComposer } from './ChangesCommentComposer';
import { ChangesDraftComment } from './ChangesDraftComment';
import { SubmitReviewDialog } from './SubmitReviewDialog';
import { Button } from './ui/button';

type Location = { line: number; startLine?: number; side: 'LEFT' | 'RIGHT'; startSide?: 'LEFT' };
interface Annotation {
  threads: Thread[];
  drafts: ChangesReviewDraft[];
  brief: AgentBriefComment[];
  composer?: Location;
}
/** Where a comment goes when it is added to the agent brief of the subject under review. */
export interface ChangesBriefTarget {
  subjectId: string;
  pin: AgentBriefPin;
  code: (location: Location) => Pick<AgentBriefComment, 'code' | 'codeLinesOmitted'>;
  onOpen?: () => void;
}
export function useChangesComments({
  brief,
  snapshot,
  path,
  activeKey,
  inline,
  replaceThread,
  refresh,
  enabled = true,
  renderThreadOverride,
  onSubmitted,
  onOpenChanges,
}: {
  brief?: ChangesBriefTarget;
  enabled?: boolean;
  renderThreadOverride?: (thread: Thread) => ReactNode;
  onOpenChanges?: (filePath: string) => void;
  onSubmitted?: (url: string, event: string) => void;
  snapshot?: PrChanges;
  path?: string;
  activeKey: string;
  inline: Thread[];
  replaceThread: (url: string, thread: Thread) => void;
  refresh: (url: string) => Promise<void>;
}) {
  const [account, setAccount] = useState('');
  const [authError, setAuthError] = useState('');
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void window.electronAPI
      .getAuthState()
      .then((auth) => {
        if (!cancelled) {
          setAccount(auth.authenticated ? (auth.login ?? '') : '');
          if (!auth.authenticated) setAuthError('Connect GitHub to comment.');
        }
      })
      .catch(() => {
        if (!cancelled) setAuthError('Could not check your GitHub account. Reopen Changes to try again.');
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  const url = snapshot?.url ?? '';
  const { drafts, update } = useChangesReviewDrafts(account, url);
  const agentBrief = useAgentBrief(brief?.subjectId ?? '');
  const [composer, setComposer] = useSessionDraft<Location | null>(`changes-composer:${account}:${activeKey}`, null);
  const [reviewOpen, setReviewOpen] = useState(false),
    [draftsOpen, setDraftsOpen] = useState(false),
    [error, setError] = useState('');
  const [target, setTarget] = useState<PrChanges>();
  const submitting = useRef(false);
  const writable = enabled && !!account && snapshot?.metadata.state === 'open' && !snapshot.metadata.merged;
  const current = (d: ChangesReviewDraft) =>
    d.headSha === snapshot?.metadata.headSha &&
    d.baseSha === snapshot.metadata.baseSha &&
    d.baseBranch === snapshot.metadata.baseBranch;
  const stale = drafts.filter((d) => !current(d));
  async function change(fn: (list: ChangesReviewDraft[]) => ChangesReviewDraft[]) {
    try {
      await update(fn);
      setError('');
    } catch {
      setError('Could not save your drafts on this computer. Free some disk space and try again.');
      throw new Error('Could not save your drafts.');
    }
  }
  const remove = async (id: string) => {
    try {
      await change((list) => list.filter((d) => d.id !== id));
    } catch {
      /* shown above */
    }
  };
  const edit = (id: string, body: string) => change((list) => list.map((d) => (d.id === id ? { ...d, body } : d)));
  const changeBrief = async (fn: (list: AgentBriefComment[]) => AgentBriefComment[]) => {
    try {
      await agentBrief.update(fn);
      setError('');
    } catch {
      setError('Could not save your local notes on this computer. Free some disk space and try again.');
      throw new Error('Could not save your local notes.');
    }
  };
  const renderThread = (thread: Thread) => renderThreadOverride ? renderThreadOverride(thread) : (
    <GitHubReviewThread
      key={thread.id}
      thread={thread}
      onAction={
        account
          ? async (action, body) => {
              const next = await window.electronAPI.reviewThreadAction({
                prUrl: url,
                threadId: thread.id,
                action,
                body,
              });
              replaceThread(url, next);
            }
          : undefined
      }
      onCommentAction={
        account
          ? async (commentId, action, body) => {
              const next = await window.electronAPI.reviewCommentAction({
                prUrl: url,
                threadId: thread.id,
                commentId,
                action,
                body,
              });
              replaceThread(url, next);
            }
          : undefined
      }
    />
  );
  const annotations: DiffLineAnnotation<Annotation>[] = [];
  const location = (line: number, side: Location['side']) => {
    const name = side === 'LEFT' ? 'deletions' : 'additions';
    let a = annotations.find((a) => a.lineNumber === line && a.side === name);
    if (!a) {
      a = { lineNumber: line, side: name, metadata: { threads: [], drafts: [], brief: [] } };
      annotations.push(a);
    }
    return a.metadata;
  };
  inline.forEach((t) => t.line !== null && location(t.line, t.diffSide).threads.push(t));
  drafts.filter((d) => current(d) && d.filePath === path).forEach((d) => location(d.line, d.side).drafts.push(d));
  if (brief)
    agentBrief.comments
      .filter((c) => briefAppliesTo(c, brief.pin))
      .forEach((c) => location(c.line, c.side).brief.push(c));
  if (composer) location(composer.line, composer.side).composer = composer;
  const canComment = writable || !!brief;
  function begin(range: SelectedLineRange) {
    if (!canComment) return;
    if (range.endSide && range.endSide !== range.side) {
      if (!brief) {
        setError('Select lines on one side of the diff to comment.');
        return;
      }
      // Dragging across a changed block is natural. Only GitHub requires a single side.
      setError('');
      setComposer({
        line: range.side === 'additions' ? range.start : range.end,
        startLine: range.side === 'additions' ? range.end : range.start,
        side: 'RIGHT',
        startSide: 'LEFT',
      });
      return;
    }
    setError('');
    const start = Math.min(range.start, range.end),
      line = Math.max(range.start, range.end);
    setComposer({
      line,
      ...(start !== line ? { startLine: start } : {}),
      side: range.side === 'deletions' ? 'LEFT' : 'RIGHT',
    });
  }
  const renderAnnotation = ({ metadata }: DiffLineAnnotation<Annotation>) => (
    <>
      {metadata.threads.map(renderThread)}
      {metadata.drafts.map((d) => (
        <div className="changes-pending-comment" key={d.id}>
          <span>Pending review · Only you can see this</span>
          <ChangesDraftComment comment={d} onRemove={remove} onEdit={edit} />
        </div>
      ))}
      {metadata.brief.map((c) => (
        <div className="changes-pending-comment" key={c.id}>
          <span>
            Local note · Only you can see this
            {brief?.onOpen && (
              <button type="button" className="changes-brief-link" onClick={brief.onOpen}>
                Open local notes
              </button>
            )}
          </span>
          <ChangesDraftComment
            noun="note"
            comment={c}
            onRemove={async (id) => {
              await agentBrief.remove(new Set([id]));
              const notification = toast.add({
                title: 'Local note deleted',
                description: 'Undo is also available in Local notes until you close Gnosis.',
                actionProps: {
                  children: 'Undo deletion',
                  onClick: () => {
                    toast.update(notification, { actionProps: { children: 'Restoring…', disabled: true } });
                    void agentBrief.restore(new Set([id])).then(() => toast.close(notification)).catch(() => {
                      toast.update(notification, { title: 'Could not restore notes', description: 'Open Local notes and try Undo deletion again.', type: 'error' });
                    });
                  },
                },
              });
            }}
            onEdit={(id, body) => changeBrief((list) => list.map((d) => (d.id === id ? { ...d, body } : d)))}
          />
        </div>
      ))}
      {metadata.composer && path && (snapshot || brief) && (
        <ChangesCommentComposer
          key={`${activeKey}:${metadata.composer.startSide ?? ''}:${metadata.composer.side}:${metadata.composer.startLine ?? ''}:${metadata.composer.line}`}
          draftKey={`${account}:${activeKey}:${metadata.composer.startSide ?? ''}:${metadata.composer.side}:${metadata.composer.startLine ?? ''}:${metadata.composer.line}`}
          label={`Comment on ${briefLines(metadata.composer)} · ${brief?.pin.view === 'combined' ? 'Combined stack' : `PR #${(url || (brief?.pin.url ?? '')).split('/').pop()}`}`}
          onCancel={() => setComposer(null)}
          note={
            writable && metadata.composer.startSide
              ? 'GitHub comments need lines from one side of the diff, so save this selection as a local note.'
              : undefined
          }
          onSave={
            writable && !metadata.composer.startSide
              ? async (body, now) => {
                  const req = {
                    prUrl: url,
                    headSha: snapshot.metadata.headSha,
                    baseSha: snapshot.metadata.baseSha,
                    baseBranch: snapshot.metadata.baseBranch,
                    path,
                    body,
                    ...(metadata.composer as Location),
                  };
                  if (now) {
                    await window.electronAPI.createReviewComment(req);
                    await refresh(url);
                  } else
                    await change((list) => [
                      ...list,
                      { id: crypto.randomUUID(), filePath: path, hunkHeader: '', codeSnippet: '', slideIndex: 0, ...req },
                    ]);
                }
              : undefined
          }
          onAddToBrief={
            brief
              ? async (body) => {
                  const where = metadata.composer as Location;
                  const comment: AgentBriefComment = {
                    ...brief.pin,
                    ...where,
                    ...brief.code(where),
                    id: crypto.randomUUID(),
                    createdAt: new Date().toISOString(),
                    body,
                  };
                  await changeBrief((list) => [...list, comment]);
                }
              : undefined
          }
        />
      )}
    </>
  );
  // Keep submission bound to the captured PR even if the file/stack selection changes.
  const targetDrafts = target && target.url === url ? drafts : [];
  return {
    ready: !!account || !!authError,
    openReview: () => {
      if (stale.length) {
        setDraftsOpen(true);
        return;
      }
      if (!writable) {
        setError('Connect GitHub and open a current, open PR to submit a review.');
        return;
      }
      setTarget(snapshot);
      setReviewOpen(true);
    },
    feedback: error ? (
      <p className="changes-notice" role="alert">
        {error}
      </p>
    ) : null,
    draftCount: drafts.length,
    annotations,
    renderAnnotation,
    renderThread,
    begin,
    writable,
    canComment,
    composer,
    controls: (
      <>
        <Button variant="outline" size="sm" disabled={!account || !snapshot} onClick={() => setDraftsOpen((v) => !v)}>
          Drafts{drafts.length ? ` (${drafts.length})` : ''}
        </Button>
        <Button
          size="sm"
          disabled={!writable || !!stale.length}
          onClick={() => {
            setTarget(snapshot);
            setReviewOpen(true);
          }}
        >
          Review PR #{url.split('/').pop() ?? ''}
          {drafts.length ? ` (${drafts.length})` : ''}
        </Button>
      </>
    ),
    panel: (
      <>
        {(error || authError) && (
          <p className="changes-notice" role="alert">
            {error || authError}
          </p>
        )}
        {!!stale.length && (
          <p className="changes-notice" role="status">
            {stale.length} draft{stale.length === 1 ? ' refers' : 's refer'} to an earlier version. Open Drafts to copy
            or remove them before reviewing this version.
            <button onClick={() => setDraftsOpen(true)}>Show drafts</button>
            {onOpenChanges && <button onClick={() => onOpenChanges(stale[0].filePath)}>Open Changes to reposition</button>}
          </p>
        )}
        {draftsOpen && (
          <section className="changes-drafts" aria-label="Pending review comments">
            <header>
              <h3>Pending review · PR #{url.split('/').pop()}</h3>
              <Button variant="ghost" size="sm" onClick={() => setDraftsOpen(false)}>
                Close drafts
              </Button>
            </header>
            {!drafts.length && (
              <p>No draft comments yet. Use the + beside a line or select lines and choose Comment.</p>
            )}
            {drafts.map((d) => (
              <div key={d.id}>
                <p>
                  {d.filePath} · {d.side === 'LEFT' ? 'Old' : 'New'}{' '}
                  {d.startLine ? `lines ${d.startLine}–${d.line}` : `line ${d.line}`}
                  {!current(d) ? ' · Earlier version — copy your text before removing' : ''}
                </p>
                <ChangesDraftComment comment={d} onRemove={remove} onEdit={edit} />
              </div>
            ))}
          </section>
        )}
        {reviewOpen && target && target.url === url && (
          <ReviewDraftScope.Provider value={`pending-review:${account}:${url}`}>
            <SubmitReviewDialog
              key={`${url}:${target.metadata.headSha}:${target.metadata.baseSha}`}
              open
              onOpenChange={setReviewOpen}
              comments={targetDrafts}
              onEditComment={edit}
              onRemoveComment={id => change(list => list.filter(d => d.id !== id))}
              prUrl={url}
              headSha={target.metadata.headSha}
              isOwnPr={snapshot?.metadata.author === account}
              onSubmit={async (event, body) => {
                if (submitting.current) throw new Error('Review submission is already in progress.');
                submitting.current = true;
                try {
                  if (
                    targetDrafts.some(
                      (d) =>
                        d.headSha !== target.metadata.headSha ||
                        d.baseSha !== target.metadata.baseSha ||
                        d.baseBranch !== target.metadata.baseBranch
                    )
                  )
                    throw new Error('Remove drafts from earlier versions before submitting.');
                  const result = await window.electronAPI.submitReview({
                    prUrl: url,
                    headSha: target.metadata.headSha,
                    baseSha: target.metadata.baseSha,
                    baseBranch: target.metadata.baseBranch,
                    event,
                    body,
                    comments: targetDrafts.map((d) => ({
                      path: d.filePath,
                      line: d.line,
                      startLine: d.startLine,
                      side: d.side,
                      body: d.body,
                    })),
                  });
                  const ids = new Set(targetDrafts.map((d) => d.id));
                  // Once GitHub succeeds, a refresh failure must never offer a duplicate submission.
                  try {
                    await change((list) => list.filter((d) => !ids.has(d.id)));
                  } catch {
                    setError(
                      'Review posted. Could not remove the local drafts; remove them before starting another review.'
                    );
                  }
                  onSubmitted?.(url, event);
                  void refresh(url);
                  return result;
                } finally {
                  submitting.current = false;
                }
              }}
            />
          </ReviewDraftScope.Provider>
        )}
      </>
    ),
  };
}
