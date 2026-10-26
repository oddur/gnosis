import { readReviewState, writeReviewState } from './renderer-review-state';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  readReviewDrafts,
  updateReviewDrafts,
  subscribeReviewDrafts,
  reviewDraftVersion,
  type ChangesReviewDraft,
} from './changes-review-drafts';
import { memberPrefix, sourceForPath, subjectForReview } from './workbench';
import type { PendingReviewComment, ReviewGuide } from './types';
import { isLocalUrl } from './local-url';

export function useExplanationComments(review: ReviewGuide, account: string) {
  useSyncExternalStore(subscribeReviewDrafts, reviewDraftVersion);
  const members = review.snapshot?.subject.members ?? [
    { url: review.prUrl, headSha: review.headSha ?? '', baseSha: review.baseSha ?? '', baseBranch: '' },
  ];
  const source = (path: string) => {
    const found = sourceForPath(review, path);
    if (members.length > 1 && !found.member) throw new Error('This code has no source PR. Open Changes to comment.');
    return { path: found.path, member: found.member ?? members[0] };
  };
  const addComment = useCallback(
    async (params: Omit<PendingReviewComment, 'id'>) => {
      const { path, member } = source(params.filePath);
      await updateReviewDrafts(account, member.url, (list) => [
        ...list,
        {
          ...params,
          filePath: path,
          id: crypto.randomUUID(),
          headSha: member.headSha,
          baseSha: member.baseSha,
          baseBranch: member.baseBranch,
        },
      ]);
    },
    [account, review]
  );
  const removeComment = useCallback(
    async (id: string) => {
      for (const member of members)
        if (readReviewDrafts(account, member.url).some((d) => d.id === id))
          await updateReviewDrafts(account, member.url, (list) => list.filter((d) => d.id !== id));
    },
    [account, review]
  );
  const editComment = useCallback(
    async (id: string, body: string) => {
      for (const member of members)
        if (readReviewDrafts(account, member.url).some((d) => d.id === id))
          await updateReviewDrafts(account, member.url, (list) => list.map((d) => (d.id === id ? { ...d, body } : d)));
    },
    [account, review]
  );
  // Migrate drafts from the old standalone viewer, retaining their original revisions.
  useEffect(() => {
    if (!account && !isLocalUrl(review.prUrl)) return;
    const key = `gnosis-drafts:${subjectForReview(review)}:${review.snapshot?.fingerprint ?? review.headSha}`;
    const migrate = async () => {
      try {
        const legacy = (readReviewState(key) ?? []) as PendingReviewComment[];
        if (!Array.isArray(legacy) || !legacy.length) return;
        for (const draft of legacy) {
          const { path, member } = source(draft.filePath);
          await updateReviewDrafts(account, member.url, (list) =>
            list.some((d) => d.id === draft.id)
              ? list
              : [
                  ...list,
                  {
                    ...draft,
                    filePath: path,
                    headSha: member.headSha,
                    baseSha: member.baseSha,
                    baseBranch: member.baseBranch,
                  },
                ]
          );
        }
        await writeReviewState(key, null);
      } catch {
        /* Keep the original drafts when migration cannot finish. */
      }
    };
    void migrate();
  }, [account, review]);
  const comments: ChangesReviewDraft[] = members.flatMap((member) =>
    readReviewDrafts(account, member.url)
      .filter((d) => d.headSha === member.headSha && d.baseSha === member.baseSha && d.baseBranch === member.baseBranch)
      .map((d) => ({
        ...d,
        filePath:
          members.length > 1 ? memberPrefix(member as import('./workbench').ReviewMember) + d.filePath : d.filePath,
      }))
  );
  return { comments, addComment, removeComment, editComment };
}
