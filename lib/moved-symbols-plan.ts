import type { InspectionRevision, PrChangeFile, PrChanges } from './pr-changes';
import { syntaxLanguage, type SyntaxLanguage } from './syntax-scope';
import { patchMayMove } from './moved-symbols';
import { pathFileKinds } from './file-kinds';
import { imageMimeType } from './review-images';

/** The grammar a file's moved-symbol candidates parse with (#398): a deleted file's by its old path. */
export const movesLanguage = (file: PrChangeFile) =>
  syntaxLanguage(file.status === 'deleted' ? (file.previousPath ?? file.path) : file.path);

/** Grammars with functions, methods or classes to move. JSON and YAML have only keys. */
export const MOVE_LANGUAGES: ReadonlySet<SyntaxLanguage> = new Set([
  'typescript',
  'tsx',
  'javascript',
  'rust',
  'go',
  'python',
  'java',
  'csharp',
]);

/** Why a file that could hold a move is not read: its family is then not matched. */
export type MovesUnread = 'no-patch' | 'off';

/**
 * What a changed file is to the moved-symbol matcher (lib/moved-symbols.ts): left out (it cannot hold a move, or is
 * not code with symbols), a file to fingerprint, or one that could hold a move but is not read, which keeps its whole
 * family from matching: it could hold a rival. That is a modified file GitHub sent without a patch (a very large diff),
 * and a file whose language is off in Settings. An added or deleted file without a patch is read whole instead.
 */
export function movesFilePlan(
  snapshot: Pick<PrChanges, 'fileKinds'>,
  file: PrChangeFile,
  allowed: (path: string) => boolean
):
  | { language: SyntaxLanguage; readable: true }
  | { language: SyntaxLanguage; readable: false; reason: MovesUnread }
  | undefined {
  const language = movesLanguage(file);
  const path = file.status === 'deleted' ? (file.previousPath ?? file.path) : file.path;
  if (!language || !MOVE_LANGUAGES.has(language) || imageMimeType(path)) return undefined;
  if ((snapshot.fileKinds?.[file.path] ?? pathFileKinds(file.path)).generated.value) return undefined;
  const mayMove = file.patch ? patchMayMove(file.patch) : file.additions + file.deletions > 0;
  if (!mayMove) return undefined;
  if (!allowed(path)) return { language, readable: false, reason: 'off' };
  // An added or deleted file is its one side: read whole, every line of it changed.
  if (!file.patch && file.status !== 'added' && file.status !== 'deleted')
    return { language, readable: false, reason: 'no-patch' };
  return { language, readable: true };
}

/**
 * A PR member's file list for moved symbols, only when it is for the member's current base and head. The inspection
 * cache falls back to an older head's list; tracking that would name lines that moved, and never read the current one.
 */
export function currentChanges(
  member: InspectionRevision,
  peek: (member: InspectionRevision) => PrChanges | undefined
): PrChanges | undefined {
  const snapshot = peek(member);
  // A member without a base (a saved explanation's) is current by its head alone.
  return snapshot &&
    snapshot.metadata.headSha === member.headSha &&
    (!member.baseSha || snapshot.metadata.baseSha === member.baseSha)
    ? snapshot
    : undefined;
}

/**
 * A moves read's queue key (lib/use-syntax-contents.ts): the file's key with this after it. It is an entry of its own,
 * never joined to the scope read of the same file, so the scope cap or a view's refusal never takes it out of the
 * queue; the read itself is shared in the inspection cache.
 */
export const MOVES_KEY = '\u0000moves';
/**
 * The file revision whose moved-symbol family a read's end fails, and whether a later read can mend it, or undefined
 * (#398). A moves read that ends without the file fails its family whatever the cause (its budget spent, its tries run
 * out, the file not readable): nothing else will read it. Tries that ran out are recoverable: a later read of the file
 * (a scope read, the moves read queued again) revives it. Another read fails a family only when the file cannot be
 * read at all; the scope cap refusing a scope read, or a scope read's tries running out, says nothing about moves.
 */
export function movesFailureKey(
  key: string,
  cause: 'content' | 'budget' | 'cap' | 'retries'
): { key: string; recoverable: boolean } | undefined {
  if (key.endsWith(MOVES_KEY)) return { key: key.slice(0, -MOVES_KEY.length), recoverable: cause === 'retries' };
  return cause === 'content' ? { key, recoverable: false } : undefined;
}

/** A member's whole revision, for a file list read for it (`keptRead`): a retargeted member is another revision. */
export const memberRevisionKey = (member: InspectionRevision) =>
  `${member.url}\u0000${member.headSha}\u0000${member.baseSha}`;
/**
 * Whether a file list read for a member is kept apart for it: it is for the member's head, but another base than the
 * member says (GitHub knows a newer one), so the cache lookup by the member's revision never finds it. A list for the
 * member's own base is found in the cache.
 */
export const keptRead = (member: InspectionRevision, snapshot: PrChanges) =>
  snapshot.metadata.headSha === member.headSha && snapshot.metadata.baseSha !== member.baseSha;
