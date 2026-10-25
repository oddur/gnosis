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
    (params: Omit<PendingReviewComment, 'id'>) => {
      const { path, member } = source(params.filePath);
      updateReviewDrafts(account, member.url, (list) => [
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
    (id: string) => {
      for (const member of members)
        if (readReviewDrafts(account, member.url).some((d) => d.id === id))
          updateReviewDrafts(account, member.url, (list) => list.filter((d) => d.id !== id));
    },
    [account, review]
  );
  const editComment = useCallback(
    (id: string, body: string) => {
      for (const member of members)
        if (readReviewDrafts(account, member.url).some((d) => d.id === id))
          updateReviewDrafts(account, member.url, (list) => list.map((d) => (d.id === id ? { ...d, body } : d)));
    },
    [account, review]
  );
  // Migrate drafts from the old standalone viewer, retaining their original revisions.
  useEffect(() => {
    if (!account) return;
    const key = `gnosis-drafts:${subjectForReview(review)}:${review.snapshot?.fingerprint ?? review.headSha}`;
    try {
      const legacy: PendingReviewComment[] = JSON.parse(localStorage.getItem(key) ?? '[]') as PendingReviewComment[];
      if (!Array.isArray(legacy) || !legacy.length) return;
      for (const draft of legacy) {
        const { path, member } = source(draft.filePath);
        updateReviewDrafts(account, member.url, (list) =>
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
      localStorage.removeItem(key);
    } catch {
      /* Keep the original drafts when migration cannot finish. */
    }
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
