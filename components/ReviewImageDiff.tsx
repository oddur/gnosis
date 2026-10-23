import { useEffect, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from './ui/dialog';
import type { ReviewImageComparison, ReviewImageSide } from '../lib/review-images';

function ImageSide({ label, value, background }: { label: string; value: ReviewImageSide; background: string }) {
  const [dimensions, setDimensions] = useState('');
  const [failed, setFailed] = useState(false);
  const [actualSize, setActualSize] = useState(false);
  if (value.status === 'absent') return null;
  return (
    <figure className="review-image-side">
      <figcaption>
        <strong>{label}</strong>
        <span>{dimensions}</span>
      </figcaption>
      {value.status === 'error' ? (
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
}: {
  reviewId?: string;
  filePath: string;
  enabled: boolean;
}) {
  const [result, setResult] = useState<ReviewImageComparison>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [background, setBackground] = useState('checkerboard');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!enabled || !reviewId) return;
    let cancelled = false;
    setBusy(true);
    setError('');
    void window.electronAPI
      .loadReviewImages(reviewId, filePath)
      .then((data) => {
        if (!cancelled) setResult(data);
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
  }, [reviewId, filePath, enabled, attempt]);
  const failed = error || result?.before.status === 'error' || result?.after.status === 'error';
  const single = result && (result.before.status === 'absent' || result.after.status === 'absent');
  return (
    <section className="review-image-diff" aria-label="Image comparison" data-background={background}>
      <div className="review-image-toolbar">
        <span>
          {single ? (result.before.status === 'absent' ? 'Added image' : 'Deleted image') : 'Image comparison'}
        </span>
        <label>
          Background{' '}
          <select aria-label="Image background" value={background} onChange={(e) => setBackground(e.target.value)}>
            <option value="checkerboard">Checkerboard</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </div>
      {!reviewId && <p role="status">Save this review to load its image revisions.</p>}
      {busy && !result && <p role="status">Loading image revisions…</p>}
      {error && (
        <p className="review-image-error" role="status">
          Could not load images. {error}
        </p>
      )}
      {result && (
        <div className="review-image-pair" data-single={!!single}>
          <ImageSide
            key={`before-${attempt}-${filePath}`}
            label="Before"
            value={result.before}
            background={background}
          />
          <ImageSide key={`after-${attempt}-${filePath}`} label="After" value={result.after} background={background} />
        </div>
      )}
      {failed && (
        <button className="review-image-retry" disabled={busy} onClick={() => setAttempt((n) => n + 1)}>
          {busy ? 'Retrying…' : 'Retry images'}
        </button>
      )}
    </section>
  );
}
