import { DIFF_HIGHLIGHTER } from '../lib/diff-highlighter';
import { useEffect, useState, useRef } from 'react';
import type { DiffFileInput } from '@pierre/diffs';
import { useDiffAppearance } from '../lib/use-diff-appearance';
import { diffContextLines, type DiffAppearance } from '../lib/review-diff';
import { MultiFileDiff } from '@pierre/diffs/react';
import { imageMimeType } from '../lib/review-images';
import { LfsDownload } from './LfsDownload';
import { lfsSize } from '../lib/git-lfs';
import { Maximize2 } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from './ui/dialog';
import type { ReviewImageComparison, ReviewImageSide } from '../lib/review-images';

function ImageSide({ label, value, background }: { label: string; value: ReviewImageSide; background: string }) {
  const [dimensions, setDimensions] = useState('');
  const [failed, setFailed] = useState(false);
  const [actualSize, setActualSize] = useState(false);
  if (value.status === 'absent' || value.status === 'text') return null;
  return (
    <figure className="review-image-side">
      <figcaption>
        <strong>{label}</strong>
        <span>{dimensions}</span>
      </figcaption>
      {value.status === 'lfs' ? (
        <p className="review-image-error">
          Git LFS · {lfsSize(value.pointer.size)} · {value.revision.slice(0, 7)}
        </p>
      ) : value.status === 'error' ? (
        <p className="review-image-error" role="status">
          {value.message}
        </p>
      ) : failed ? (
        <p className="review-image-error" role="status">
          This file could not be decoded as an image.
        </p>
      ) : (
        <Dialog onOpenChange={() => setActualSize(false)}>
          <DialogTrigger asChild>
            <button className="review-image-stage" aria-label={`Expand ${label.toLowerCase()} image`}>
              <img
                src={value.dataUrl}
                alt={`${label}: ${value.path}`}
                onError={() => setFailed(true)}
                onLoad={(e) => setDimensions(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)}
              />
              <span className="review-image-expand">
                <Maximize2 size={13} /> Expand
              </span>
            </button>
          </DialogTrigger>
          <DialogContent className="review-image-dialog" aria-describedby={undefined}>
            <DialogTitle>
              {label}: {value.path}
            </DialogTitle>
            <button className="review-image-size" onClick={() => setActualSize((size) => !size)}>
              {actualSize ? 'Fit image' : 'Actual size'}
            </button>
            <div className="review-image-full" data-background={background} data-actual-size={actualSize}>
              <img src={value.dataUrl} alt={`${label}: ${value.path}`} />
            </div>
          </DialogContent>
        </Dialog>
      )}
      {value.status === 'ready' && (
        <p className="review-image-revision" title={value.revision}>
          {value.path} · {value.revision.slice(0, 7)}
        </p>
      )}
    </figure>
  );
}

