import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PARK_LIMIT, ago, decideEvidence, heldForkRuns, mergeBlockers, plainText, primaryAction, riskyPath, runScope, runSummary, sessionSteps, settlePark, showsDepth, span, stepDigest, stepFacts, stepId, suggestDepth, type Park, type SessionStep } from '../lib/guided-session';
import type { DecisionItem, NextItem } from '../lib/morning';
import type { QueueSignals } from '../lib/queue-signals';
import type { ReviewMember } from '../lib/workbench';

/** A guided session (#596): the digest, the blockers, the depth and the run's end (lib/guided-session.ts). */

const NOW = Date.parse('2026-11-27T12:00:00Z');
const member = (over: Partial<ReviewMember> = {}) =>
  ({ url: 'https://github.com/o/r/pull/1', number: 1, title: 'Fix retry backoff', author: 'sam', repo: 'o/r', isDraft: false, baseBranch: 'main', additions: 30, deletions: 8, changedFileCount: 2, commitCount: 3, ...over }) as ReviewMember;
const signals = (over: Partial<QueueSignals> = {}, readiness: Partial<NonNullable<QueueSignals['readiness']>> = {}) =>
  ({
    url: member().url,
    headSha: 'h',
    checkedAt: NOW,
    comments: 0,
    checks: { state: 'success', passed: 4, failed: 0, running: 0, total: 4 },
    readiness: { state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeState: 'CLEAN', reviewDecision: 'APPROVED', baseBranch: 'main', baseSha: 'b', behindBy: 0, mergeQueue: false, queueState: null, ...readiness },
    ...over,
  }) as QueueSignals;
const step = (kind: SessionStep['kind'], over: Partial<ReviewMember> = {}) => ({ kind, member: member(over) });

void test('blockers: each cause with its action and owner, most unblocking first', () => {
  assert.deepEqual(mergeBlockers(member(), signals(), 'me'), [], 'A clean, approved, passing PR has none');
  const blocked = mergeBlockers(
    member(),
    signals({ checks: { state: 'failure', passed: 9, failed: 3, total: 12 }, threads: { unresolved: ['a', 'b'], complete: true } }, { mergeable: 'CONFLICTING', mergeState: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }),
    'me'
  );
  assert.deepEqual(blocked.map((b) => [b.action.kind, b.cause, b.owner]), [
    ['resolve-conflicts', 'Conflicts with main', 'anyone'],
    ['rerun-failed', '3 of 12 checks failing', 'anyone'],
    ['review', 'Needs an approving review', 'me'],
    ['show-threads', '2 unresolved threads', 'anyone'],
  ]);
  const behind = mergeBlockers(member(), signals({}, { mergeState: 'BEHIND', behindBy: 4 }), 'me');
  assert.deepEqual(behind.map((b) => b.cause), ['Behind main by 4 commits']);
  const own = mergeBlockers(member({ author: 'me' }), signals({}, { reviewDecision: 'CHANGES_REQUESTED' }), 'me');
  assert.deepEqual(own.map((b) => [b.action.kind, b.owner]), [['reply', 'me']], 'On my own PR, a change request is mine to answer');
  const unknown = mergeBlockers(member(), signals({}, { mergeState: 'BLOCKED' }), 'me');
  assert.deepEqual(unknown.map((b) => b.action.kind), ['open-on-github'], 'Blocked with no cause Gnosis can see: the merge box');
  assert.deepEqual(mergeBlockers(member(), undefined, 'me'), [], 'Not read yet: none, and the step says so');
});

void test('depth: summary or deep review, with the rule that chose it', () => {
  assert.deepEqual(suggestDepth(step('rereview'), 14), { depth: 'summary', reason: 'Small update to code you reviewed (14 lines).' });
  assert.equal(suggestDepth(step('rereview'), 120).depth, 'deep');
  assert.equal(suggestDepth(step('rereview'), undefined).depth, 'deep', 'An update of unknown size is read in full');
  assert.match(suggestDepth(step('review'), undefined).reason, /^You haven’t read this PR yet \(38 lines\)\.$/);
  for (const kind of ['merge', 'fix', 'reply', 'changes', 'decide'] as const) assert.equal(suggestDepth(step(kind), undefined).depth, 'summary', kind);
});

