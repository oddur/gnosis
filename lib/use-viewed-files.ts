import { useEffect } from 'react';
import { sourceForPath, subjectForReview } from './workbench';
import type { ReviewGuide } from './types';
import { fileRevisionKey } from './pr-changes';
import { useFileProgress, registerChangeProgress } from './file-view-progress';

/** Shared per-file progress. A new manifest preserves only unchanged review content. */
export function useViewedFiles(review: ReviewGuide) {
  const progress = useFileProgress();
  const revision = review.snapshot?.fingerprint ?? review.headSha ?? review.reviewId ?? '';
  const oldKey = `gnosis-viewed-files:${subjectForReview(review)}:${revision}`;
  const keyFor = (path: string) => {
    const source = sourceForPath(review, path);
    return fileRevisionKey(
      source.member?.url ?? review.prUrl,
      source.path,
      source.member?.baseSha ?? review.baseSha ?? '',
      source.member?.headSha ?? review.headSha ?? revision
    );
  };
  const paths = new Set([
    ...(review.changedFiles?.map((f) => f.filename) ?? []),
    ...review.slides.flatMap((s) => [...s.affectedFiles, ...s.diffHunks.map((h) => h.filePath)]),
  ]);
  useEffect(() => {
    try {
      const old: unknown = JSON.parse(localStorage.getItem(oldKey) ?? '[]');
      if (Array.isArray(old))
        for (const path of old) if (typeof path === 'string') progress.markFileViewed(keyFor(path), true);
      localStorage.removeItem(oldKey);
    } catch {
      /* Old progress is optional. */
    }
    const members = review.snapshot?.subject.members ?? [
      { url: review.prUrl, baseSha: review.baseSha, headSha: review.headSha },
    ];
    for (const member of members)
      if (member.url.startsWith('https://github.com/')) {
        void window.electronAPI
          .getPrChanges(member.url)
          .then((snapshot) => {
            if (snapshot.metadata.baseSha === member.baseSha && snapshot.metadata.headSha === member.headSha)
              registerChangeProgress(snapshot);
          })
          .catch(() => {});
      }
  }, [oldKey]);
  return {
    viewedFiles: new Set([...paths].filter((path) => progress.isFileViewed(keyFor(path)))),
    setFileViewed: (path: string, viewed: boolean) => progress.markFileViewed(keyFor(path), viewed),
  };
}