export function ReviewImageDiff({
  reviewId,
  filePath,
  enabled,
  comparison,
  diffLayout = 'split',
  diffTheme = 'github-dark',
  diffAppearance,
}: {
  reviewId?: string;
  filePath: string;
  enabled: boolean;
  comparison?: ReviewImageComparison;
  diffLayout?: 'split' | 'unified';
  diffTheme?: string;
  diffAppearance?: DiffAppearance;
}) {
  const appearance = useDiffAppearance(diffAppearance);
  const source = JSON.stringify([reviewId, filePath]);
  const [loadedResult, setResult] = useState<{ source: string; value: ReviewImageComparison }>();
  const result = comparison ?? (loadedResult?.source === source ? loadedResult.value : undefined);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [background, setBackground] = useState('checkerboard');
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const currentSource = useRef(source);
  currentSource.current = source;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function download() {
    if (!reviewId || downloading) return;
    setDownloading(true);
    setError('');
    try {
      const value = await window.electronAPI.loadReviewImages(reviewId, filePath, true);
      if (mounted.current && currentSource.current === source) setResult({ source, value });
    } catch (e) {
      if (mounted.current && currentSource.current === source) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current && currentSource.current === source) setDownloading(false);
    }
  }
  const lfsSides = result ? [result.before, result.after].filter((side) => side.status === 'lfs') : [];
  useEffect(() => {
    if (comparison || !enabled || !reviewId) return;
    let cancelled = false;
    setBusy(true);
    setError('');
    void window.electronAPI
      .loadReviewImages(reviewId, filePath)
      .then((data) => {
        if (!cancelled) setResult({ source, value: data });
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reviewId, filePath, enabled, attempt, comparison, source]);
  const resourceText = !imageMimeType(filePath);
  const textReady =
    result &&
    [result.before, result.after].every((side) => side.status === 'text' || side.status === 'absent') &&
    [result.before, result.after].some((side) => side.status === 'text');
  const failed = error || result?.before.status === 'error' || result?.after.status === 'error';
  const single = result && (result.before.status === 'absent' || result.after.status === 'absent');
  return (
    <section
      className="review-image-diff"
      aria-label={resourceText ? 'LFS content comparison' : 'Image comparison'}
      data-background={background}
    >
      <div className="review-image-toolbar">
        <span>
          {resourceText
            ? 'LFS content comparison'
            : single
              ? result.before.status === 'absent'
                ? 'Added image'
                : 'Deleted image'
              : 'Image comparison'}
        </span>
        {!resourceText && (
          <label>
            Background{' '}
            <select aria-label="Image background" value={background} onChange={(e) => setBackground(e.target.value)}>
              <option value="checkerboard">Checkerboard</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        )}
      </div>
      {!reviewId && !comparison && <p role="status">Save this review to load its image revisions.</p>}
      {busy && !result && <p role="status">Loading image revisions…</p>}
      {error && (
        <p className="review-image-error" role="status">
          Could not load images. {error}
        </p>
      )}
      {lfsSides.length > 0 && reviewId && (
        <LfsDownload
          pointers={lfsSides.map((side) => side.pointer)}
          busy={downloading}
          error={error || lfsSides.find((side) => side.error)?.error}
          onDownload={() => void download()}
        />
      )}
      {textReady && (
        <>
          <p className="changes-notice">Downloaded Git LFS contents. GitHub comments are on the pointer diff below.</p>
          <MultiFileDiff
            {...({
              oldFile:
                result.before.status === 'text' ? { name: result.before.path, contents: result.before.content } : null,
              newFile:
                result.after.status === 'text' ? { name: result.after.path, contents: result.after.content } : null,
            } as DiffFileInput)}
            options={{
              preferredHighlighter: DIFF_HIGHLIGHTER,
              diffStyle: single ? 'unified' : diffLayout,
              disableFileHeader: true,
              theme: `gnosis-${diffTheme}`,
              themeType: 'dark',
              enableLineSelection: false,
              diffIndicators: appearance.indicators,
              disableBackground: !appearance.backgrounds,
              disableLineNumbers: !appearance.lineNumbers,
              overflow: appearance.wrap ? 'wrap' : 'scroll',
              lineDiffType: appearance.inline,
              parseDiffOptions: { context: diffContextLines(appearance) },
              hunkSeparators: 'line-info',
            }}
          />
        </>
      )}
      {result && (
        <div className="review-image-pair" data-single={!!single}>
          <ImageSide
            key={`before-${attempt}-${source}-${result.before.status === 'ready' ? result.before.revision : result.before.status}`}
            label="Before"
            value={result.before}
            background={background}
          />
          <ImageSide
            key={`after-${attempt}-${source}-${result.after.status === 'ready' ? result.after.revision : result.after.status}`}
            label="After"
            value={result.after}
            background={background}
          />
        </div>
      )}
      {failed && (
        <button className="review-image-retry" disabled={busy} onClick={() => setAttempt((n) => n + 1)}>
          {busy ? 'Retrying…' : resourceText ? 'Retry preview' : 'Retry images'}
        </button>
      )}
    </section>
  );
}
