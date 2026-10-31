import { useEffect, useMemo, useRef, useState } from 'react';
import { UnresolvedFile } from '@pierre/diffs';
import { CodeView, EditProvider, File, MultiFileDiff } from '@pierre/diffs/react';
import { Editor, type EditorFactory } from '@pierre/diffs/edit';
import { Check, Circle, Loader2, RotateCcw, Sparkles } from 'lucide-react';
import { Button } from './ui/button';
import { BranchBadge, PrBadge, RepositoryBadge } from './EntityBadge';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import {
  hasConflictMarkers,
  type ConflictReply,
  type ConflictRequest,
  type ConflictSession,
} from '../lib/conflict-resolution';

const baseOptions = {
  theme: { dark: 'pierre-dark', light: 'pierre-light' },
  overflow: 'wrap',
  expandUnchanged: false,
} as const;
function useCodeOptions() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return useMemo(() => ({ ...baseOptions, themeType: dark ? ('dark' as const) : ('light' as const) }), [dark]);
}
const createEditor: EditorFactory<undefined, undefined> = (type, opts, key) => new Editor(type, opts, key);
const errorText = (error: unknown) =>
  error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error);

/** Vanilla callback exposes complete drafts; React's UnresolvedFile wrapper owns that callback itself. */
function ConflictChoices({
  name,
  contents,
  ours,
  theirs,
  onChange,
}: {
  name: string;
  contents: string;
  ours: string;
  theirs: string;
  onChange: (text: string) => void;
}) {
  const options = useCodeOptions();
  const root = useRef<HTMLDivElement>(null);
  const callback = useRef(onChange);
  callback.current = onChange;
  useEffect(() => {
    const container = root.current;
    if (!container) return;
    const instance = new UnresolvedFile({
      ...options,
      onMergeConflictAction: () => {},
      mergeConflictActionsType: (action, owner) => {
        const group = document.createElement('div');
        group.className = 'conflict-choice-actions';
        for (const [resolution, label] of [
          ['current', `Keep ${ours}`],
          ['incoming', `Keep ${theirs}`],
          ['both', 'Keep both'],
        ] as const) {
          const button = document.createElement('button');
          button.textContent = label;
          button.onclick = () => {
            const next = owner.resolveConflict(action.conflictIndex, resolution);
            if (next) {
              owner.render({ ...next, containerWrapper: container, forceRender: true });
              callback.current(next.file.contents);
            }
          };
          group.append(button);
        }
        return group;
      },
    });
    instance.render({ file: { name, contents }, containerWrapper: container });
    return () => instance.cleanUp();
    // The component owns its draft until explicitly reset/remounted by the workspace.
  }, [name, ours, theirs, options]);
  return <div ref={root} className="conflict-code" />;
}
function ResultEditor({
  name,
  initial,
  onChange,
}: {
  name: string;
  initial: string;
  onChange: (contents: string) => void;
}) {
  const options = useCodeOptions();
  const [file] = useState(() => ({ name, contents: initial }));
  return <File file={file} edit options={options} onEditChange={(event) => onChange(event.file.contents)} />;
}
export function ConflictWorkspace({ url, onClose }: { url: string; onClose: () => void }) {
  const options = useCodeOptions();
  const [session, setSession] = useState<ConflictSession>();
  const [selected, setSelected] = useState('');
  const [contents, setContents] = useState('');
  const [mode, setMode] = useState<'conflicts' | 'edit' | 'compare'>('conflicts');
  const [epoch, setEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<ConflictReply['preview']>();
  const [instructions, setInstructions] = useState('');
  const [message, setMessage] = useState('');
  const [resetPrompt, setResetPrompt] = useState(false);
  const file = session?.files.find((f) => f.path === selected);
  const dirty = !!file && contents !== file.result;
  const unresolved = session?.files.filter((f) => !f.resolved).length ?? 0;
  const previewItems = useMemo(
    () => preview?.files.map((fileDiff, i) => ({ id: String(i), type: 'diff' as const, fileDiff })) ?? [],
    [preview]
  );
  function apply(reply: ConflictReply, selection = selected) {
    setSession(reply.session);
    setPreview(reply.preview);
    const next =
      reply.session.files.find((f) => f.path === selection) ??
      (reply.session.files.length ? reply.session.files[0] : undefined);
    setSelected(next?.path ?? '');
    setContents(next?.result ?? '');
    setEpoch((n) => n + 1);
    setMessage((previous) => previous || `Merge ${reply.session.baseBranch} into ${reply.session.headBranch}`);
  }
  async function saveDraft(value: ConflictSession) {
    if (!file || contents === file.result) return value;
    const reply = await window.electronAPI.conflictResolution({
      kind: 'save',
      id: value.id,
      version: value.version,
      path: selected,
      contents,
      resolved: false,
    });
    setSession(reply.session);
    return reply.session;
  }
  async function act(build: (value: ConflictSession) => ConflictRequest) {
    if (!session || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const saved = await saveDraft(session);
      const reply = await window.electronAPI.conflictResolution(build(saved));
      apply(reply);
    } catch (e) {
      setError(errorText(e));
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
    try {
      apply(await window.electronAPI.conflictResolution({ kind: 'open', url, restart }));
      setResetPrompt(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function choose(path: string) {
    if (!session || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const saved = await saveDraft(session);
      apply({ session: saved }, path);
    } catch (e) {
      setError(errorText(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function close() {
    // Long operations continue in Activity; their inputs were saved before starting.
    if (pending.current && dirty) {
      setError('Wait for your draft to finish saving before closing.');
      return;
    }
    if (pending.current || !session || !dirty) {
      onClose();
      return;
    }
    pending.current = true;
    setBusy(true);
    try {
      await saveDraft(session);
      onClose();
    } catch (e) {
      setError(errorText(e));
      pending.current = false;
      setBusy(false);
    }
  }
  const canEdit = !!file && !file.unsupported && !busy && !session?.stale && session?.status === 'editing';
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <DialogContent className="conflict-workspace" showCloseButton={false}>
        <div className="conflict-heading">
          <div>
            <DialogTitle>
              Resolve conflicts
              {session && (
                <>
                  {' '}
                  · <RepositoryBadge repo={session.baseRepo} /> <PrBadge url={session.url} title={session.title} />
                </>
              )}
            </DialogTitle>
            <DialogDescription>
              {session ? (
                <>
                  <BranchBadge branch={session.headBranch} repo={session.headRepo} /> ←{' '}
                  <BranchBadge branch={session.baseBranch} repo={session.baseRepo} /> · Updates the PR branch; does not
                  merge the PR.
                </>
              ) : (
                'Prepare a private merge workspace. Your checkout stays unchanged.'
              )}
            </DialogDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void close()}>
            {busy ? 'Continue in background' : 'Close'}
          </Button>
        </div>
        {error && (
          <div className="conflict-notice" role="alert">
            {error}
            {!session && (
              <Button size="sm" variant="outline" onClick={() => void load()}>
                Retry
              </Button>
            )}
          </div>
        )}
        {session?.stale && (
          <div className="conflict-notice" role="status">
            The PR or base branch changed. Your previous draft is preserved. Start a new resolution to work on the
            latest revisions.
          </div>
        )}
        {!session ? (
          <div className="conflict-empty">
            {busy && <Loader2 className="animate-spin" size={22} />}
            <p>
              {busy
                ? 'Preparing conflicts… Progress and cancellation are in Activity.'
                : 'The workspace could not be prepared.'}
            </p>
          </div>
        ) : session.status === 'published' ? (
          <div className="conflict-empty">
            <Check size={30} />
            <h2>PR branch updated</h2>
            <p>Your resolution is committed. GitHub will evaluate checks and merge requirements again.</p>
            <a href={session.url} target="_blank" rel="noreferrer">
              Open PR on GitHub
            </a>
          </div>
        ) : preview ? (
          <>
            <div className="conflict-toolbar">
              <Button size="sm" variant="outline" onClick={() => setPreview(undefined)}>
                Back to conflicts
              </Button>
              <p>Review all changes, including changes from {session.baseBranch}. Project tests have not been run.</p>
            </div>
            {preview.validation && (
              <details className="conflict-notice">
                <summary>Whitespace warnings</summary>
                <pre>{preview.validation}</pre>
              </details>
            )}
            <CodeView
              className="conflict-preview selectable"
              items={previewItems}
              options={options}
              style={{ height: '100%', overflow: 'auto' }}
            />
            <div className="conflict-publish">
              <label>
                Commit message
                <input value={message} maxLength={2000} onChange={(e) => setMessage(e.target.value)} />
              </label>
              <Button
                disabled={busy || !message.trim()}
                onClick={() =>
                  void act((s) => ({
                    kind: 'publish',
                    id: s.id,
                    version: s.version,
                    previewToken: preview.token,
                    message,
                  }))
                }
              >
                {busy ? 'Updating PR…' : 'Commit resolution & update PR'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="conflict-toolbar">
              <span>
                {session.files.length - unresolved}/{session.files.length} files reviewed
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || session.stale || !unresolved}
                onClick={() => void act((s) => ({ kind: 'resolve', engine: 'mergiraf', id: s.id, version: s.version }))}
              >
                Try Mergiraf on remaining files
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || session.stale || !unresolved}
                onClick={() =>
                  void act((s) => ({ kind: 'resolve', engine: 'agent', id: s.id, version: s.version, instructions }))
                }
              >
                <Sparkles size={14} />
                Ask agent about remaining files
              </Button>
            </div>
            <div className="conflict-body">
              <nav aria-label="Conflicted files" className="conflict-files">
                {session.files.map((f) => (
                  <button
                    key={f.path}
                    disabled={busy}
                    aria-current={f.path === selected ? 'true' : undefined}
                    onClick={() => void choose(f.path)}
                  >
                    {f.resolved ? <Check size={14} /> : <Circle size={12} />}
                    <span>{f.path}</span>
                    {f.unsupported && <small>Local tool required</small>}
                  </button>
                ))}
                {!session.files.length && <p>No conflicts remain. Review the branch update before publishing.</p>}
              </nav>
              <section className="conflict-file-pane" aria-label="Selected conflict">
                {file && (
                  <>
                    <header>
                      <strong>{file.path}</strong>
                      <span>{dirty ? 'Unsaved changes' : file.resolved ? 'Reviewed' : 'Draft saved locally'}</span>
                    </header>
                    {file.unsupported ? (
                      <div className="conflict-empty">
                        <p>{file.unsupported}</p>
                        <a href={session.url} target="_blank" rel="noreferrer">
                          Open PR on GitHub
                        </a>
                      </div>
                    ) : (
                      <>
                        <div className="conflict-toolbar">
                          <div role="group" aria-label="Conflict view">
                            {(['conflicts', 'edit', 'compare'] as const).map((value) => (
                              <Button
                                key={value}
                                size="sm"
                                variant={mode === value ? 'secondary' : 'ghost'}
                                disabled={busy}
                                aria-pressed={mode === value}
                                onClick={() => {
                                  setMode(value);
                                  setEpoch((n) => n + 1);
                                }}
                              >
                                {value === 'conflicts'
                                  ? 'Choose changes'
                                  : value === 'edit'
                                    ? 'Edit result'
                                    : 'Compare with PR'}
                              </Button>
                            ))}
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!canEdit}
                            onClick={() => {
                              setContents(file.original);
                              setEpoch((n) => n + 1);
                            }}
                          >
                            {' '}
                            <RotateCcw size={14} />
                            Reset file
                          </Button>
                        </div>
                        <div className="conflict-editor selectable" inert={busy || session.stale}>
                          {mode === 'conflicts' && !hasConflictMarkers(contents) ? (
                            <File file={{ name: selected, contents }} options={options} />
                          ) : mode === 'conflicts' ? (
                            <ConflictChoices
                              key={`${selected}:${epoch}`}
                              name={selected}
                              contents={contents}
                              ours={session.headBranch}
                              theirs={session.baseBranch}
                              onChange={setContents}
                            />
                          ) : mode === 'edit' ? (
                            <EditProvider createEditor={createEditor}>
                              <ResultEditor
                                key={`${selected}:${epoch}`}
                                name={selected}
                                initial={contents}
                                onChange={setContents}
                              />
                            </EditProvider>
                          ) : (
                            <MultiFileDiff
                              oldFile={{ name: selected, contents: file.ours }}
                              newFile={{ name: selected, contents }}
                              options={options}
                            />
                          )}
                        </div>
                        <div className="conflict-file-actions">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!canEdit}
                            onClick={() =>
                              void act((s) => ({
                                kind: 'resolve',
                                engine: 'mergiraf',
                                id: s.id,
                                version: s.version,
                                path: selected,
                              }))
                            }
                          >
                            Try Mergiraf
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!canEdit}
                            onClick={() =>
                              void act((s) => ({
                                kind: 'resolve',
                                engine: 'agent',
                                id: s.id,
                                version: s.version,
                                path: selected,
                                instructions,
                              }))
                            }
                          >
                            Ask agent
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!canEdit || !dirty}
                            onClick={() =>
                              void act((s) => ({
                                kind: 'save',
                                id: s.id,
                                version: s.version,
                                path: selected,
                                contents,
                                resolved: false,
                              }))
                            }
                          >
                            Save draft
                          </Button>
                          <Button
                            size="sm"
                            disabled={!canEdit || hasConflictMarkers(contents)}
                            onClick={() =>
                              void act((s) => ({
                                kind: 'save',
                                id: s.id,
                                version: s.version,
                                path: selected,
                                contents,
                                resolved: true,
                              }))
                            }
                          >
                            Mark reviewed
                          </Button>
                        </div>
                        <details className="conflict-agent-context" open={!!file.explanation}>
                          <summary>Agent guidance{file.explanation ? ' · Proposal notes' : ''}</summary>
                          {file.explanation && <p>{file.explanation}</p>}
                          <label>
                            Instructions or answer to the agent
                            <textarea
                              value={instructions}
                              maxLength={10000}
                              onChange={(e) => setInstructions(e.target.value)}
                              placeholder="Explain which behavior should be preserved…"
                            />
                          </label>
                          <p>
                            The selected model reads the three file versions and your draft. It does not run project
                            tests.
                          </p>
                        </details>
                      </>
                    )}
                  </>
                )}
              </section>
            </div>
            <footer className="conflict-footer">
              {resetPrompt ? (
                <>
                  <span>Replace saved resolutions with a fresh merge?</span>
                  <Button size="sm" variant="outline" onClick={() => setResetPrompt(false)}>
                    Keep draft
                  </Button>
                  <Button size="sm" disabled={busy} onClick={() => void load(true)}>
                    Start new resolution
                  </Button>
                </>
              ) : (
                <>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setResetPrompt(true)}>
                    Start over…
                  </Button>
                  <span>
                    {busy
                      ? 'Working… You can continue elsewhere; progress is in Activity.'
                      : 'Review automatic suggestions before marking files reviewed.'}
                  </span>
                  <Button
                    size="sm"
                    disabled={busy || session.stale || unresolved > 0 || dirty}
                    onClick={() => void act((s) => ({ kind: 'preview', id: s.id, version: s.version }))}
                  >
                    Review resolution…
                  </Button>
                </>
              )}
            </footer>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
