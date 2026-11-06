import { createDiffSource, type DiffSource } from '../lib/diffSource';
import { StackDiffSource } from '../lib/stack-source';
import { parsePrUrl } from '../lib/github';
import { isLocalUrl } from '../lib/local-url';
import { snapshot, type ReviewSubject } from '../lib/workbench';
import type { GenerateReviewRequest } from '../lib/types';
import type { createWorkbenchService } from './workbench-service';

interface Dependencies {
  token: string | null;
  workbench: Pick<ReturnType<typeof createWorkbenchService>, 'mutedUrls' | 'queue' | 'subject' | 'fresh'>;
  checkAccess: (url: string) => Promise<void>;
  prSource?: (url: string) => Promise<DiffSource>;
  stackSource?: (subject: ReviewSubject) => DiffSource;
}

/** Prepare the requested scope before creating history or starting a model. */
export async function prepareReviewSource(request: GenerateReviewRequest, deps: Dependencies) {
  const singlePr = request.standalone === true || request.subjectId === request.prUrl;
  if (singlePr && request.subjectId && request.subjectId !== request.prUrl) {
    throw new Error('The requested PR and review scope do not match. Open the PR again and retry.');
  }
  let subject: ReviewSubject | undefined;
  if (deps.workbench.mutedUrls().has(request.prUrl))
    throw new Error('This PR is muted. Restore it from Muted PRs first.');
  if (!isLocalUrl(request.prUrl)) {
    // Verify the requested PR before queue discovery or creating a generation/history entry.
    await deps.checkAccess(request.prUrl);
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
      for (const member of subject.members) {
        if (member.url !== request.prUrl) await deps.checkAccess(member.url);
      }
      subject = await deps.workbench.fresh(subject);
    }
  }
  const source =
    subject && subject.members.length > 1
      ? (deps.stackSource ?? ((value) => new StackDiffSource(value, deps.token)))(subject)
      : await (deps.prSource ?? ((url) => createDiffSource(url, { token: deps.token })))(request.prUrl);
  const prData = await source.getMetadata();
  if (!subject && !isLocalUrl(request.prUrl)) {
    const parsed = parsePrUrl(request.prUrl);
    const repo = parsed.owner + '/' + parsed.repo;
    subject = {
      scope: singlePr ? 'single' : undefined,
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
  const reviewSnapshot = subject ? snapshot(subject) : undefined;
  return { source, prData, reviewSnapshot };
}
