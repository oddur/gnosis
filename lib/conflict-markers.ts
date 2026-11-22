import { markersLeft } from './conflict-carry';
import type { ConflictFile, ConflictFileStage } from './conflict-resolution';

/** The file-level marker check (#457) lives with blockResolutions, which it reads; the views import it from here. */
export { markersLeft };

/** Derive the stage from the displayed draft, including edits not saved yet. */
export function conflictFileStage(
  file: Pick<ConflictFile, 'unsupported' | 'result' | 'resolved' | 'path' | 'original'>,
  contents = file.result
): ConflictFileStage {
  if (file.unsupported || markersLeft(file, contents)) return 'conflicted';
  return file.resolved && contents === file.result ? 'reviewed' : 'resolved';
}