void test('digest: your last review, then what came after it, from GitHub data only', () => {
  const reviewed = signals({ mine: { url: member().url, author: 'me', state: 'APPROVED', submittedAt: '2026-11-26T12:00:00Z', headSha: 'old' }, checks: { state: 'failure', passed: 3, failed: 1, total: 4 } });
  const since = [
    { type: 'checks-red' as const, key: 'k', url: member().url, at: NOW - 2 * 3_600_000 },
    { type: 'checks-red' as const, key: 'old', url: member().url, at: Date.parse('2026-11-25T12:00:00Z') },
  ];
  const digest = stepDigest({ step: step('rereview'), signals: reviewed, login: 'me', now: NOW, since, rereviewLines: 14, reply: { author: 'lena', text: 'Can we cap the **backoff**?' } });
  assert.equal(digest.lead, 'You approved yesterday. Since then:');
  assert.deepEqual(digest.lines.map((line) => [line.tone, line.text, line.quote]), [
    ['attention', 'lena replied', 'Can we cap the backoff?'],
    ['neutral', '14 lines changed since your review', undefined],
    ['danger', '1 of 4 checks failing since 2 hours ago', undefined],
  ]);
  assert.equal(stepDigest({ step: step('review'), signals: signals(), login: 'me', now: NOW, since: [] }).lines[0].text, '3 commits · +30 −8 in 2 files');
  assert.equal(stepDigest({ step: step('fix', { author: 'me' }), signals: signals(), login: 'me', now: NOW, since: [] }).lead, 'Your PR.');
  assert.equal(stepDigest({ step: step('rereview'), signals: signals(), login: 'me', now: NOW, since: [] }).lead, 'Updated since your review:', 'A re-review whose review Gnosis has not read');
});

void test('the primary action and the run summary', () => {
  assert.equal(primaryAction({ kind: 'merge' }, [], 'summary'), 'Merge');
  assert.equal(primaryAction({ kind: 'review' }, [], 'deep'), 'Start review');
  assert.equal(primaryAction({ kind: 'rereview' }, [], 'summary'), 'Review the update');
  const steps = [1, 2, 3].map((n) => ({ id: `s${n}`, member: member({ number: n, title: `PR ${n}` }) }));
  const summary = runSummary(steps, { s1: 'done', s2: 'skipped' });
  assert.equal(summary.done, 1);
  assert.deepEqual(summary.lines.map((line) => line.text), ['Moved: #1 PR 1', 'Skipped: #2 PR 2', 'Still on your list: #3 PR 3']);
  const muted = runSummary(steps, { s1: 'muted', s3: 'done' });
  assert.deepEqual(muted.groups.map((group) => group.label), ['Moved', 'Muted', 'Still on your list'], 'A muted PR is let go, not moved');
  const snoozed = runSummary(steps, { s1: 'snoozed', s2: 'skipped' });
  assert.equal(snoozed.done, 0, 'A snoozed PR was put off, not moved');
  assert.deepEqual(snoozed.groups.map((group) => [group.label, group.steps.map((step) => step.index)]), [['Snoozed', [0]], ['Skipped', [1]], ['Still on your list', [2]]]);
});

void test('plain text and ages', () => {
  assert.equal(plainText('> quoted\n**bold** and `code` and [a link](https://x)'), 'quoted bold and code and a link');
  assert.equal(ago(NOW - 30_000, NOW), 'just now');
  assert.equal(ago(NOW - 5 * 60_000, NOW), '5 minutes ago');
  assert.equal(ago(NOW - 26 * 3_600_000, NOW), 'yesterday');
});

