import { isAutomationActor, sameLogin } from './github-actors';
import type { OptimisticChange } from './optimistic-patches';
import type { PrLabel, PrMetadata } from './types';

/**
 * Editing a PR's reviewers, assignees, labels and milestone. Shared by main's write service
 * (src/pr-metadata-write-service.ts), main's optimistic layer (lib/optimistic-patches.ts) and the editors in the
 * Summary details column (components/PrPeopleEditor.tsx), so all three apply and recognize an edit the same way.
 */
export type PrPeopleField = 'reviewers' | 'assignees' | 'labels' | 'milestone';

export interface PrPersonCandidate {
  login: string;
  name?: string;
  avatarUrl?: string;
}
export interface PrTeamCandidate {
  /** What the API takes, such as `core-reviewers`. */
  slug: string;
  /** What GitHub shows and the PR's `requestedTeams` hold, such as `Core reviewers`. */
  name: string;
}
export interface PrMilestoneCandidate {
  number: number;
  title: string;
  dueOn: string | null;
}

/** Who may change the PR's people and labels, and what the editors need that the PR copy lacks. */
export interface PrPeopleAccess {
  url: string;
  /** GitHub's `viewerPermission`: ADMIN, MAINTAIN, WRITE, TRIAGE or READ. */
  permission: string | null;
  canEdit: boolean;
  /** Why the reader cannot edit, in their words. */
  reason?: string;
  /** Review requests need an open PR; labels, assignees and the milestone don't. */
  canRequestReviews: boolean;
  reviewsReason?: string;
  author: string;
  viewer: string;
  /** Only an organization's repositories have teams. */
  organization: boolean;
  /** The PR's team requests with their slugs, which removing one needs. */
  requestedTeams: PrTeamCandidate[];
  milestone: PrMilestoneCandidate | null;
  checkedAt: number;
}

/** One page of candidates for a field, for an empty or a typed query. */
export interface PrPeopleCandidates {
  field: PrPeopleField;
  query: string;
  users: PrPersonCandidate[];
  teams: PrTeamCandidate[];
  labels: PrLabel[];
  milestones: PrMilestoneCandidate[];
  /** Who GitHub suggests as reviewers. Read with the reviewer candidates only. */
  suggested: PrPersonCandidate[];
  /** Every match is here: narrowing the query filters this list without another request. */
  complete: boolean;
  /** Teams could not be read, such as without the `read:org` scope. People still can. */
  teamsUnavailable?: boolean;
}
export interface PrPeopleCandidateRequest {
  url: string;
  field: PrPeopleField;
  query?: string;
}

export type PrPeopleEdit =
  | {
      url: string;
      field: 'reviewers';
      add: string[];
      remove: string[];
      addTeams: PrTeamCandidate[];
      removeTeams: PrTeamCandidate[];
    }
  | { url: string; field: 'assignees'; add: string[]; remove: string[] }
  | { url: string; field: 'labels'; add: PrLabel[]; remove: string[] }
  | { url: string; field: 'milestone'; milestone: PrMilestoneCandidate | null };

/**
 * What an edit did when GitHub took only part of it: the part to keep showing, the part that did not happen, which a
 * Retry sends, and GitHub's reason.
 */
export type PrPeopleEditResult =
  | { status: 'done' }
  | { status: 'partial'; applied: PrPeopleEdit; remaining: PrPeopleEdit; error: string };

/** Roles that may label, assign and request reviews. */
const EDITORS = ['TRIAGE', 'WRITE', 'MAINTAIN', 'ADMIN'];

/**
 * The permission gate: GitHub needs triage access or more, on a repository that is not archived. Review requests also
 * need an open PR; GitHub still takes labels, assignees and a milestone on a closed or merged one.
 */
export function prPeopleGate(input: { permission: string | null; archived: boolean; repo: string; open: boolean }): {
  canEdit: boolean;
  reason?: string;
  canRequestReviews: boolean;
  reviewsReason?: string;
} {
  if (input.archived) {
    const reason = `${input.repo} is archived. Its PRs can’t be changed.`;
    return { canEdit: false, reason, canRequestReviews: false, reviewsReason: reason };
  }
  if (!EDITORS.includes(input.permission ?? '')) {
    const reason = `You need triage or write access to ${input.repo} to change reviewers, assignees, labels or the milestone.`;
    return { canEdit: false, reason, canRequestReviews: false, reviewsReason: reason };
  }
  if (!input.open) return { canEdit: true, canRequestReviews: false, reviewsReason: 'Reviews can only be requested on an open PR.' };
  return { canEdit: true, canRequestReviews: true };
}
/** The reason a field can't be edited, or undefined when it can. */
export function fieldBlockedReason(access: PrPeopleAccess, field: PrPeopleField): string | undefined {
  if (!access.canEdit) return access.reason ?? 'Your account can’t change this PR.';
  if (field === 'reviewers' && !access.canRequestReviews) return access.reviewsReason;
  return undefined;
}

/** GitHub's own rule: never a review request from the PR's author or from a bot. */
export function canBeRequested(login: string, author: string, typename?: string): boolean {
  return !sameLogin(login, author) && !isAutomationActor({ login, __typename: typename });
}

