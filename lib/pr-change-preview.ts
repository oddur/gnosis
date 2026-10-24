import { processFile, trimPatchContext, type FileDiffMetadata, type SelectedLineRange } from '@pierre/diffs';
import type { PrChangeFile } from './pr-changes';
import { imageMimeType } from './review-images';

/** Render GitHub's already-downloaded patch immediately, but never present a truncated patch as complete. */
export function prChangePreview(file: PrChangeFile, contextLines = 3): FileDiffMetadata | undefined {
  if (!file.patch || imageMimeType(file.path)) return;
  const added = file.status === 'added',
    deleted = file.status === 'deleted';
  try {
    // Fixed parser paths avoid quoting ambiguity for filenames with tabs/spaces; identity is assigned afterwards.
    const patch = `diff --git a/source b/source\n${added ? 'new file mode 100644\n' : deleted ? 'deleted file mode 100644\n' : ''}--- ${added ? '/dev/null' : 'a/source'}\n+++ ${deleted ? '/dev/null' : 'b/source'}\n${file.patch}\n`;
    const preview = processFile(trimPatchContext(patch, contextLines), { throwOnError: true });
    if (
      !preview ||
      !preview.hunks.length ||
      preview.hunks.reduce((n, h) => n + h.additionLines, 0) !== file.additions ||
      preview.hunks.reduce((n, h) => n + h.deletionLines, 0) !== file.deletions
    )
      return;
    preview.name = file.path;
    if (file.previousPath) preview.prevName = file.previousPath;
    return preview;
  } catch {
    return;
  }
}

/** Selection coordinates refer to source lines, including while only the patch is loaded. */
export function prPreviewSelection(preview: FileDiffMetadata, range: SelectedLineRange): string {
  const before = range.side === 'deletions';
  const lines = before ? preview.deletionLines : preview.additionLines;
  const start = Math.min(range.start, range.end),
    end = Math.max(range.start, range.end);
  if (!preview.isPartial)
    return lines
      .slice(start - 1, end)
      .map((l) => l.replace(/\n$/, ''))
      .join('\n');
  const selected: string[] = [];
  for (const hunk of preview.hunks) {
    const first = before ? hunk.deletionStart : hunk.additionStart;
    const count = before ? hunk.deletionCount : hunk.additionCount;
    const index = before ? hunk.deletionLineIndex : hunk.additionLineIndex;
    for (let line = Math.max(start, first); line <= Math.min(end, first + count - 1); line++) {
      selected.push(`${line}: ${lines[index + line - first].replace(/\n$/, '')}`);
    }
  }
  return selected.join('\n');
}
