import { readReviewState, writeReviewState } from './renderer-review-state';
import { useEffect } from 'react';
import { sourceForPath, subjectForReview } from './workbench';
import type { ReviewGuide } from './types';
import { fileRevisionKey } from './pr-changes';
import { useFileProgress, registerChangeProgress } from './file-view-progress';

/** Shared per-file progress. A new manifest preserves only unchanged review content. */
const migratedLegacyViews = new Set<string>();
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
    const migrate = async () => {
      if (migratedLegacyViews.has(oldKey)) return;
      migratedLegacyViews.add(oldKey);
      try {
        const old: unknown = readReviewState(oldKey) ?? [];
        if (!Array.isArray(old)) return;
        const saved = await Promise.all(
          old
            .filter((path): path is string => typeof path === 'string')
            .map((path) => progress.markFileViewed(keyFor(path), true))
        );
        if (saved.every(Boolean)) await writeReviewState(oldKey, null);
      } catch {
        /* Keep legacy progress if persistence fails. */
      }
    };
    void migrate();
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