const has = (list: readonly string[], value: string) => list.some((item) => sameLogin(item, value));

/** `base` with `add` appended and `remove` taken out, compared without case as GitHub does. */
export function editList(base: readonly string[], add: readonly string[], remove: readonly string[]): string[] {
  const kept = base.filter((item) => !has(remove, item));
  return [...kept, ...add.filter((item) => !has(kept, item))];
}
/** Whether `list` shows the edit: every added value present, every removed one gone. */
export function showsEdit(list: readonly string[], add: readonly string[], remove: readonly string[]): boolean {
  return add.every((item) => has(list, item)) && remove.every((item) => !has(list, item) || has(add, item));
}

/** The values to add and remove to turn `before` into `after`. */
export function diffSelection(before: readonly string[], after: readonly string[]) {
  return {
    add: after.filter((item) => !has(before, item)),
    remove: before.filter((item) => !has(after, item)),
  };
}

// GitHub logins: letters, digits and hyphens; Enterprise Managed Users add `_shortcode`.
const LOGIN = /^[a-z\d](?:[a-z\d_-]{0,38})$/i;
const TEAM = /^[a-z\d][\w.-]{0,99}$/i;
export const isLogin = (value: unknown): value is string => typeof value === 'string' && LOGIN.test(value);
/** Anyone currently requested or assigned can be taken off, bots (`name[bot]`) included, though bots can't be added. */
export const isRemovableLogin = (value: unknown): value is string =>
  typeof value === 'string' && (LOGIN.test(value) || LOGIN.test(value.replace(/\[bot\]$/i, '')));
export const isTeamSlug = (value: unknown): value is string => typeof value === 'string' && TEAM.test(value);
export const isLabelName = (value: unknown): value is string =>
  typeof value === 'string' && !!value.trim() && value.length <= 100;

/** Whether an edit changes anything. */
export function editIsEmpty(edit: PrPeopleEdit): boolean {
  switch (edit.field) {
    case 'reviewers':
      return !edit.add.length && !edit.remove.length && !edit.addTeams.length && !edit.removeTeams.length;
    case 'assignees':
    case 'labels':
      return !edit.add.length && !edit.remove.length;
    case 'milestone':
      return false;
  }
}

/** The change main's optimistic layer and the renderer show for an edit. Teams by name, as PR copies hold them. */
export type PeopleChange = Extract<
  OptimisticChange,
  { action: 'edit-reviewers' | 'edit-assignees' | 'edit-labels' | 'edit-milestone' }
>;
export function prPeopleChange(edit: PrPeopleEdit): PeopleChange {
  switch (edit.field) {
    case 'reviewers':
      return {
        action: 'edit-reviewers',
        add: edit.add,
        remove: edit.remove,
        addTeams: edit.addTeams.map((team) => team.name),
        removeTeams: edit.removeTeams.map((team) => team.name),
      };
    case 'assignees':
      return { action: 'edit-assignees', add: edit.add, remove: edit.remove };
    case 'labels':
      return { action: 'edit-labels', add: edit.add, remove: edit.remove };
    case 'milestone':
      return {
        action: 'edit-milestone',
        milestone: edit.milestone && { title: edit.milestone.title, dueOn: edit.milestone.dueOn },
      };
  }
}
export const isPeopleChange = (change: OptimisticChange): change is PeopleChange =>
  change.action === 'edit-reviewers' ||
  change.action === 'edit-assignees' ||
  change.action === 'edit-labels' ||
  change.action === 'edit-milestone';

/** The PR fields an edit touches. */
export type PeopleFields = Pick<PrMetadata, 'requestedReviewers' | 'requestedTeams' | 'labels' | 'milestone'> & {
  assignees?: string[];
  labelDetails?: PrLabel[];
};
/** The fields with a change applied. Applying one the copy already shows changes nothing. */
export function applyPeopleChange<T extends PeopleFields>(base: T, change: PeopleChange): T {
  switch (change.action) {
    case 'edit-reviewers':
      return {
        ...base,
        requestedReviewers: editList(base.requestedReviewers, change.add, change.remove),
        requestedTeams: editList(base.requestedTeams, change.addTeams, change.removeTeams),
      };
    case 'edit-assignees':
      return { ...base, assignees: editList(base.assignees ?? [], change.add, change.remove) };
    case 'edit-labels': {
      const labels = editList(base.labels, change.add.map((label) => label.name), change.remove);
      // The chips keep their colors: GitHub's details for labels it showed, the picked label's for new ones.
      const known = [...(base.labelDetails ?? []), ...change.add];
      const labelDetails = labels.flatMap((name) => known.find((label) => sameLogin(label.name, name)) ?? []);
      return { ...base, labels, labelDetails };
    }
    case 'edit-milestone':
      return { ...base, milestone: change.milestone };
  }
}

/**
 * The people and labels a PR's details show: the status read's reviewers and milestone when there is one, the queue
 * copy's otherwise. A status read reports no milestone as null, which means none, not unknown.
 */
