import { LFS_VERSION, type LfsPointer } from './git-lfs';
import type { ReviewGuide } from './types';

const imageTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};
export function imageMimeType(filePath: string): string | undefined {
  return imageTypes[filePath.split('.').pop()?.toLowerCase() ?? ''];
}
export type ReviewImageSide =
  | { status: 'absent' }
  | { status: 'lfs'; pointer: LfsPointer; path: string; revision: string; error?: string }
  | { status: 'ready'; dataUrl: string; path: string; revision: string }
  | { status: 'text'; content: string; path: string; revision: string }
  | { status: 'error'; message: string };
export interface ReviewImageComparison {
  before: ReviewImageSide;
  after: ReviewImageSide;
}

export function reviewImageFiles(review: ReviewGuide): string[] {
  return (
    review.imageFiles ??
    review.changedFiles?.map((f) => f.filename).filter((file) => !review.excludedFiles?.includes(file)) ??
    []
  ).filter((file) => imageMimeType(file));
}

/** Binary changes have no text hunks. Make them reachable in older and new reviews. */
export function includeImageChanges(review: ReviewGuide): void {
  const covered = new Set(review.slides.flatMap((s) => [...s.affectedFiles, ...s.diffHunks.map((h) => h.filePath)]));
  const missing = reviewImageFiles(review).filter((file) => !covered.has(file));
  if (!missing.length) return;
  review.slides.push({
    id: 'gnosis-image-changes',
    slideNumber: review.slides.length + 1,
    title: 'Image changes',
    slideType: 'feature',
    narrative: 'Compare the image files changed in this review.',
    reviewFocus: null,
    diffHunks: [],
    contextSnippets: [],
    affectedFiles: missing,
    dependsOn: [],
  });
}

export function isLfsReviewFile(review: ReviewGuide, filePath: string): boolean {
  return review.slides.some((slide) =>
    slide.diffHunks.some((hunk) => hunk.filePath === filePath && hunk.content.includes(LFS_VERSION))
  );
}