void test('fork runs held for a maintainer: their own blocker, not a failure to rerun (#595)', () => {
  const fork = member({ headRepo: 'sam/r', baseRepo: 'o/r' });
  const held = signals({ checks: { state: 'failure', passed: 2, failed: 2, awaitingApproval: 2, total: 4 } }, { mergeState: 'BLOCKED' });
  assert.deepEqual(mergeBlockers(fork, held, 'me').map((b) => [b.action, b.cause, b.owner]), [
    [{ kind: 'approve-workflows', count: 2 }, '2 workflow runs from a fork wait for a maintainer’s approval', 'maintainer'],
  ], 'Held runs only: no "checks failing" and no Rerun');
  const mixed = signals({ checks: { state: 'failure', passed: 1, failed: 3, awaitingApproval: 1, total: 4 } });
  assert.deepEqual(mergeBlockers(fork, mixed, 'me').map((b) => [b.action.kind, b.cause]), [
    ['approve-workflows', '1 workflow run from a fork waits for a maintainer’s approval'],
    ['rerun-failed', '2 of 4 checks failing'],
  ]);
  // In the same repository, ACTION_REQUIRED means something else: it stays a failure.
  const same = member({ headRepo: 'o/r', baseRepo: 'o/r' });
  assert.deepEqual(mergeBlockers(same, held, 'me').map((b) => b.cause), ['2 of 4 checks failing']);
  assert.equal(heldForkRuns(member({ headRepoUnknown: true, baseRepo: 'o/r' }), held), 2, 'A deleted fork is still a fork');
  assert.equal(heldForkRuns(member(), held), 0, 'No repositories to compare: Gnosis cannot tell, so no blocker');
  assert.equal(heldForkRuns(fork, signals({ checks: { state: 'failure', passed: 2, failed: 2, total: 4 } })), 0, 'A read from before the count: none claimed');
  const digest = stepDigest({ step: { kind: 'review', member: fork }, signals: held, login: 'me', now: NOW, since: [] });
  assert.deepEqual(digest.lines.slice(1).map((line) => [line.tone, line.text]), [['attention', '2 workflow runs wait for a maintainer’s approval']]);
});

