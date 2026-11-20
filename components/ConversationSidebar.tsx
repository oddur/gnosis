import { CircleAlert, CircleCheck, Clock3, MessageSquare, Milestone, MinusCircle, Tag, UserRound, Users, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { BranchBadge, CommitBadge, RepositoryBadge } from './EntityBadge';
import { GitHubAuthor } from './GitHubAuthor';
import { PrLabels } from './PrLabels';
import { Button } from './ui/button';
import { checkSummary, type PrChecks } from '../lib/pr-checks';
import type { GitHubReviewThreads } from '../lib/review-threads';
import type { PrStatus } from '../lib/types';
import type { ReviewMember } from '../lib/workbench';
import type { ReactNode } from 'react';
import { PrPeopleAccessError, PrPeopleEditor, PrPeopleFailure, ReRequestFailure, ReRequestReview, usePrPeople } from './PrPeopleEditor';
import { editList, formatDueOn, type PrPeopleField } from '../lib/pr-people';
import { useCommandScope } from '../lib/command-center';

type Verdict = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
const VERDICTS: Record<Verdict, { icon: LucideIcon; label: string; tone: string }> = {
  APPROVED: { icon: CircleCheck, label: 'Approved', tone: 'success' },
  CHANGES_REQUESTED: { icon: CircleAlert, label: 'Changes requested', tone: 'danger' },
  COMMENTED: { icon: MessageSquare, label: 'Commented', tone: 'neutral' },
  DISMISSED: { icon: MinusCircle, label: 'Dismissed', tone: 'neutral' },
  PENDING: { icon: Clock3, label: 'Review requested', tone: 'review' },
};

/**
 * Each reviewer's current verdict, as GitHub decides it: the latest approval, change request or dismissal wins over
 * later comments; a reviewer still requested and without a decision is pending.
 */
export function reviewerVerdicts(snapshot: Pick<GitHubReviewThreads, 'feedback'> | undefined, requested: readonly string[]) {
  const verdicts = new Map<string, Verdict>();
  const reviews = [...(snapshot?.feedback?.reviews ?? [])]
    .filter((review) => review.author && review.state !== 'PENDING')
    .sort((a, b) => (a.submittedAt ?? a.createdAt).localeCompare(b.submittedAt ?? b.createdAt));
  for (const review of reviews) {
    const login = review.author?.login ?? '';
    const current = verdicts.get(login);
    if (review.state === 'COMMENTED' && current && current !== 'COMMENTED') continue;
    verdicts.set(login, review.state as Verdict);
  }
  for (const login of [...requested, ...(snapshot?.feedback?.requestedReviewers ?? [])])
    if (!verdicts.has(login) || verdicts.get(login) === 'COMMENTED') verdicts.set(login, 'PENDING');
  return [...verdicts.entries()].map(([login, verdict]) => ({ login, verdict }));
}

const date = (value: string) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'Unknown' : parsed.toLocaleDateString(undefined, { dateStyle: 'medium' });
};

/**
 * The Conversation page's side column (#418): who reviews and how they decided, checks, and the PR's facts. It stays
 * in view beside the timeline; below about 1100px it becomes a compact strip above it.
 */
