import type { ReviewGuide } from '../../lib/types';
import type { ReviewImageComparison, ReviewImageSide } from '../../lib/review-images';
import { sourceForPath } from '../../lib/workbench';

export function imageMocks(review: ReviewGuide) {
  const topic = review.slides[0];
  const prefix = topic.affectedFiles[0].replace(/src\/command-queue\.ts$/, '');
  const names = ['mark.svg', 'photo.png', 'added.svg', 'deleted.svg', 'retry.svg'];
  topic.title = 'Update image assets';
  topic.narrative =
    'Compare the previous and updated image assets. The vector mark keeps transparency while the raster image changes color.';
  topic.affectedFiles = names.map((name) => prefix + name);
  topic.inlineExplanations = [];
  topic.fileSummaries = [];
  topic.diffHunks = [
    {
      ...topic.diffHunks[0],
      filePath: prefix + names[0],
      language: 'svg',
      hunkHeader: '@@ -1 +1 @@',
      content: '-<svg width="120" height="80"/>\n+<svg width="160" height="80"/>',
    },
  ];
  review.changedFiles = names.map((name) => ({
    filename: prefix + name,
    status: name.startsWith('added') ? 'added' : name.startsWith('deleted') ? 'deleted' : 'modified',
    additions: 0,
    deletions: 0,
  }));
  const calls = new Map<string, number>();
  return {
    loadReviewImages: (id: string, path: string): Promise<ReviewImageComparison> => {
      if (id !== review.reviewId || !topic.affectedFiles.includes(path)) throw new Error('Incorrect revision request');
      calls.set(path, (calls.get(path) ?? 0) + 1);
      document.body.dataset.imageReads = JSON.stringify(Object.fromEntries(calls));
      const name = sourceForPath(review, path).path;
      const side = (before: boolean): ReviewImageSide => {
        if (name === (before ? 'added.svg' : 'deleted.svg')) return { status: 'absent' };
        if (name === 'retry.svg' && !before && calls.get(path) === 1)
          return { status: 'error', message: 'Image temporarily unavailable.' };
        const canvas = document.createElement('canvas');
        canvas.width = 180;
        canvas.height = 120;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = before ? '#15803d' : '#2563eb';
          ctx.fillRect(0, 0, 180, 120);
        }
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${before ? 120 : 160}" height="80"><script>window.parent.imageScriptRan=true</script><rect x="10" y="10" width="${before ? 100 : 140}" height="60" rx="12" fill="${before ? '#15803d' : '#2563eb'}"/></svg>`;
        return {
          status: 'ready',
          path: name,
          revision: (before ? 'a' : 'b').repeat(40),
          dataUrl: name.endsWith('.png') ? canvas.toDataURL('image/png') : `data:image/svg+xml;base64,${btoa(svg)}`,
        };
      };
      return Promise.resolve({ before: side(true), after: side(false) });
    },
  };
}
