import type { PrChangeFile, PrChanges } from './pr-changes';
import { syntaxLanguage, type SyntaxLanguage } from './syntax-scope';
import { patchMayMove } from './moved-symbols';
import { pathFileKinds } from './file-kinds';
import { imageMimeType } from './review-images';

/** The grammar a file's moved-symbol candidates parse with (#398): a deleted file's by its old path. */
export const movesLanguage = (file: PrChangeFile) =>
  syntaxLanguage(file.status === 'deleted' ? (file.previousPath ?? file.path) : file.path);

/**
 * What a changed file is to the moved-symbol matcher (lib/moved-symbols.ts): left out (it cannot hold a move, or is
 * not code Gnosis parses), a file to fingerprint, or one that could hold a move but cannot be read: GitHub leaves out
 * the patch of a very large diff, and such a modified file could hold a rival, so its family is not matched. An added
 * or deleted file without a patch is read whole instead.
 */
export function movesFilePlan(
  snapshot: Pick<PrChanges, 'fileKinds'>,
  file: PrChangeFile,
  allowed: (path: string) => boolean
): { language: SyntaxLanguage; readable: boolean } | undefined {
  const language = movesLanguage(file);
  const path = file.status === 'deleted' ? (file.previousPath ?? file.path) : file.path;
  if (!language || !allowed(path) || imageMimeType(path)) return undefined;
  if ((snapshot.fileKinds?.[file.path] ?? pathFileKinds(file.path)).generated.value) return undefined;
  if (!file.patch) {
    if (file.additions + file.deletions === 0) return undefined;
    // An added or deleted file is its one side: read whole, every line of it changed.
    return { language, readable: file.status === 'added' || file.status === 'deleted' };
  }
  return patchMayMove(file.patch) ? { language, readable: true } : undefined;
}
