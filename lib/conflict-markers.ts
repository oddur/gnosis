import { markersLeft } from './conflict-carry';
import type { ConflictFile, ConflictFileStage } from './conflict-resolution';

/** Derive the stage from the displayed draft, including edits not saved yet. */
export function conflictFileStage(
  file: Pick<ConflictFile, 'unsupported' | 'result' | 'resolved' | 'path' | 'original' | 'base' | 'ours' | 'theirs'>,
  contents = file.result
): ConflictFileStage {
  if (file.unsupported || markersLeft(file, contents)) return 'conflicted';
  return file.resolved && contents === file.result ? 'reviewed' : 'resolved';
}