void test('depth: risky paths and authors new to the repository get a deep review', () => {
  assert.equal(riskyPath('.github/workflows/ci.yml'), 'a CI workflow');
  assert.equal(riskyPath('db/migrations/0042_add_index.sql'), 'a database migration');
  assert.equal(riskyPath('src/auth/session.ts'), 'security-sensitive code');
  assert.equal(riskyPath('lib/oauth-client.ts'), 'security-sensitive code');
  assert.equal(riskyPath('infra/main.tf'), 'infrastructure');
  assert.equal(riskyPath('docker/Dockerfile.ci'), 'a container build');
  assert.equal(riskyPath('.github/CODEOWNERS'), 'code owners');
  for (const path of ['lib/author.ts', 'src/tokenizer.ts', 'docs/safety-notes.md', 'components/Button.tsx'])
    assert.equal(riskyPath(path), undefined, path);
  // A small update that would be a summary is a deep review when it touches a risky path.
  assert.deepEqual(suggestDepth(step('rereview'), 14, { paths: ['README.md', '.github/workflows/release.yml'] }), {
    depth: 'deep',
    reason: 'Touches a CI workflow (.github/workflows/release.yml).',
  });
  assert.deepEqual(suggestDepth(step('rereview'), 14, { authorAssociation: 'FIRST_TIME_CONTRIBUTOR' }), {
    depth: 'deep',
    reason: "sam's first PR in this repository.",
  });
  assert.match(suggestDepth(step('review'), undefined, { authorAssociation: 'FIRST_TIMER' }).reason, /^sam's first PR on GitHub/);
  assert.match(suggestDepth(step('review'), undefined, { authorAssociation: 'NONE' }).reason, /^sam has no merged commits here yet/);
  assert.equal(suggestDepth(step('rereview'), 14, { paths: ['README.md'], authorAssociation: 'MEMBER' }).depth, 'summary', 'Nothing risky, a known author');
  assert.equal(suggestDepth(step('rereview'), 14, {}).depth, 'summary', 'Unknown paths and author: no rule fires');
  // The rules are about reading someone else's code: your own PR and a merge keep their depth.
  assert.equal(suggestDepth(step('fix'), undefined, { paths: ['.github/workflows/ci.yml'] }).depth, 'summary');
  assert.equal(suggestDepth(step('merge'), undefined, { authorAssociation: 'FIRST_TIMER' }).depth, 'summary');
});

void test('parked steps: a rerun waits for its checks, an update for its new head, and both give up after a while', () => {
  const at = NOW;
  const rerun: Park = { action: 'rerun-failed', headSha: 'h', at };
  const red = signals({ checks: { state: 'failure', passed: 3, failed: 1, total: 4 } });
  const running = signals({ checks: { state: 'pending', passed: 3, running: 1, total: 4 } });
  const green = signals();
  assert.deepEqual(settlePark(rerun, 'h', red, at + 1000), { park: rerun }, 'The red read before any running is the old red');
  assert.deepEqual(settlePark(rerun, 'h', undefined, at + 1000), { park: rerun }, 'Not read: still waiting');
  const seen = settlePark(rerun, 'h', running, at + 1000);
  assert.deepEqual(seen, { park: { ...rerun, running: true } });
  assert.deepEqual(settlePark({ ...rerun, running: true }, 'h', red, at + 2000), { result: { outcome: 'open', tone: 'danger', text: 'Still 1 of 4 checks failing after the rerun.' } });
  assert.deepEqual(settlePark(rerun, 'h', green, at + 2000), { result: { outcome: 'done', tone: 'success', text: 'Checks pass after the rerun.' } });
  assert.equal((settlePark(rerun, 'h2', green, at + 2000) as { result: { outcome: string } }).result.outcome, 'open', 'New commits: back to you');
  assert.deepEqual(settlePark(rerun, 'h', red, at + PARK_LIMIT + 1), { result: { outcome: 'open', tone: 'attention', text: 'No result from the rerun after 30 minutes.' } });
  assert.deepEqual(settlePark({ ...rerun, running: true }, 'h', running, at + PARK_LIMIT + 1), { park: { ...rerun, running: true } }, 'Checks still running are waited for');

  const update: Park = { action: 'update-branch', headSha: 'h', at };
  const onNew = (over: Partial<QueueSignals>) => signals({ headSha: 'h2', ...over });
  assert.deepEqual(settlePark(update, 'h', green, at + 1000), { park: update }, 'Same head: not updated yet');
  assert.deepEqual(settlePark(update, 'h2', green, at + 1000), { park: update }, 'Status of the old head says nothing of the new one');
  assert.deepEqual(settlePark(update, 'h2', onNew({ checks: { state: 'pending', passed: 0, running: 4, total: 4 } }), at + 1000), { park: { ...update, running: true } });
  assert.deepEqual(settlePark(update, 'h2', onNew({}), at + 1000), { result: { outcome: 'done', tone: 'success', text: 'Branch updated; checks pass.' } });
  assert.deepEqual(settlePark(update, 'h2', onNew({ checks: { state: 'failure', passed: 2, failed: 2, total: 4 } }), at + 1000), { result: { outcome: 'open', tone: 'danger', text: 'Branch updated; 2 of 4 checks failing.' } });
  assert.equal((settlePark(update, 'h', green, at + PARK_LIMIT + 1) as { result: { tone: string } }).result.tone, 'attention');

  const steps = [1, 2].map((n) => ({ id: `s${n}`, member: member({ number: n, title: `PR ${n}` }) }));
  const summary = runSummary(steps, { s1: 'parked', s2: 'done' });
  assert.equal(summary.waiting, 1);
  assert.deepEqual(summary.lines.map((line) => line.text), ['Still waiting: #1 PR 1', 'Moved: #2 PR 2']);
});

void test('steps: Next up, then the quick wins it had no room for, then the decisions, each PR once', () => {
  const item = (n: number, kind: NextItem['kind'], over: Partial<NextItem> = {}) =>
    ({ id: `next|${kind}|${n}`, kind, row: { item: { subject: { id: `s${n}` } } }, member: member({ number: n, url: `u${n}` }), title: `PR ${n}`, why: '', urls: [`u${n}`], check: {}, since: 0, ...over }) as unknown as NextItem;
  const decision = (n: number) => ({ id: `decide|${n}`, row: {}, member: member({ number: n, url: `u${n}` }), label: 'No activity', check: {} }) as unknown as DecisionItem;
  const steps = sessionSteps({ next: { items: [item(1, 'review'), item(2, 'reply')], overflow: [item(3, 'merge'), item(1, 'merge')] }, decide: [decision(4), decision(2)] });
  assert.deepEqual(steps.map((step) => [step.source, step.member.number]), [['next', 1], ['next', 2], ['more', 3], ['decide', 4]], 'A PR an earlier step lists is left out');
  assert.equal(steps[0].id, stepId('next|review|1', { number: 1 }));
  assert.equal(steps[0].id, 'next|review|1|#1', 'A step is its item and its PR: a stack whose base merged is a new step');
  assert.equal(runScope(steps), '2 + 1 quick + 1 decision');
  assert.equal(runScope(steps.slice(0, 2)), '2', 'Only Next up: just its count');
  // A long backlog: the run takes the first DECIDE_IN_RUN decisions and says how many there are.
  const many = sessionSteps({ next: { items: [item(1, 'review')] }, decide: Array.from({ length: 110 }, (_, n) => decision(100 + n)) });
  assert.equal(many.filter((step) => step.source === 'decide').length, 10);
  assert.equal(runScope(many, 110), '1 + 10 of 110 decisions');
});

void test('facts: checks always, the wait, reviewers, files; what is not read says so', () => {
  const pr = member({ author: 'maya', headSha: 'h', requestedReviewers: ['owen', 'me'] });
  const read = signals({ opinions: [
    { url: 'r1', author: 'lena', state: 'APPROVED', submittedAt: '2026-11-26T10:00:00Z', headSha: 'h' },
    { url: 'r2', author: 'sam', state: 'CHANGES_REQUESTED', submittedAt: '2026-11-26T11:00:00Z', headSha: 'h' },
  ] });
  const facts = stepFacts({ member: pr, signals: read, since: NOW - 3 * 86_400_000, now: NOW, login: 'me', paths: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] });
  assert.deepEqual(facts.slice(0, 3).map((fact) => [fact.key, fact.text]), [
    ['checks', 'Checks 4 passed'],
    ['waited', 'Waiting 3 days'],
    ['reviews', 'lena approved, sam requested changes, owen requested +1'],
  ]);
  assert.equal(facts[2].title, 'lena approved, sam requested changes, owen requested, your review requested');
  assert.deepEqual(facts.slice(3).map((fact) => [fact.key, fact.text]), [
    ['files', 'a.ts, b.ts, c.ts +1 more'],
  ]);
  const failing = stepFacts({ member: pr, signals: signals({ checks: { state: 'failure', passed: 9, failed: 2, running: 1, total: 12 } }), since: undefined, now: NOW, login: 'me' });
  assert.deepEqual(failing[0], { key: 'checks', text: 'Checks 9 passed, 2 failed, 1 running', tone: 'danger' });
  assert.equal(failing.some((fact) => fact.key === 'files'), false, 'Files not loaded: no files fact, no guess');
  const unread = stepFacts({ member: pr, signals: undefined, since: undefined, now: NOW, login: 'me' });
  assert.deepEqual(unread.map((fact) => [fact.text, fact.unknown]), [['Checks not read yet', true], ['Reviews not read yet', true]]);
  const older = stepFacts({ member: member({ headSha: 'new' }), signals: signals(), since: undefined, now: NOW, login: 'me' });
  assert.equal(older[0].text, 'Checks not read yet', 'Checks read for an older commit do not count');
  assert.equal(stepFacts({ member: pr, signals: signals({ checks: { state: 'success', passed: 0, failed: 0, total: 0 } }), since: undefined, now: NOW, login: 'me' })[0].text, 'No checks');
  assert.equal(span(90 * 60_000), '2 hours');
});

