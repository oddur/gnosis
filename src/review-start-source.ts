import { createDiffSource, type DiffSource } from '../lib/diffSource';
import { StackDiffSource } from '../lib/stack-source';
import { parsePrUrl } from '../lib/github';
import { isLocalUrl } from '../lib/local-url';
import { snapshot, type ReviewSubject } from '../lib/workbench';
import type { GenerateReviewRequest, PrMetadata } from '../lib/types';
import type { createWorkbenchService } from './workbench-service';

interface Dependencies {
  token: string | null;
  workbench: Pick<ReturnType<typeof createWorkbenchService>, 'mutedUrls' | 'queue' | 'subject' | 'fresh'>;
  /** Refuses an inaccessible PR. A check that reads the PR returns it, so the source does not read it again. */
  checkAccess: (url: string) => Promise<PrMetadata | undefined>;
  prSource?: (url: string, metadata?: PrMetadata) => Promise<DiffSource>;
  stackSource?: (subject: ReviewSubject, verified: ReadonlyMap<string, PrMetadata>) => DiffSource;
}

export const MUTED_PR_MESSAGE = 'This PR is muted. Restore it from Muted PRs first.';

/** Whether the request names one PR rather than the stack around it. */
export const singlePrRequest = (request: GenerateReviewRequest) =>
  request.standalone === true || request.subjectId === request.prUrl;

/** The review subject of a loaded PR: the queue's subject when there is one, otherwise the PR on its own. */
export function reviewSubjectFor(
  request: GenerateReviewRequest,
  prData: PrMetadata,
  subject: ReviewSubject | undefined
): ReviewSubject | undefined {
  if (!subject && !isLocalUrl(request.prUrl)) {
    const parsed = parsePrUrl(request.prUrl);
    const repo = parsed.owner + '/' + parsed.repo;
    subject = {
      scope: singlePrRequest(request) ? 'single' : undefined,
      id: request.prUrl,
      kind: 'pr',
      title: prData.title,
      members: [
        {
          ...prData,
          repo,
          headRepo: prData.headRepo ?? repo,
          baseRepo: prData.baseRepo ?? repo,
          number: parsed.pullNumber,
          role: 'watched',
        },
      ],
      edges: [],
      warnings: [],
    };
  }
  if (subject?.members.length === 1)
    subject.members[0] = {
      ...subject.members[0],
      ...prData,
      headRepo: prData.headRepo ?? subject.members[0].headRepo,
      baseRepo: prData.baseRepo ?? subject.members[0].baseRepo,
    };
  return subject;
}

/** Prepare the requested scope before creating history or starting a model. */
export async function prepareReviewSource(request: GenerateReviewRequest, deps: Dependencies) {
  const singlePr = singlePrRequest(request);
  if (singlePr && request.subjectId && request.subjectId !== request.prUrl) {
    throw new Error('The requested PR and review scope do not match. Open the PR again and retry.');
  }
  let subject: ReviewSubject | undefined;
  if (deps.workbench.mutedUrls().has(request.prUrl)) throw new Error(MUTED_PR_MESSAGE);
  // One access check per PR in this request. Each fresh read also serves as that PR's metadata.
  const verified = new Map<string, PrMetadata>();
  const checks = new Map<string, Promise<void>>();
  const check = (url: string) => {
    let pending = checks.get(url);
    if (!pending) {
      pending = deps.checkAccess(url).then((metadata) => {
        if (metadata) verified.set(url, metadata);
      });
      checks.set(url, pending);
    }
    return pending;
  };
  if (!isLocalUrl(request.prUrl)) {
    // Verify the requested PR before queue discovery or creating a generation/history entry.
    await check(request.prUrl);
    // An explicit PR already identifies the source. Queue discovery is neither
    // an access check nor a prerequisite, and must not expand it into a stack.
    if (!singlePr) {
      const queue = await deps.workbench.queue();
      subject = request.subjectId
        ? deps.workbench.subject(request.subjectId)
        : queue.items.find((item) => item.subject.members.some((member) => member.url === request.prUrl))?.subject;
      if (request.subjectId && !subject) {
        throw new Error(
          'This stack has changed or is no longer available. Open the stack again to review its current PRs.'
        );
      }
    }
    if (subject) {
      // Members are independent, so their checks run together through the GitHub scheduler.
      await Promise.all(subject.members.map((member) => check(member.url)));
      subject = await deps.workbench.fresh(subject, verified);
    }
  }
  const source =
    subject && subject.members.length > 1
      ? (deps.stackSource ?? ((value, known) => new StackDiffSource(value, deps.token, undefined, known)))(
          subject,
          verified
        )
      : await (deps.prSource ?? ((url, metadata) => createDiffSource(url, { token: deps.token, metadata })))(
          request.prUrl,
          verified.get(request.prUrl)
        );
  const prData = await source.getMetadata();
  subject = reviewSubjectFor(request, prData, subject);
  const reviewSnapshot = subject ? snapshot(subject) : undefined;
  return { source, prData, reviewSnapshot };
}
