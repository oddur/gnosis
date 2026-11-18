import test from 'node:test';
import assert from 'node:assert/strict';
import {
  conflictPushNeedsWorkflow,
  FINE_GRAINED_WORKFLOW_NOTE,
  fineGrainedWorkflowNote,
  GITHUB_SCOPE_PROMPT,
  GITHUB_TOKEN_URL,
  githubTokenKind,
  githubWriteError,
  resolutionWorkflowFiles,
  scopePromptCopy,
  TEAM_REQUESTS_NOTE,
  teamRequestsNoteVisible,
  WORKFLOW_PUSH_WARNING,
  WORKFLOW_WRITE_MESSAGE,
} from '../lib/github-access';
import { describeConflictError } from '../lib/conflict-flow';
import { mergeReadiness } from '../lib/merge-readiness';
import { writeErrorDetail } from '../lib/write-failures';
import type { QueueSignals } from '../lib/queue-signals';

const NEEDS = 'Needs the workflow permission. GitHub only accepts changes to GitHub Actions workflows (.github/workflows/…) from sign-ins with the workflow permission.';

void test('githubWriteError maps GitHub’s workflow-scope refusal from git push, GraphQL and REST, and leaves other errors alone', () => {
  assert.equal(WORKFLOW_WRITE_MESSAGE, NEEDS);
  // git push, through the conflict service's Git wrapper and Electron's IPC wrapper.
  const push = githubWriteError(
    new Error(
      "Error invoking remote method 'conflict-resolution': Error: Git could not complete this operation. To https://github.com/klang/engine.git\n ! [remote rejected] d1 -> feature/retry (refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)\nerror: failed to push some refs"
    )
  );
  assert.equal(push.workflowPermission, true);
  assert.equal(push.message, NEEDS);
  assert.deepEqual(push.workflowFiles, ['.github/workflows/ci.yml']);
  assert.match(push.raw, /^Git could not complete this operation/);
  // GraphQL (mergePullRequest, updatePullRequestBranch), as Octokit reports it.
  const graphql = githubWriteError(
    new Error(
      "Request failed due to following response errors:\n - Refusing to allow an OAuth App to create or update workflow `.github/workflows/seed_job_seed_api.yaml` without `workflow` scope"
    )
  );
  assert.equal(graphql.workflowPermission, true);
  assert.deepEqual(graphql.workflowFiles, ['.github/workflows/seed_job_seed_api.yaml']);
  // REST (PUT …/merge-async, PUT …/update-branch): Octokit's RequestError carries GitHub's message and docs link.
  assert.equal(
    githubWriteError(
      new Error(
        'refusing to allow a Personal Access Token to create or update workflow `.github/workflows/a.yml` without `workflow` scope - https://docs.github.com/rest/pulls/pulls#merge-a-pull-request'
      )
    ).workflowPermission,
    true
  );
  assert.equal(
    githubWriteError('refusing to allow a GitHub App to create or update workflow `.github/workflows/a.yml` without `workflows` permission').workflowPermission,
    true
  );
  // Anything else: GitHub's reason, without the IPC wrapper.
  const other = githubWriteError(new Error("Error invoking remote method 'perform-pr-action': Error: Base branch was modified. Review and try the merge again."));
  assert.equal(other.workflowPermission, false);
  assert.equal(other.message, 'Base branch was modified. Review and try the merge again.');
  assert.equal(githubWriteError(new Error('Required status check "ci" is expected.')).message, 'Required status check "ci" is expected.');
  assert.equal(githubWriteError(new Error('Resource not accessible by integration')).workflowPermission, false);
  assert.equal(githubWriteError(new Error('Workflow run failed')).workflowPermission, false, 'Mentioning workflows is not a refusal');
  // Optimistic writes (auto-merge) share the mapping.
  assert.equal(writeErrorDetail(new Error('refusing to allow an OAuth App to create or update workflow `.github/workflows/x.yml` without `workflow` scope')), NEEDS);
  assert.equal(writeErrorDetail(new Error('')), 'GitHub did not accept the change.');
});