export function prPeopleView(
  member: PeopleFields & { assignees?: string[]; labelDetails?: PrLabel[] },
  status?: Pick<PrMetadata, 'requestedReviewers' | 'requestedTeams' | 'milestone'>
) {
  const meta = status ?? member;
  return {
    requestedReviewers: meta.requestedReviewers,
    requestedTeams: meta.requestedTeams,
    assignees: member.assignees ?? [],
    labels: member.labels,
    labelDetails: member.labelDetails ?? [],
    milestone: status ? status.milestone : member.milestone,
  };
}

/** What a fresh PR read must show for the edit to be visible. Compared without case. */
export interface PrMetadataExpectation {
  requestedReviewers?: { add: string[]; remove: string[] };
  requestedTeams?: { add: string[]; remove: string[] };
  assignees?: { add: string[]; remove: string[] };
  labels?: { add: string[]; remove: string[] };
  /** The milestone title, or null for none. */
  milestone?: string | null;
}
export function peopleExpectation(change: PeopleChange): PrMetadataExpectation {
  switch (change.action) {
    case 'edit-reviewers':
      return {
        requestedReviewers: { add: change.add, remove: change.remove },
        requestedTeams: { add: change.addTeams, remove: change.removeTeams },
      };
    case 'edit-assignees':
      return { assignees: { add: change.add, remove: change.remove } };
    case 'edit-labels':
      return { labels: { add: change.add.map((label) => label.name), remove: change.remove } };
    case 'edit-milestone':
      return { milestone: change.milestone?.title ?? null };
  }
}
export const expectationOf = (edit: PrPeopleEdit) => peopleExpectation(prPeopleChange(edit));
export function metadataShows(
  metadata: Partial<Pick<PrMetadata, 'requestedReviewers' | 'requestedTeams' | 'assignees' | 'labels' | 'milestone'>>,
  expected: PrMetadataExpectation
): boolean {
  const lists = ['requestedReviewers', 'requestedTeams', 'assignees', 'labels'] as const;
  for (const key of lists) {
    const want = expected[key];
    if (want && !showsEdit(metadata[key] ?? [], want.add, want.remove)) return false;
  }
  if (expected.milestone !== undefined && (metadata.milestone?.title ?? null) !== expected.milestone) return false;
  return true;
}

/**
 * An older pending or confirmed change with whatever a newer change on the same field decides taken out: adding a
 * label and then removing it leaves only the removal. Returns undefined when nothing of the older change is left.
 */
export function withoutSuperseded(older: PeopleChange, newer: PeopleChange): PeopleChange | undefined {
  if (older.action !== newer.action) return older;
  const minus = (list: string[], ...taken: string[][]) => list.filter((item) => !taken.some((t) => has(t, item)));
  switch (older.action) {
    case 'edit-milestone':
      return undefined;
    case 'edit-reviewers': {
      const n = newer as typeof older;
      const users = [...n.add, ...n.remove];
      const teams = [...n.addTeams, ...n.removeTeams];
      const next = {
        ...older,
        add: minus(older.add, users),
        remove: minus(older.remove, users),
        addTeams: minus(older.addTeams, teams),
        removeTeams: minus(older.removeTeams, teams),
      };
      return next.add.length || next.remove.length || next.addTeams.length || next.removeTeams.length ? next : undefined;
    }
    case 'edit-assignees': {
      const n = newer as typeof older;
      const next = { ...older, add: minus(older.add, n.add, n.remove), remove: minus(older.remove, n.add, n.remove) };
      return next.add.length || next.remove.length ? next : undefined;
    }
    case 'edit-labels': {
      const n = newer as typeof older;
      const names = [...n.add.map((label) => label.name), ...n.remove];
      const next = {
        ...older,
        add: older.add.filter((label) => !has(names, label.name)),
        remove: minus(older.remove, names),
      };
      return next.add.length || next.remove.length ? next : undefined;
    }
  }
}

/** Candidates matching a typed query: login, name, or slug, without case. */
export function matchesQuery(query: string, ...values: (string | undefined)[]) {
  const needle = query.trim().toLowerCase();
  return !needle || values.some((value) => value?.toLowerCase().includes(needle));
}

/** A milestone due date. GitHub stores the day at midnight UTC: show that day, not the evening before. */
export function formatDueOn(dueOn: string): string {
  const day = dueOnDay(dueOn);
  return day ? day.toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' }) : 'Unknown';
}
/**
 * The calendar day a milestone is due. GitHub keeps a date only, as a timestamp at midnight somewhere: current
 * milestones read `T00:00:00Z`, older ones local midnight, such as `T05:00:00Z` (US Eastern) or `T07:00:00Z` and
 * `T08:00:00Z` (US Pacific), checked against public repositories. Midnight west of UTC lands before noon UTC on the
 * same day; midnight east of UTC lands in the afternoon of the day before. So the day is the UTC day twelve hours on.
 * Shown in UTC, it is the same day in every time zone.
 */
export function dueOnDay(dueOn: string): Date | undefined {
  const at = Date.parse(dueOn);
  if (Number.isNaN(at)) return undefined;
  const shifted = new Date(at + 12 * 60 * 60_000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}
