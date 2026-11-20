import type { PrChangeFile, PrChanges } from './pr-changes';
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
