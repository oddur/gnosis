import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditProvider, File } from '@pierre/diffs/react';
import { Editor, type EditorFactory } from '@pierre/diffs/edit';
import { Pencil, Undo2 } from 'lucide-react';
import { Button } from './ui/button';

/**
 * Edit whole file (#503): the draft in Pierre's editor, for a change outside the conflicts' lines, such as an import the
 * type check asks for. Save makes the whole file your decision, every conflict in it too; Cancel, or Escape, changes
 * nothing. Cmd+Enter (Ctrl+Enter) saves. Save stays off until you change something: an untouched draft is no decision.
 */
export function FileEditor({
  name,
  initial,
  theme,
  disabled,
  onHeld,
  onType,
  onSave,
  onCancel,
}: {
  name: string;
  /** The draft on screen, unsaved choices included. */
  initial: string;
  /** The diff's code theme (diffThemeName). */
  theme: string;
  disabled: boolean;
  /** Open (true) or closed (false): while it is open, every step that would leave or review the draft waits. */
  onHeld: (held: boolean) => void;
  /** Your text as you type it. */
  onType: (text: string) => void;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [file] = useState(() => ({ name, contents: initial }));
  const [text, setText] = useState(initial);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Pick<Editor, 'focus'>>(undefined);
  const factory = useCallback<EditorFactory<undefined, undefined>>((type, opts, key) => {
    const instance = new Editor(type, opts, key);
    editor.current = instance;
    return instance;
  }, []);
  const options = useMemo(
    () => ({ theme, themeType: 'dark' as const, overflow: 'wrap' as const, disableFileHeader: true }),
    [theme]
  );
  const held = useRef(onHeld);
  held.current = onHeld;
  useEffect(() => {
    held.current(true);
    return () => held.current(false);
  }, []);
  // Focus goes into the editor, at the start of the file, once it has rendered; unless you moved it meanwhile.
  useEffect(() => {
    let frame = 0;
    let tries = 0;
    const opened = document.activeElement;
    const attempt = () => {
      const target = host.current
        ?.querySelector('diffs-container')
        ?.shadowRoot?.querySelector<HTMLElement>('[contenteditable=true]');
      const active = document.activeElement;
      const free = !active || active === opened || active === document.body || !!host.current?.contains(active);
      if (target && free) {
        editor.current?.focus({ lineNumber: 1, character: 0, preventScroll: true });
        if ((target.getRootNode() as ShadowRoot).activeElement === target) return;
      }
      if (++tries < 300) frame = requestAnimationFrame(attempt);
    };
    frame = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(frame);
  }, []);
  const changed = text !== initial;
  const save = () => {
    if (!disabled && changed) onSave(text);
  };
  return (
    <div
      className="conflict-file-edit"
      data-conflict-file-editor=""
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          event.stopPropagation();
          save();
        }
      }}
    >
      <header className="conflict-block-header">
        <strong>Edit whole file</strong>
        <span>
          Saving makes the whole file your decision: every conflict in it, and every line you change. A conflict marker
          you leave keeps the file conflicted.
        </span>
      </header>
      <div ref={host} className="conflict-file-editor">
        <EditProvider createEditor={factory}>
          <File file={file} edit options={options} onEditChange={(event) => {
              setText(event.file.contents);
              onType(event.file.contents);
            }} />
        </EditProvider>
      </div>
      <div className="conflict-block-actions">
        <Button size="sm" disabled={disabled || !changed} data-conflict-file-save="" onClick={save}>
          Save file
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * A file you edited whole (#503): one line over its diff that says the file is yours, with Edit again and Undo. Undo
 * returns the file to what it was before your first whole-file edit, your choices per conflict included. When the edit
 * left proposals in Check in a draft that can't be split into its conflicts, Accept my edit makes them yours (#533):
 * only your choice does, never Gnosis.
 */
export function FileEditNote({
  conflicts,
  markers,
  accept,
  disabled,
  onEdit,
  onUndo,
  onAccept,
}: {
  conflicts: number;
  /** A conflict marker is left in the draft: the file stays conflicted until you edit it again. */
  markers: boolean;
  /** The proposals in Check that Accept my edit would make yours (acceptableConflicts); 0 hides it. */
  accept: number;
  disabled: boolean;
  onEdit: () => void;
  onUndo: () => void;
  onAccept: () => void;
}) {
  return (
    <div className="conflict-file-edited" data-conflict-file-edited="">
      <Pencil size={13} aria-hidden="true" />
      <span>
        <strong>Edited by you</strong> ·{' '}
        {markers
          ? 'A conflict marker is left. Edit the file again to finish it.'
          : accept
            ? `Your edit left ${accept === 1 ? 'a proposal' : `${accept} proposals`} in Check as ${accept === 1 ? 'it was' : 'they were'}.`
            : `The whole file is your decision, its ${conflicts === 1 ? 'conflict' : `${conflicts} conflicts`} included.`}
      </span>
      {accept > 0 && (
        <Button size="sm" variant="ghost" disabled={disabled} data-conflict-file-accept="" onClick={onAccept}>
          Accept my edit
        </Button>
      )}
      <Button size="sm" variant="ghost" disabled={disabled} data-conflict-file-edit-again="" onClick={onEdit}>
        Edit again
      </Button>
      <Button size="sm" variant="ghost" disabled={disabled} data-conflict-file-undo="" onClick={onUndo}>
        <Undo2 aria-hidden="true" />
        Undo
      </Button>
    </div>
  );
}
