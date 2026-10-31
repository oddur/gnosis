import { draftActionBlockedReason, type PrActionState, type PrActionRequest, type PrActionResult } from './pr-actions';
import type { ReviewMember } from './workbench';

/** Use existing guarded writes; a partial failure never replays successful changes. */
export async function markPrsReady(
  members: ReviewMember[],
  account: string,
  deps: {
    read: (url: string, force: boolean) => Promise<PrActionState>;
    act: (request: PrActionRequest) => Promise<PrActionResult>;
    active: () => boolean;
    ready: (url: string) => void;
  }
) {
  const completed: string[] = [];
  for (const member of members) {
    if (!deps.active()) break;
    try {
      const state = await deps.read(member.url, true);
      if (!deps.active()) break;
      if (state.account !== account) throw Error('Your GitHub account changed. Try again from the current account.');
      if (state.isDraft) {
        const reason = draftActionBlockedReason(state, 'mark-ready');
        if (reason) throw Error(reason);
        await deps.act({
          account,
          kind: 'mark-ready',
          url: member.url,
          revisions: [
            { url: member.url, headSha: state.headSha, baseSha: state.baseSha, baseBranch: state.baseBranch },
          ],
        });
      } else if (state.state !== 'OPEN') throw Error('This PR is no longer open. Refresh the stack.');
      completed.push(member.url);
      deps.ready(member.url);
    } catch (error) {
      return { completed, failure: { member, message: error instanceof Error ? error.message : String(error) } };
    }
  }
  return { completed };
}
