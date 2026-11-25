import { useEffect, useMemo, useState } from 'react';
import { structuredPatch } from 'diff';
import { ArrowRightLeft } from 'lucide-react';
import { inspectionFiles } from '../lib/inspection-cache';
import { threadSource } from '../lib/review-threads';
import { movedBody } from '../lib/explanation-ranges';
import type { DiffAppearance } from '../lib/review-diff';
import type { DiffHunk, Preferences, ReviewGuide } from '../lib/types';
import { LoadingIndicator } from './LoadingState';
import { ReviewDiff } from './ReviewDiff';

/**
 * A moved slice's note on its block (#563): "Moved from `commands/queue.rs`", with "renamed from X" when the move
 * renamed it. An identical move says "unchanged"; an edited one shows the move diff, the old body against the new,
 * in a part that opens on request, read from the old file at the PR's base.
 */
export function MovedSliceNote({
  entry,
  review,
  diffLayout,
  appearance,
  slideIndex,
}: {
  entry: DiffHunk;
  review?: ReviewGuide;
  diffLayout: Preferences['diffLayout'];
  appearance?: DiffAppearance;
  slideIndex: number;
}) {
  const moved = entry.movedFrom;
  const [open, setOpen] = useState(false);
  if (!moved) return null;
  const lines = moved.endLine > moved.startLine ? `lines ${moved.startLine}–${moved.endLine}` : `line ${moved.startLine}`;
  return (
    <div className="review-move-note" role="note" data-move-body={moved.body} aria-label={`Moved from ${moved.filePath}, old ${lines}`}>
      <p className="review-move-note-text">
        <ArrowRightLeft size={13} aria-hidden="true" />
        <span>
          Moved from <code>{moved.filePath}</code>
        </span>
        {moved.renamed && (
          <>
            <span aria-hidden="true">·</span>
            <span data-move-rename="">
              renamed from <code>{moved.renamed.from}</code>
            </span>
          </>
        )}
        {moved.body === 'identical' && (
          <>
            <span aria-hidden="true">·</span>
            <span>unchanged</span>
          </>
        )}
      </p>
      {moved.body === 'edited' && (
        <details className="review-move-diff" onToggle={(event) => setOpen(event.currentTarget.open)}>
          <summary>Edits made during the move</summary>
          {open && (
            <MoveDiff entry={entry} review={review} diffLayout={diffLayout} appearance={appearance} slideIndex={slideIndex} />
          )}
        </details>
      )}
    </div>
  );
}

type OldBody = { state: 'loading' } | { state: 'ready'; text: string } | { state: 'failed' };

function MoveDiff({
  entry,
  review,
  diffLayout,
  appearance,
  slideIndex,
}: {
  entry: DiffHunk;
  review?: ReviewGuide;
  diffLayout: Preferences['diffLayout'];
  appearance?: DiffAppearance;
  slideIndex: number;
}) {
  const moved = entry.movedFrom;
  const source = review && moved ? threadSource(review, moved.filePath) : null;
  const baseSha = source?.baseSha ?? review?.baseSha;
  const headSha = source?.headSha;
  const [old, setOld] = useState<OldBody>({ state: 'loading' });
  useEffect(() => {
    if (!moved || !source || !baseSha || !headSha) {
      setOld({ state: 'failed' });
      return;
    }
    let live = true;
    setOld({ state: 'loading' });
    inspectionFiles
      .read({ url: source.prUrl, path: source.path, baseSha, headSha })
      .then((contents) => {
        if (!live) return;
        if (contents.before.kind !== 'text') {
          setOld({ state: 'failed' });
          return;
        }
        // The old lines must all be there: a file shorter than the saved move is not its old body.
        const all = contents.before.content.split('\n');
        if (all.at(-1) === '') all.pop();
        const count = moved.endLine - moved.startLine + 1;
        const lines = moved.startLine >= 1 && count >= 1 ? all.slice(moved.startLine - 1, moved.endLine) : [];
        setOld(lines.length === count ? { state: 'ready', text: `${lines.join('\n')}\n` } : { state: 'failed' });
      })
      .catch(() => live && setOld({ state: 'failed' }));
    return () => {
      live = false;
    };
  }, [moved?.filePath, moved?.startLine, moved?.endLine, source?.prUrl, source?.path, headSha, baseSha]);
  const hunks = useMemo((): DiffHunk[] | undefined => {
    if (old.state !== 'ready' || !moved) return undefined;
    const body = movedBody(entry);
    if (!body) return undefined;
    const patch = structuredPatch('old', 'new', old.text, body.text, '', '', { context: 3 });
    return patch.hunks.map((hunk) => ({
      filePath: entry.filePath,
      language: entry.language,
      renderedHtml: entry.renderedHtml,
      // Old lines in the old file, new lines in this one.
      hunkHeader: `@@ -${hunk.oldStart + moved.startLine - 1},${hunk.oldLines} +${hunk.newStart + body.start - 1},${hunk.newLines} @@`,
      content: hunk.lines.filter((line) => !line.startsWith('\\')).join('\n'),
    }));
  }, [old, entry, moved]);
  if (old.state === 'loading') return <LoadingIndicator>Loading the old body…</LoadingIndicator>;
  if (old.state === 'failed' || !hunks) return <p className="review-move-diff-error">Couldn’t read the old body. Changes shows both copies.</p>;
  if (!hunks.length) return <p className="review-move-diff-error">The bodies match.</p>;
  return (
    <ReviewDiff
      filePath={entry.filePath}
      hunks={hunks}
      fileStatus="modified"
      diffLayout={diffLayout}
      appearance={appearance}
      slideIndex={slideIndex}
      commentScope={`move:${entry.sliceId ?? entry.hunkHeader}`}
      keyScope={`move:${review?.prUrl ?? ''}:${entry.sliceId ?? entry.hunkHeader}`}
      plainGaps
      expandable={false}
    />
  );
}