void test('the conflict push waits for the workflow permission when the resolution changes workflow files', () => {
  const files = [{ name: 'src/retry.ts' }, { name: '.github/workflows/ci.yml' }];
  assert.deepEqual(resolutionWorkflowFiles(files), ['.github/workflows/ci.yml']);
  assert.deepEqual(resolutionWorkflowFiles([{ name: 'ci/old.yml', prevName: '.github/workflows/old.yml' }]), ['.github/workflows/old.yml'], 'A renamed-away workflow counts');
  assert.equal(conflictPushNeedsWorkflow(['repo', 'read:org'], files), true);
  assert.equal(conflictPushNeedsWorkflow(['repo'], files), true);
  assert.equal(conflictPushNeedsWorkflow(['repo', 'read:org', 'workflow'], files), false);
  assert.equal(conflictPushNeedsWorkflow(['repo', 'read:org'], [{ name: 'src/retry.ts' }]), false, 'No workflow files: push');
  assert.equal(conflictPushNeedsWorkflow(['repo', 'read:org'], [{ name: '.github/dependabot.yml' }]), false);
  assert.equal(conflictPushNeedsWorkflow(null, files), false, 'Fine-grained tokens report no scopes: GitHub’s refusal maps instead');
  assert.equal(conflictPushNeedsWorkflow(undefined, files), false);
  assert.equal(conflictPushNeedsWorkflow(['repo'], undefined), false, 'No preview yet');
  assert.equal(
    WORKFLOW_PUSH_WARNING,
    'This resolution changes GitHub Actions workflows (.github/workflows/…). GitHub only accepts pushes that change workflows from sign-ins with the workflow permission.'
  );
  // A refused push reads as the same plain message, with the sign-in as the recovery. Resolutions are kept.
  const refused = describeConflictError(
    "Error invoking remote method 'conflict-resolution': Error: Git could not complete this operation. ! [remote rejected] d1 -> feature/retry (refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)",
    { stage: 'push', headBranch: 'feature/retry' }
  );
  assert.equal(refused.title, 'Needs the workflow permission.');
  assert.equal(refused.body, `${WORKFLOW_PUSH_WARNING} Nothing was pushed. Your resolutions are saved.`);
  assert.equal(refused.recovery, 'sign-in');
  assert.match(refused.details ?? '', /refusing to allow an OAuth App/, 'GitHub’s words stay under Details');
  // Other push failures keep their copy.
  assert.equal(describeConflictError('Git could not complete this operation. ! [rejected] feature/retry (stale info)', { stage: 'push', headBranch: 'feature/retry' }).recovery, 'load-latest');
});

void test('the team-request note shows only for a sign-in that GitHub reported without read:org', () => {
  const visible = (scopes: string[] | null | undefined, showsTeamRequests = true, dismissed: string[] = []) =>
    teamRequestsNoteVisible({ scopes, showsTeamRequests, dismissed });
  assert.equal(visible(['repo', 'workflow']), true);
  assert.equal(visible(['repo']), true);
  assert.equal(visible(['repo', 'read:org']), false);
  assert.equal(visible(['repo', 'admin:org']), false, 'admin:org includes read:org');
  assert.equal(visible(['repo', 'write:org']), false);
  assert.equal(visible(null), false, 'Fine-grained tokens report no scopes');
  assert.equal(visible(undefined), false, 'Not checked yet');
  assert.equal(visible(['repo'], false), false, 'The surface shows no team requests');
  assert.equal(visible(['repo'], true, ['read:org']), false, 'Not now on this surface');
  assert.equal(visible(['repo'], true, ['workflow']), true, 'Dismissing another scope does not hide it');
  assert.equal(
    TEAM_REQUESTS_NOTE,
    'Team review requests may be incomplete: Gnosis can’t read your organization’s teams. Sign in again to allow it.'
  );
});

