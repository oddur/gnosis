import type { MarkdownReview, MarkdownReviewRequest } from './markdown-review';
// Immutable revision keys, bounded by entry count and document length. Full ASTs live in the backend's byte-bounded cache.
const cached = new Map<string, MarkdownReview>();
const pending = new Map<string, Promise<MarkdownReview>>();
let epoch = 0;
export function clearMarkdownReviews() {
  epoch++;
  cached.clear();
  pending.clear();
}
export const peekMarkdownReview = (key: string) => cached.get(key);
export function prepareMarkdownReview(key: string, request: MarkdownReviewRequest): Promise<MarkdownReview> {
  const value = cached.get(key);
  if (value) return Promise.resolve(value);
  const existing = pending.get(key);
  if (existing) return existing;
  const started = epoch;
  const work = window.electronAPI
    .renderMarkdownReview(request)
    .then((result) => {
      if (started !== epoch) throw new Error('The GitHub account changed. Reopen this file.');
      cached.set(key, result);
      while (cached.size > 8) {
        const oldest = cached.keys().next().value;
        if (oldest === undefined) break;
        cached.delete(oldest);
      }
      return result;
    })
    .finally(() => {
      if (pending.get(key) === work) pending.delete(key);
    });
  pending.set(key, work);
  return work;
}