void test('a stale decision shows its evidence and whom to remind', () => {
  const updatedAt = new Date(NOW - 8 * 86_400_000).toISOString();
  assert.deepEqual(decideEvidence({ updatedAt, requestedReviewers: ['lena'] }, 'unapproved', NOW), { lines: ['Last activity 8 days ago', 'Waiting on lena to review'], remind: 'lena' });
  assert.deepEqual(decideEvidence({ updatedAt, requestedReviewers: [] }, 'failing', NOW), { lines: ['Last activity 8 days ago', 'Waiting on you: its checks fail'] });
  assert.deepEqual(decideEvidence({ updatedAt, requestedReviewers: [] }, 'idle', NOW).lines[1], 'No reviewer requested');
});

void test('moved means changed on GitHub: an opened PR is counted apart; the depth line only where reading is the choice', () => {
  const steps = [1, 2, 3].map((n) => ({ id: `s${n}`, member: member({ number: n, title: `PR ${n}` }) }));
  const summary = runSummary(steps, { s1: 'done', s2: 'opened' });
  assert.equal(summary.done, 1);
  assert.equal(summary.opened, 1);
  assert.deepEqual(summary.groups.map((group) => group.label), ['Moved', 'Opened', 'Still on your list']);
  assert.deepEqual((['review', 'rereview', 'reply', 'merge', 'decide', 'fix', 'changes'] as const).filter(showsDepth), ['review', 'rereview']);
});
