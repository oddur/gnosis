import type { ConflictFile, ConflictSession, SaveRefusal, SavedBlockEdit } from './conflict-resolution';

/**
 * Why the view holds your edit: the service's refusal, or `checked`: the file's saved state moved with no new version,
 * so no other view saved it. The type check's demotion is the one write that does that.
 */
export type HeldReason = SaveRefusal | 'checked';
/** `changed` from a draft whose version is the one the view knows is the type check's own write. */
export const heldReason = (reason: SaveRefusal, knownVersion: number, savedVersion: number): HeldReason =>
  reason === 'changed' && savedVersion === knownVersion ? 'checked' : reason;

/**
 * What the Conflicts view's text and own choices for a file came from (#517): the file's saved revision, and its
 * conflict, draft, choices and edits then. Every save sends that revision as `base`, never a newer one, so a view whose
 * file another view changed is always refused, whichever path saves it. Only Keep my edit moves it on with your text.
 */
export interface LoadedFile {
  revision?: string;
  original: string;
  result: string;
  /** The choices and edits as saved, normalized as a save compares them (`choicesJson`). */
  picks: string;
  edits: string;
}
type Pick = NonNullable<ConflictFile['picks']>[number];
type Edit = { text: string; before?: Pick | null; pick?: Pick | null; written?: readonly number[] } | null | undefined;
/** Choices as a save compares them: null for none, and an empty list when there are none at all. */
export function picksJson(picks: readonly (Pick | null | undefined)[] | undefined) {
  const own = Array.from(picks ?? [], (pick) => pick ?? null);
  return JSON.stringify(own.some(Boolean) ? own : []);
}
/** In-place edits as a save compares them (ConflictFile.edits). */
export function editsJson(edits: readonly Edit[] | undefined) {
  const own: (SavedBlockEdit | null)[] = Array.from(edits ?? [], (edit) =>
    edit
      ? {
          text: edit.text,
          before: edit.before ?? null,
          pick: edit.pick ?? null,
          ...(edit.written?.length ? { written: [...edit.written] } : {}),
        }
      : null
  );
  return JSON.stringify(own.some(Boolean) ? own : []);
}
export const loadedOf = (f: ConflictFile): LoadedFile => ({
  revision: f.revision,
  original: f.original,
  result: f.result,
  picks: picksJson(f.picks),
  edits: editsJson(f.edits),
});
/** These files' saved state is the view's now: its own request wrote them, or the view read them afresh. */
export function adopt(loaded: Map<string, LoadedFile>, session: ConflictSession, paths: readonly string[] | 'all') {
  for (const f of session.files) if (paths === 'all' || paths.includes(f.path)) loaded.set(f.path, loadedOf(f));
}
/**
 * A newer saved draft arrived. Each file another writer changed since the view loaded it is read afresh when the view
 * has no changes of its own to it (`reload`); otherwise the view's changes are held (`hold`, the first one) and its
 * loaded revision stays, so every save of it is refused until you choose. `held` is already held. Files new to the
 * view are loaded as they are.
 */
export function reconcile(
  loaded: Map<string, LoadedFile>,
  session: ConflictSession,
  changedHere: (path: string, was: LoadedFile) => boolean,
  held?: string
) {
  const reload: string[] = [];
  let hold: { path: string; was: LoadedFile; reason: SaveRefusal } | undefined;
  for (const [path, was] of [...loaded]) {
    const file = session.files.find((f) => f.path === path);
    if ((file && file.revision === was.revision) || path === held) continue;
    if (!changedHere(path, was)) {
      if (file) loaded.set(path, loadedOf(file));
      else loaded.delete(path);
      reload.push(path);
    } else
      hold ??= { path, was, reason: !file ? 'left' : file.original !== was.original ? 'conflicts' : 'changed' };
  }
  for (const f of session.files) if (!loaded.has(f.path)) loaded.set(f.path, loadedOf(f));
  return { reload, hold };
}
