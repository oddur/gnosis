import type { PrLabel, PrMetadata } from './types';

/**
 * Editing a PR's reviewers, assignees, labels and milestone (#pr-people-labels). Shared by main's write service
 * (src/pr-metadata-write-service.ts) and the editors in the Summary details column (components/PrPeopleEditor.tsx).
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
  author: string;
  viewer: string;
  /** Only an organization's repositories have teams. */
  organization: boolean;
  /** The PR's team requests with their slugs, which removing one needs. */
  requestedTeams: PrTeamCandidate[];
  suggestedReviewers: PrPersonCandidate[];
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

/** Roles that may label, assign and request reviews. */
const EDITORS = ['TRIAGE', 'WRITE', 'MAINTAIN', 'ADMIN'];

/** The permission gate: GitHub needs triage access or more, on a repository that is not archived. */
export function prPeopleGate(input: { permission: string | null; archived: boolean; repo: string }): {
  canEdit: boolean;
  reason?: string;
} {
  if (input.archived) return { canEdit: false, reason: `${input.repo} is archived. Its PRs can’t be changed.` };
  if (!EDITORS.includes(input.permission ?? ''))
    return {
      canEdit: false,
      reason: `You need triage or write access to ${input.repo} to change reviewers, assignees, labels or the milestone.`,
    };
  return { canEdit: true };
}

export const same = (a: string | undefined | null, b: string | undefined | null) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();
const has = (list: readonly string[], value: string) => list.some((item) => same(item, value));

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

const LOGIN = /^[a-z\d](?:[a-z\d-]{0,38})$/i;
const TEAM = /^[a-z\d][\w.-]{0,99}$/i;
export const isLogin = (value: unknown): value is string => typeof value === 'string' && LOGIN.test(value);
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

/** What a fresh PR read must show for the edit to be visible. Compared without case. */
export interface PrMetadataExpectation {
  requestedReviewers?: { add: string[]; remove: string[] };
  requestedTeams?: { add: string[]; remove: string[] };
  assignees?: { add: string[]; remove: string[] };
  labels?: { add: string[]; remove: string[] };
  /** The milestone title, or null for none. */
  milestone?: string | null;
}
export function expectationOf(edit: PrPeopleEdit): PrMetadataExpectation {
  switch (edit.field) {
    case 'reviewers':
      return {
        requestedReviewers: { add: edit.add, remove: edit.remove },
        requestedTeams: { add: edit.addTeams.map((team) => team.name), remove: edit.removeTeams.map((team) => team.name) },
      };
    case 'assignees':
      return { assignees: { add: edit.add, remove: edit.remove } };
    case 'labels':
      return { labels: { add: edit.add.map((label) => label.name), remove: edit.remove } };
    case 'milestone':
      return { milestone: edit.milestone?.title ?? null };
  }
}
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

/** Candidates matching a typed query: login, name, or slug, without case. */
export function matchesQuery(query: string, ...values: (string | undefined)[]) {
  const needle = query.trim().toLowerCase();
  return !needle || values.some((value) => value?.toLowerCase().includes(needle));
}