export function ConversationSidebar({
  member: m,
  status,
  snapshot,
  checks,
  onChecks,
  context,
  evidence,
}: {
  /** Review evidence: check failures and what they block, with About these results. */
  evidence?: ReactNode;
  /** A stack member's place in its stack, above its own details. */
  context?: ReactNode;
  member: ReviewMember;
  status?: PrStatus;
  snapshot?: GitHubReviewThreads;
  checks?: PrChecks;
  onChecks: () => void;
}) {
  const meta = status ?? m;
  // Reviewers, assignees, labels and the milestone, with the reader's edits in flight (components/PrPeopleEditor.tsx).
  const people = usePrPeople(m, status);
  const { view } = people;
  const [editing, setEditing] = useState<PrPeopleField | null>(null);
  const editor = (field: PrPeopleField, reviewed?: { login: string; verdict: string; typename?: string }[]) => (
    <PrPeopleEditor
      field={field}
      member={m}
      people={people}
      reviewed={reviewed}
      open={editing === field}
      onOpenChange={(open) => setEditing((current) => (open ? field : current === field ? null : current))}
    />
  );
  // The discussion's copy of the review requests, with the same edits applied.
  const requestedInDiscussion = people.pending.reduce(
    (list, edit) => (edit.field === 'reviewers' ? editList(list, edit.add, edit.remove) : list),
    snapshot?.feedback?.requestedReviewers ?? []
  );
  const shown = snapshot?.feedback ? { feedback: { ...snapshot.feedback, requestedReviewers: requestedInDiscussion } } : snapshot;
  // Who reviewed, with GitHub's account type, so a bot is never offered a review request.
  const typenames = new Map((snapshot?.feedback?.reviews ?? []).flatMap((review) => (review.author ? [[review.author.login.toLowerCase(), review.author.__typename]] : [])));
  const reviewers = reviewerVerdicts(shown, view.requestedReviewers).map((reviewer) => ({ ...reviewer, typename: typenames.get(reviewer.login.toLowerCase()) }));
  const requested = new Set([...view.requestedReviewers, ...requestedInDiscussion].map((login) => login.toLowerCase()));
  const canEdit = !!people.access?.canEdit;
  const command = (field: PrPeopleField, label: string, icon: LucideIcon, keywords: string) => ({
    id: `pr-people:${field}`,
    icon,
    label,
    keywords,
    group: `PR #${m.number}`,
    // The picker takes focus: it opens once the palette has closed and handed focus back.
    afterClose: true,
    perform: () => setEditing(field),
  });
  useCommandScope(
    'pr-people',
    canEdit
      ? [
          command('reviewers', 'Request reviewers…', Users, 'reviewer review request re-request team people'),
          command('assignees', 'Edit assignees…', UserRound, 'assignee assign people'),
          command('labels', 'Edit labels…', Tag, 'label tag'),
          command('milestone', 'Set milestone…', Milestone, 'milestone release'),
        ]
      : []
  );
  return (
    <aside className="conversation-sidebar pr-metadata" aria-label={`Details for PR #${m.number}`}>
      {context}
      <section className="pr-people-section" data-field="reviewers">
        <div className="pr-people-heading">
          <h2>Reviewers</h2>
          {editor('reviewers', reviewers)}
        </div>
        <PrPeopleAccessError people={people} />
        {reviewers.length || view.requestedTeams.length ? (
          <ul className="conversation-reviewers">
            {reviewers.map(({ login, verdict, typename }) => {
              // An earlier reviewer asked again: GitHub shows the request; the earlier verdict stays in the title.
              const again = verdict !== 'PENDING' && requested.has(login.toLowerCase());
              const { icon: Icon, label, tone } = again ? VERDICTS.PENDING : VERDICTS[verdict];
              return (
                <li key={login}>
                  <GitHubAuthor login={login} />
                  <span className="conversation-reviewer-state">
                    <span
                      className="conversation-verdict"
                      data-tone={tone}
                      title={again ? `${VERDICTS[verdict].label} earlier` : undefined}
                    >
                      <Icon size={13} aria-hidden="true" />
                      {again ? 'Requested again' : label}
                    </span>
                    {verdict !== 'PENDING' && !again && (
                      <ReRequestReview member={m} login={login} typename={typename} people={people} feedback={snapshot?.feedback} />
                    )}
                  </span>
                </li>
              );
            })}
            {view.requestedTeams.map((team) => (
              <li key={team}>
                <span className="pr-people-team" title={`Team ${team}`}>
                  <Users size={13} aria-hidden="true" />
                  <span>{team}</span>
                  <span className="sr-only">(team)</span>
                </span>
                <span className="conversation-verdict" data-tone="review">
                  <Clock3 size={13} aria-hidden="true" />
                  Review requested
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="conversation-empty-value">No reviewers yet</p>
        )}
        <PrPeopleFailure url={m.url} field="reviewers" />
        {reviewers.map(({ login }) => (
          <ReRequestFailure key={login} url={m.url} login={login} />
        ))}
      </section>
      <section className="pr-people-section" data-field="assignees">
        <div className="pr-people-heading">
          <h2>Assignees</h2>
          {editor('assignees')}
        </div>
        {view.assignees.length ? (
          <span className="entity-badge-group">
            {view.assignees.map((login) => (
              <GitHubAuthor key={login} login={login} />
            ))}
          </span>
        ) : (
          <p className="conversation-empty-value">Unassigned</p>
        )}
        <PrPeopleFailure url={m.url} field="assignees" />
      </section>
      <section className="pr-people-section" data-field="labels">
        <div className="pr-people-heading">
          <h2>Labels</h2>
          {editor('labels')}
        </div>
        {view.labels.length ? (
          <PrLabels members={[{ labels: view.labels, labelDetails: view.labelDetails, repo: m.repo, number: m.number }]} />
        ) : (
          <p className="conversation-empty-value">None</p>
        )}
        <PrPeopleFailure url={m.url} field="labels" />
      </section>
      {(view.milestone || canEdit) && (
        <section className="pr-people-section" data-field="milestone">
          <div className="pr-people-heading">
            <h2>Milestone</h2>
            {editor('milestone')}
          </div>
          {view.milestone ? (
            <p className="pr-people-milestone">
              <Milestone size={13} aria-hidden="true" />
              <span>{view.milestone.title}</span>
              {view.milestone.dueOn && <span className="pr-people-due">Due {formatDueOn(view.milestone.dueOn)}</span>}
            </p>
          ) : (
            <p className="conversation-empty-value">No milestone</p>
          )}
          <PrPeopleFailure url={m.url} field="milestone" />
        </section>
      )}
      <section>
        <h2>Checks</h2>
        {evidence ?? <p>{checks ? checkSummary(checks.checks) : 'Checks not loaded'}</p>}
        <Button variant="link" size="sm" onClick={onChecks}>
          Open Checks
        </Button>
      </section>
      <section>
        <h2>Details</h2>
        <dl>
          <dt>Branches</dt>
          <dd className="pr-branches">
            {m.headRepo !== m.baseRepo && <RepositoryBadge repo={m.headRepo} />}
            <BranchBadge branch={m.headBranch} repo={m.headRepo} />
            <span aria-label="into">→</span>
            <BranchBadge branch={m.baseBranch} repo={m.baseRepo} />
          </dd>
          <dt>Commits</dt>
          <dd>{meta.commitCount}</dd>
          <dt>Head</dt>
          <dd>
            <CommitBadge sha={m.headSha} repo={m.headRepo} />
          </dd>
          <dt>Created</dt>
          <dd>
            <time dateTime={m.createdAt} title={new Date(m.createdAt).toLocaleString()}>
              {date(m.createdAt)}
            </time>
          </dd>
        </dl>
      </section>
    </aside>
  );
}