void test('a personal access token gets token instructions instead of Sign in again', () => {
  assert.equal(githubTokenKind('ghp_abc'), 'classic');
  assert.equal(githubTokenKind('gho_abc'), 'oauth');
  assert.equal(githubTokenKind('github_pat_abc'), 'fine-grained');
  assert.equal(githubTokenKind('ghu_abc'), 'app');
  assert.equal(githubTokenKind('0123456789abcdef0123456789abcdef01234567'), 'unknown');
  assert.equal(GITHUB_TOKEN_URL, 'https://github.com/settings/tokens/new?scopes=repo,read:org,workflow&description=Gnosis');
  assert.deepEqual(scopePromptCopy({ scopes: ['repo'], tokenKind: 'classic' }), {
    kind: 'token',
    text: 'Your personal access token is missing: read:org, workflow. Create a token with repo, read:org and workflow, then sign in with it.',
    url: GITHUB_TOKEN_URL,
  });
  assert.equal(
    scopePromptCopy({ scopes: ['repo', 'read:org'], tokenKind: 'classic' }).text,
    'Your personal access token is missing: workflow. Create a token with repo, read:org and workflow, then sign in with it.'
  );
  // A refused write names what needs the permission first.
  assert.equal(
    scopePromptCopy({ scopes: ['repo', 'read:org'], tokenKind: 'classic' }, NEEDS).text,
    `${NEEDS} Your personal access token is missing: workflow. Create a token with repo, read:org and workflow, then sign in with it.`
  );
  // Gnosis's own sign-in, older main processes and fine-grained tokens keep Sign in again.
  assert.deepEqual(scopePromptCopy({ scopes: ['repo'], tokenKind: 'oauth' }), { kind: 'sign-in', text: GITHUB_SCOPE_PROMPT });
  assert.deepEqual(scopePromptCopy({ scopes: ['repo'] }), { kind: 'sign-in', text: GITHUB_SCOPE_PROMPT });
  assert.deepEqual(scopePromptCopy(undefined, NEEDS), { kind: 'sign-in', text: NEEDS });
});

void test('a fine-grained token gets a quiet line about the Workflows permission when GitHub says BLOCKED', () => {
  const member = { url: 'https://github.com/klang/seed/pull/35392', headSha: 'a'.repeat(40), merged: false, state: 'open' as const, isDraft: false, baseBranch: 'develop' };
  const now = Date.parse('2026-11-18T12:00:00Z');
  const seen = {
    url: member.url,
    headSha: member.headSha,
    checkedAt: now,
    checks: { state: 'success', total: 3, passed: 3, failed: 0 },
    readiness: { mergeState: 'BLOCKED', mergeable: 'MERGEABLE', reviewDecision: null, isDraft: false, baseBranch: 'develop' },
  } as unknown as QueueSignals;
  const files = ['.github/workflows/ci.yml'];
  assert.equal(fineGrainedWorkflowNote(null, files), true);
  assert.equal(fineGrainedWorkflowNote(null, []), false);
  assert.equal(fineGrainedWorkflowNote(null, undefined), false);
  assert.equal(fineGrainedWorkflowNote(['repo'], files), false, 'A classic token gets the workflow answer instead');
  const fine = mergeReadiness(member, seen, now, { scopes: null }, files);
  assert.equal(fine.label, 'GitHub reports this as blocked');
  assert.equal(fine.signIn, false, 'No prompt');
  assert.equal(fine.details.at(-1), FINE_GRAINED_WORKFLOW_NOTE);
  assert.equal(
    FINE_GRAINED_WORKFLOW_NOTE,
    'If you signed in with a fine-grained token, it may need the Workflows permission (read and write) for this repository.'
  );
  assert.ok(!mergeReadiness(member, seen, now, { scopes: null }, []).details.includes(FINE_GRAINED_WORKFLOW_NOTE));
  assert.ok(!mergeReadiness(member, seen, now, { scopes: ['repo', 'read:org', 'workflow'] }, files).details.includes(FINE_GRAINED_WORKFLOW_NOTE));
  // A visible blocker keeps its own answer.
  const failing = { ...seen, checks: { state: 'failure', total: 3, passed: 2, failed: 1 } } as unknown as QueueSignals;
  assert.ok(!mergeReadiness(member, failing, now, { scopes: null }, files).details.includes(FINE_GRAINED_WORKFLOW_NOTE));
});
