import type { Octokit } from '@octokit/rest';
import { getPrMetadata, parsePrUrl } from '../lib/github';
import { parsePatchValidLines } from '../lib/diff-lines';
import type { SubmitReviewRequest } from '../lib/types';
import type { CreateReviewCommentRequest } from '../lib/review-threads';

type Comment = SubmitReviewRequest['comments'][number];
export function validCommentRange(comment: Comment, lines?: Set<string>) {
  const start = comment.startLine ?? comment.line;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(comment.line) || start < 1 || start > comment.line)
    return false;
  // A range may not span an omitted section of the patch.
  if (!lines || comment.line - start >= lines.size) return false;
  for (let n = start; n <= comment.line; n++) if (!lines.has(`${n}:${comment.side}`)) return false;
  return true;
}
function validateBody(body: string) {
  if (typeof body !== 'string' || !body.trim() || body.length > 65536)
    throw new Error('Enter a comment of at most 65,536 characters.');
}
async function assertRevision(
  client: Octokit,
  req: Pick<SubmitReviewRequest, 'prUrl' | 'headSha' | 'baseSha' | 'baseBranch'>
) {
  const { owner, repo, pullNumber } = parsePrUrl(req.prUrl);
  const current = await getPrMetadata(client, owner, repo, pullNumber, true);
  if (
    !req.headSha ||
    current.headSha !== req.headSha ||
    (req.baseSha && current.baseSha !== req.baseSha) ||
    (req.baseBranch && current.baseBranch !== req.baseBranch)
  )
    throw new Error('This PR or its parent changed. Update changes before posting. Your drafts are kept.');
  if (current.merged || current.state !== 'open') throw new Error('This PR is no longer open for review.');
  return { owner, repo, pull_number: pullNumber };
}
async function lineInventory(client: Octokit, target: { owner: string; repo: string; pull_number: number }) {
  const files = await client.paginate(client.pulls.listFiles, {
    ...target,
    per_page: 100,
    headers: { 'cache-control': 'no-cache' },
  });
  return new Map(files.filter((f) => f.patch).map((f) => [f.filename, parsePatchValidLines(f.patch ?? '')]));
}
const coordinates = (c: Comment) => ({
  path: c.path,
  line: c.line,
  side: c.side,
  body: c.body,
  ...(c.startLine !== undefined && c.startLine !== c.line ? { start_line: c.startLine, start_side: c.side } : {}),
});

export async function createReviewComment(client: Octokit, req: CreateReviewCommentRequest) {
  validateBody(req.body);
  const target = await assertRevision(client, req);
  const lines = await lineInventory(client, target);
  if (!validCommentRange(req, lines.get(req.path)))
    throw new Error('These lines are outside GitHub’s current diff. Select lines in a changed section.');
  await assertRevision(client, req);
  await client.pulls.createReviewComment({ ...target, commit_id: req.headSha, ...coordinates(req) });
}

export async function submitPrReview(client: Octokit, req: SubmitReviewRequest, signature: boolean) {
  if (!['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(req.event)) throw new Error('Unknown review action.');
  for (const comment of req.comments) validateBody(comment.body);
  const target = await assertRevision(client, req);
  const lines = req.comments.length ? await lineInventory(client, target) : new Map<string, Set<string>>();
  const valid = req.comments.filter((c) => validCommentRange(c, lines.get(c.path)));
  const dropped = req.comments.filter((c) => !valid.includes(c));
  let body = req.body;
  if (dropped.length)
    body +=
      `\n\n---\n_${dropped.length} comment(s) could not be posted inline (lines outside the diff range):_\n\n` +
      dropped.map((c) => `**${c.path}:${c.startLine ? `${c.startLine}–` : ''}${c.line}** — ${c.body}`).join('\n\n');
  if (signature) body += '\n\n---\n_Reviewed using [gnosis.to](https://gnosis.to)_';
  if (req.comments.length) await assertRevision(client, req);
  const { data } = await client.pulls.createReview({
    ...target,
    commit_id: req.headSha,
    event: req.event,
    body,
    comments: valid.map(coordinates),
  });
  return { reviewUrl: data.html_url, droppedCommentCount: dropped.length };
}
