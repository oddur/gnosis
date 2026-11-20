import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Combobox as ComboboxPrimitive } from '@base-ui/react/combobox';
import { Milestone, Pencil, RefreshCw, Users } from 'lucide-react';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  findComboboxContainer,
} from './ui/combobox';
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { prLabelColors } from './PrLabels';
import { WriteFailureNotice } from './WriteFailureNotice';
import { toast } from './ui/toast';
import { optimisticWrite, reportWriteFailure, useWriteInFlight } from '../lib/write-failures';
import { githubAvatarUrl } from '../lib/github-profile';
import { sameLogin } from '../lib/github-actors';
import {
  applyPeopleChange,
  canBeRequested,
  diffSelection,
  fieldBlockedReason,
  formatDueOn,
  matchesQuery,
  prPeopleChange,
  prPeopleView,
  type PrMilestoneCandidate,
  type PrPeopleAccess,
  type PrPeopleCandidates,
  type PrPeopleEdit,
  type PrPeopleField,
  type PrPersonCandidate,
  type PrTeamCandidate,
} from '../lib/pr-people';
import type { PrLabel, PrStatus } from '../lib/types';
import type { ReviewMember } from '../lib/workbench';

/** What the details column shows for a PR's people and labels: GitHub's copy with the reader's edits in flight. */
export type PrPeopleView = ReturnType<typeof prPeopleView>;
/** The view with an edit applied, exactly as main's optimistic layer applies it (lib/pr-people.ts). */
export const withPeopleEdit = (view: PrPeopleView, edit: PrPeopleEdit): PrPeopleView =>
  applyPeopleChange(view, prPeopleChange(edit));

// Edits sent to main and not yet answered. Main shows them in every window through its optimistic layer; this copy
// covers the moment before its push arrives, so the column never shows the old value after the picker closes.
const inFlight = new Map<string, PrPeopleEdit[]>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const NONE: PrPeopleEdit[] = [];
export const peopleFailureKey = (url: string, field: PrPeopleField) => `pr-people:${field}:${url}`;
/** The same key as Feedback's request-review button, so the two never send one request twice. */
export const reRequestKey = (url: string, login: string) => `request-review:${url}:${login.toLowerCase()}`;
const PARTIAL_TITLE: Record<PrPeopleField, string> = {
  reviewers: 'Some reviewer changes weren’t made.',
  assignees: 'Some assignee changes weren’t made.',
  labels: 'Some label changes weren’t made.',
  milestone: 'Milestone wasn’t changed.',
};

/**
 * Sends one edit through the shared optimistic write path: a second send to the same target while one is in flight is
 * dropped, a refusal leaves a notice with Retry under the field (main already rolled it back), and a partial success
 * keeps what GitHub took and offers Retry for the rest only.
 */
export function sendPeopleEdit(edit: PrPeopleEdit, key = peopleFailureKey(edit.url, edit.field)): Promise<unknown> {
  return optimisticWrite({
    key,
    action: key.startsWith('request-review:') ? 'request-review' : `edit-${edit.field}`,
    write: async () => {
      inFlight.set(edit.url, [...(inFlight.get(edit.url) ?? []), edit]);
      emit();
      try {
        const result = await window.electronAPI.editPrPeople(edit);
        if (result.status === 'partial')
          reportWriteFailure({
            key,
            action: `edit-${edit.field}`,
            title: PARTIAL_TITLE[edit.field],
            error: new Error(result.error),
            retry: () => sendPeopleEdit(result.remaining, key),
          });
        return result;
      } finally {
        const rest = (inFlight.get(edit.url) ?? []).filter((item) => item !== edit);
        if (rest.length) inFlight.set(edit.url, rest);
        else inFlight.delete(edit.url);
        emit();
      }
    },
  });
}

/** Retries after a failed access read: soon, then less often. Focus and opening an editor retry at once. */
const ACCESS_RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

/** Who may edit, read once per PR (main caches it per minute), and read again after a write to the PR. */
export function usePrPeople(member: ReviewMember, status?: PrStatus) {
  const url = member.url;
  const [access, setAccess] = useState<{ url: string; value?: PrPeopleAccess; error?: string }>();
  const [attempt, setAttempt] = useState(0);
  const pending = useSyncExternalStore(subscribe, () => inFlight.get(url) ?? NONE);
  // A merge, close or reopen changes whether reviews can be requested: read access again when the PR's state moves.
  const lifecycle = `${status?.lifecycle?.state ?? member.state}:${status?.lifecycle?.merged ?? member.merged}`;
  useEffect(() => {
    let cancelled = false;
    const read = () =>
      window.electronAPI
        .getPrPeopleAccess(url)
        .then((value) => !cancelled && setAccess({ url, value }))
        .catch((error: unknown) => !cancelled && setAccess({ url, error: error instanceof Error ? error.message : String(error) }));
    void read();
    const stop = window.electronAPI.onGitHubWriteRefreshed?.((event) => {
      // Settled, or given up on: either way GitHub may have changed what the reader can do.
      if ((event.phase === 'settled' || event.phase === 'gave-up') && event.urls.includes(url)) void read();
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [url, attempt, lifecycle]);
  const current = access?.url === url ? access : undefined;
  const failed = !!current?.error;
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  // A failed read is tried again with backoff, and whenever the window gets focus.
  const failures = useRef(0);
  useEffect(() => {
    if (!failed) {
      failures.current = 0;
      return;
    }
    const timer = setTimeout(retry, ACCESS_RETRY_MS[Math.min(failures.current++, ACCESS_RETRY_MS.length - 1)]);
    window.addEventListener('focus', retry);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', retry);
    };
  }, [failed, attempt, retry]);
  const view = useMemo(() => pending.reduce(withPeopleEdit, prPeopleView(member, status)), [member, status, pending]);
  return { view, access: current?.value, accessError: current?.error, pending, retryAccess: retry };
}
export type PrPeopleState = ReturnType<typeof usePrPeople>;

const FIELD_LABEL: Record<PrPeopleField, { edit: string; search: string; empty: string }> = {
  reviewers: { edit: 'Edit reviewers', search: 'Search people and teams', empty: 'No matching people or teams.' },
  assignees: { edit: 'Edit assignees', search: 'Search people', empty: 'No matching people.' },
  labels: { edit: 'Edit labels', search: 'Search labels', empty: 'No matching labels.' },
  milestone: { edit: 'Set milestone', search: 'Search open milestones', empty: 'No matching open milestones.' },
};

type Option =
  | { key: string; kind: 'user'; person: PrPersonCandidate; hint?: string }
  | { key: string; kind: 'team'; team: PrTeamCandidate }
  | { key: string; kind: 'label'; label: PrLabel }
  | { key: string; kind: 'milestone'; milestone: PrMilestoneCandidate | null };
const userKey = (login: string) => `user:${login.toLowerCase()}`;
const teamKey = (team: Pick<PrTeamCandidate, 'name'>) => `team:${team.name.toLowerCase()}`;
const labelKey = (name: string) => `label:${name.toLowerCase()}`;
const NO_MILESTONE = 'milestone:none';
const milestoneKey = (m: PrMilestoneCandidate | null) => (m ? `milestone:${m.number}` : NO_MILESTONE);
/** GitHub's slug for a team name, when only the name is known. */
const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z\d._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

const optionText = (option: Option) =>
  option.kind === 'user'
    ? [option.person.login, option.person.name]
    : option.kind === 'team'
      ? [option.team.name, option.team.slug]
      : option.kind === 'label'
        ? [option.label.name, option.label.description]
        : [option.milestone?.title ?? 'No milestone'];
const optionLabel = (option: Option | undefined) =>
  !option ? '' : option.kind === 'user' ? option.person.login : option.kind === 'team' ? option.team.name : option.kind === 'label' ? option.label.name : (option.milestone?.title ?? 'No milestone');

function PersonAvatar({ person }: { person: PrPersonCandidate }) {
  return (
    <Avatar size="sm" className="pr-people-avatar" aria-hidden="true">
      <AvatarImage src={person.avatarUrl || githubAvatarUrl(person.login)} alt="" />
      <AvatarFallback>{person.login.slice(0, 1).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}
function OptionContent({ option }: { option: Option }) {
  switch (option.kind) {
    case 'user':
      return (
        <span className="pr-people-option">
          <PersonAvatar person={option.person} />
          <span className="pr-people-option-text">
            <strong>{option.person.login}</strong>
            {option.person.name && <span>{option.person.name}</span>}
          </span>
          {option.hint && <span className="pr-people-option-hint">{option.hint}</span>}
        </span>
      );
    case 'team':
      return (
        <span className="pr-people-option">
          <span className="pr-people-team-icon" aria-hidden="true">
            <Users size={14} />
          </span>
          <span className="pr-people-option-text">
            <strong>{option.team.name}</strong>
            <span>{option.team.slug}</span>
          </span>
          <span className="pr-people-option-hint">Team</span>
        </span>
      );
    case 'label':
      return (
        <span className="pr-people-option pr-people-label-option">
          <span className="pr-label" style={prLabelColors(option.label.color)}>
            {option.label.name}
          </span>
          {option.label.description && <span className="pr-people-option-description">{option.label.description}</span>}
        </span>
      );
    case 'milestone':
      return option.milestone ? (
        <span className="pr-people-option">
          <Milestone size={14} aria-hidden="true" />
          <span className="pr-people-option-text">
            <strong>{option.milestone.title}</strong>
            {option.milestone.dueOn && <span>Due {formatDueOn(option.milestone.dueOn)}</span>}
          </span>
        </span>
      ) : (
        <span className="pr-people-option pr-people-option-none">No milestone</span>
      );
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Candidates for a field: the first page, saved per repository in main; a typed query reads GitHub only when that page
 * was partial. Every result of this opening is kept, so a person found by one query stays pickable after the next. A
 * failed read is recorded for its query and can be retried.
 */
function useCandidates(url: string, field: PrPeopleField, open: boolean, query: string) {
  const [base, setBase] = useState<{ key: string; value?: PrPeopleCandidates; error?: string }>();
  const [found, setFound] = useState<{ key: string; results: PrPeopleCandidates[]; failed: Record<string, string> }>();
  const [attempt, setAttempt] = useState(0);
  const key = `${url}|${field}`;
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Another PR or field never shows the previous one's candidates.
    setBase({ key });
    setFound({ key, results: [], failed: {} });
    window.electronAPI
      .getPrPeopleCandidates({ url, field, query: '' })
      .then((value) => !cancelled && setBase({ key, value }))
      .catch((error: unknown) => !cancelled && setBase({ key, error: errorText(error) }));
    return () => {
      cancelled = true;
    };
  }, [url, field, key, open, attempt]);
  const own = base?.key === key ? base : undefined;
  const searches = found?.key === key ? found : undefined;
  const needle = query.trim();
  const partial = !!own?.value && !own.value.complete;
  const answered = !!searches?.results.some((result) => result.query === needle);
  const failure = needle ? searches?.failed[needle] : undefined;
  useEffect(() => {
    if (!open || !partial || !needle || answered || failure) return;
    let cancelled = false;
    // Typing pauses before GitHub is asked: one request per word, not per key.
    const timer = setTimeout(() => {
      window.electronAPI
        .getPrPeopleCandidates({ url, field, query: needle })
        .then((value) => !cancelled && setFound((previous) => previous?.key === key ? { ...previous, results: [...previous.results, value] } : previous))
        .catch((error: unknown) =>
          !cancelled && setFound((previous) => previous?.key === key ? { ...previous, failed: { ...previous.failed, [needle]: errorText(error) } } : previous)
        );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [url, field, key, open, partial, needle, answered, failure]);
  const retry = () => {
    if (own?.error) setAttempt((n) => n + 1);
    else if (failure)
      setFound((previous) =>
        previous && { ...previous, failed: Object.fromEntries(Object.entries(previous.failed).filter(([query]) => query !== needle)) }
      );
  };
  return {
    base: own?.value,
    error: own?.error ?? failure,
    found: searches?.results ?? [],
    searching: partial && !!needle && !answered && !failure,
    retry,
  };
}

const VERDICT_HINT: Record<string, string> = {
  APPROVED: 'Approved',
  CHANGES_REQUESTED: 'Changes requested',
  COMMENTED: 'Commented',
  DISMISSED: 'Dismissed',
};

/**
 * The field's edit button and its searchable picker, as in GitHub's sidebar: arrows move, Enter or a click toggles,
 * and closing the picker (Escape, Done, a click outside) applies the change as one write. The milestone picker
 * applies the one choice at once.
 */
export function PrPeopleEditor({
  field,
  member,
  people,
  reviewed = [],
  open,
  editing = null,
  openRequest,
  onOpenChange,
}: {
  field: PrPeopleField;
  member: ReviewMember;
  people: PrPeopleState;
  /** Reviewers who already reviewed, with their verdicts: picking one requests their review again. */
  reviewed?: { login: string; verdict: string; typename?: string }[];
  open: boolean;
  /** The field whose picker is open, if any. */
  editing?: PrPeopleField | null;
  /**
   * The latest command to open a picker, for any field, numbered. Each is handled once, by the field it names; one
   * that existed before this editor mounted, or that effects replay as the tab hides and shows, is not.
   */
  openRequest?: { field: PrPeopleField; n: number };
  onOpenChange: (open: boolean) => void;
}) {
  const { view, access, accessError } = people;
  const trigger = useRef<HTMLButtonElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [query, setQuery] = useState('');
  const [draft, setDraftState] = useState<string[]>([]);
  // The latest selection and whether this opening is still to be applied, read when the picker closes.
  const latest = useRef<string[]>([]);
  const session = useRef(false);
  const setDraft = (keys: string[]) => {
    latest.current = keys;
    setDraftState(keys);
  };
  /** The options and selection as the picker opened: order stays put while the reader toggles. */
  const [initial, setInitial] = useState<{ keys: string[]; options: Option[] }>({ keys: [], options: [] });
  const candidates = useCandidates(member.url, field, open, query);
  const saving = useWriteInFlight(peopleFailureKey(member.url, field));
  const author = access?.author || member.author;
  const label = FIELD_LABEL[field];
  const disabledReason = accessError
    ? `Couldn’t check your access: ${accessError}`
    : !access
      ? 'Checking your access…'
      : (fieldBlockedReason(access, field) ?? (saving ? 'Saving the last change…' : undefined));

  const current = useMemo((): Option[] => {
    switch (field) {
      case 'reviewers':
        return [
          ...view.requestedReviewers.map((login): Option => ({ key: userKey(login), kind: 'user', person: { login } })),
          ...view.requestedTeams.map((name): Option => {
            const known = access?.requestedTeams.find((team) => sameLogin(team.name, name));
            return { key: teamKey({ name }), kind: 'team', team: known ?? { name, slug: slugOf(name) } };
          }),
        ];
      case 'assignees':
        return view.assignees.map((login) => ({ key: userKey(login), kind: 'user', person: { login } }));
      case 'labels':
        return view.labels.map((name) => ({
          key: labelKey(name),
          kind: 'label',
          label: view.labelDetails.find((l) => sameLogin(l.name, name)) ?? { name },
        }));
      case 'milestone': {
        if (!view.milestone) return [];
        // The PR copies hold the title; the access read adds the number a candidate is keyed by.
        const known = access?.milestone && sameLogin(access.milestone.title, view.milestone.title) ? access.milestone : undefined;
        return [
          known
            ? { key: milestoneKey(known), kind: 'milestone', milestone: known }
            : { key: `milestone:title:${view.milestone.title.toLowerCase()}`, kind: 'milestone', milestone: { number: 0, ...view.milestone } },
        ];
      }
    }
  }, [field, view, access]);

  /** Every option the picker knows: the field's values, GitHub's suggestions and the candidates read so far. */
  const { options, fromRepo } = useMemo(() => {
    const byKey = new Map<string, Option>();
    /** Labels the repository has: only these can be added. */
    const repoLabels = new Set<string>();
    const add = (option: Option) => {
      const existing = byKey.get(option.key);
      // Richer candidate details replace the bare value; a hint, once known, stays.
      if (!existing) byKey.set(option.key, option);
      else if (existing.kind === 'user' && option.kind === 'user')
        byKey.set(option.key, { ...option, person: { ...existing.person, ...option.person }, hint: existing.hint ?? option.hint });
      else if (existing.kind !== 'milestone') byKey.set(option.key, { ...existing, ...option } as Option);
    };
    for (const option of initial.options) add(option);
    for (const list of [candidates.base, ...candidates.found]) {
      if (!list) continue;
      if (field === 'reviewers')
        for (const person of list.suggested) add({ key: userKey(person.login), kind: 'user', person, hint: 'Suggested' });
      for (const person of list.users)
        if (field !== 'reviewers' || canBeRequested(person.login, author)) add({ key: userKey(person.login), kind: 'user', person });
      for (const team of list.teams) add({ key: teamKey(team), kind: 'team', team });
      for (const l of list.labels) {
        repoLabels.add(labelKey(l.name));
        add({ key: labelKey(l.name), kind: 'label', label: l });
      }
      for (const m of list.milestones) add({ key: milestoneKey(m), kind: 'milestone', milestone: m });
    }
    return { options: byKey, fromRepo: repoLabels };
  }, [initial, candidates.base, candidates.found, field, author]);

  const ordered = useMemo(() => {
    const first = initial.options.map((option) => option.key);
    return [...new Set([...first, ...options.keys()])];
  }, [initial, options]);
  const filtered = useMemo(
    () => ordered.filter((key) => {
      const option = options.get(key);
      return !!option && (key === NO_MILESTONE || matchesQuery(query, ...optionText(option)));
    }),
    [ordered, options, query]
  );

  /** Opening: the current values first, then who already reviewed (GitHub's suggestions follow as they load). */
  function begin() {
    const start: Option[] = [];
    if (field === 'milestone') start.push({ key: NO_MILESTONE, kind: 'milestone', milestone: null });
    start.push(...current);
    if (field === 'reviewers')
      for (const { login, verdict, typename } of reviewed)
        if (canBeRequested(login, author, typename) && VERDICT_HINT[verdict])
          start.push({ key: userKey(login), kind: 'user', person: { login }, hint: `${VERDICT_HINT[verdict]} · request again` });
    if (field === 'assignees' && access?.viewer)
      start.push({ key: userKey(access.viewer), kind: 'user', person: { login: access.viewer }, hint: 'You' });
    const seen = new Set<string>();
    const unique = start.filter((option) => {
      if (seen.has(option.key)) return false;
      seen.add(option.key);
      return true;
    });
    const keys = field === 'milestone' ? [current[0]?.key ?? NO_MILESTONE] : current.map((option) => option.key);
    setInitial({ keys, options: unique });
    setDraft(keys);
    setQuery('');
    session.current = true;
  }
  useEffect(() => {
    if (open) {
      setContainer(findComboboxContainer(trigger.current));
      begin();
    }
    // The selection is taken once, as the picker opens.
  }, [open]);

  /** Closing applies what changed, as one write. */
  function finish(keys: string[]) {
    const { add, remove } = diffSelection(initial.keys, keys);
    if (!add.length && !remove.length) return;
    const pick = (list: string[]) => list.flatMap((key) => options.get(key) ?? []);
    const url = member.url;
    switch (field) {
      case 'reviewers': {
        const logins = (list: Option[]) => list.flatMap((o) => (o.kind === 'user' ? [o.person.login] : []));
        const teams = (list: Option[]) => list.flatMap((o) => (o.kind === 'team' ? [o.team] : []));
        const added = pick(add);
        const removed = pick(remove);
        void sendPeopleEdit({ url, field, add: logins(added), remove: logins(removed), addTeams: teams(added), removeTeams: teams(removed) });
        return;
      }
      case 'assignees': {
        const logins = (list: string[]) => pick(list).flatMap((o) => (o.kind === 'user' ? [o.person.login] : []));
        void sendPeopleEdit({ url, field, add: logins(add), remove: logins(remove) });
        return;
      }
      case 'labels': {
        // Only labels the repository has: never one carried over from another repository's list.
        const chosen = pick(add.filter((key) => fromRepo.has(key))).flatMap((o) => (o.kind === 'label' ? [o.label] : []));
        const dropped = pick(remove).flatMap((o) => (o.kind === 'label' ? [o.label.name] : []));
        if (chosen.length || dropped.length) void sendPeopleEdit({ url, field, add: chosen, remove: dropped });
        return;
      }
      case 'milestone': {
        const option = options.get(keys[0] ?? NO_MILESTONE);
        if (option?.kind !== 'milestone' || (option.milestone && !option.milestone.number)) return;
        void sendPeopleEdit({ url, field, milestone: option.milestone });
        return;
      }
    }
  }
  const setOpen = (next: boolean) => {
    if (next && accessError) people.retryAccess();
    if (next && disabledReason) return;
    if (!next && session.current) {
      session.current = false;
      finish(latest.current);
    }
    onOpenChange(next);
  };

  // A command opens the picker through the same checks as the button. While the field's last change is still saving,
  // it opens once that finishes, so neither change is lost.
  const waiting = useRef(false);
  const handled = useRef(openRequest?.n ?? 0);
  /** Another field's picker is open. A command never closes it: that would skip its `finish` and lose its change. */
  const anotherOpen = editing !== null && editing !== field;
  /** Opens for a command, counted on the button for checks (`data-request-opens`). */
  const requestOpen = () => {
    waiting.current = false;
    if (anotherOpen) return;
    if (disabledReason) {
      toast.add({ title: label.edit, description: disabledReason, type: 'error' });
      return;
    }
    const button = trigger.current;
    button?.setAttribute('data-request-opens', String(Number(button.getAttribute('data-request-opens') ?? 0) + 1));
    setOpen(true);
  };
  useEffect(() => {
    if (!openRequest || openRequest.n <= handled.current) return;
    handled.current = openRequest.n;
    // A command for another field replaces one still waiting here.
    waiting.current = false;
    if (openRequest.field !== field) return;
    if (saving) waiting.current = true;
    else requestOpen();
  }, [openRequest]);
  // The reader opened another field's picker: a command still waiting here is dropped.
  useEffect(() => {
    if (anotherOpen) waiting.current = false;
  }, [anotherOpen]);
  // Another PR (not a remount of this one): a picker waiting for this PR's save never opens there.
  const shownUrl = useRef(member.url);
  useEffect(() => {
    if (shownUrl.current === member.url) return;
    shownUrl.current = member.url;
    waiting.current = false;
  }, [member.url]);
  useEffect(() => {
    if (saving || !waiting.current) return;
    requestOpen();
  }, [saving]);

  const button = (
    <ComboboxPrimitive.Trigger
      ref={trigger}
      className="workbench-icon pr-people-edit"
      aria-label={label.edit}
      aria-disabled={disabledReason ? true : undefined}
      aria-description={disabledReason}
      aria-busy={saving || undefined}
      data-field={field}
    >
      <Pencil size={14} aria-hidden="true" />
    </ComboboxPrimitive.Trigger>
  );
  const footer =
    field === 'reviewers' && candidates.base?.teamsUnavailable ? 'Teams aren’t available to this sign-in.' : `${draft.length} selected`;
  const failed = candidates.error;
  const empty = failed ? (
    <span className="pr-people-load-error" role="alert">
      Couldn’t load the list. {failed}{' '}
      {/* Keeps focus in the search field, so arrows and Enter go on working after Retry. */}
      <button type="button" onPointerDown={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()} onClick={candidates.retry}>
        Retry
      </button>
    </span>
  ) : !candidates.base || candidates.searching ? (
    'Loading…'
  ) : (
    label.empty
  );
  const multiple = field !== 'milestone';
  const shared = {
    items: ordered,
    filteredItems: filtered,
    itemToStringLabel: (key: string) => optionLabel(options.get(key)),
    open,
    onOpenChange: setOpen,
    inputValue: query,
    onInputValueChange: setQuery,
    autoHighlight: true,
  };
  const content = (
    <ComboboxContent container={container} collisionBoundary={[]} className="pr-people-popup" data-field={field}>
      <ComboboxInput aria-label={label.search} placeholder={`${label.search}…`} />
      <ComboboxEmpty>{filtered.length && !failed ? null : empty}</ComboboxEmpty>
      <ComboboxList>
        {(key: string) => {
          const option = options.get(key);
          return option ? (
            <ComboboxItem key={key} value={key} data-value={key} data-kind={option.kind}>
              <OptionContent option={option} />
            </ComboboxItem>
          ) : null;
        }}
      </ComboboxList>
      {multiple && (
        <div className="queue-label-footer pr-people-footer">
          <span>{footer}</span>
          <button type="button" onClick={() => setOpen(false)}>
            Done
          </button>
        </div>
      )}
    </ComboboxContent>
  );
  const picker = multiple ? (
    <Combobox multiple value={draft} onValueChange={(keys: string[]) => setDraft(keys)} {...shared}>
      {button}
      {content}
    </Combobox>
  ) : (
    <Combobox
      value={draft[0] ?? NO_MILESTONE}
      onValueChange={(key: string | null) => {
        setDraft([key ?? NO_MILESTONE]);
        // One choice: it applies at once.
        setOpen(false);
      }}
      {...shared}
    >
      {button}
      {content}
    </Combobox>
  );
  // One element tree whether or not the editor is disabled: a save in flight disables it for a moment, and a remounted
  // button would drop keyboard focus to the page. The tooltip only opens while there is a reason to show.
  return (
    <TooltipProvider delayDuration={350}>
      <Tooltip {...(disabledReason ? {} : { open: false })}>
        <TooltipTrigger asChild>
          <span className="pr-people-edit-wrap">{picker}</span>
        </TooltipTrigger>
        <TooltipContent>{disabledReason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Asks an earlier reviewer to review again: one click, shown at once, rolled back if GitHub refuses. Offered where
 * Feedback offers its request-review button: an open PR the reader can update, never for the author or a bot.
 */
export function ReRequestReview({
  member,
  login,
  typename,
  people,
  feedback,
}: {
  member: ReviewMember;
  login: string;
  typename?: string;
  people: PrPeopleState;
  feedback?: { viewerCanUpdate: boolean; state: string };
}) {
  const busy = useWriteInFlight(reRequestKey(member.url, login));
  const access = people.access;
  if (!access || fieldBlockedReason(access, 'reviewers') || !canBeRequested(login, access.author, typename)) return null;
  if (feedback && (!feedback.viewerCanUpdate || feedback.state !== 'OPEN')) return null;
  return (
    <button
      type="button"
      className="workbench-icon pr-people-rerequest"
      aria-label={`Request a review from ${login} again`}
      title={`Request a review from ${login} again`}
      disabled={busy}
      onClick={() =>
        void sendPeopleEdit(
          { url: member.url, field: 'reviewers', add: [login], remove: [], addTeams: [], removeTeams: [] },
          reRequestKey(member.url, login)
        )
      }
    >
      <RefreshCw size={13} aria-hidden="true" />
    </button>
  );
}

export function PrPeopleFailure({ url, field }: { url: string; field: PrPeopleField }) {
  return <WriteFailureNotice failureKey={peopleFailureKey(url, field)} className="pr-people-failure" />;
}
/** A re-request's failure, under the reviewer list. */
export function ReRequestFailure({ url, login }: { url: string; login: string }) {
  return <WriteFailureNotice failureKey={reRequestKey(url, login)} className="pr-people-failure" />;
}

/** The access read failed: say so once, with Retry, instead of leaving the editors silently disabled. */
export function PrPeopleAccessError({ people }: { people: PrPeopleState }) {
  if (!people.accessError) return null;
  return (
    <p className="write-failure pr-people-access-error" role="status">
      <span>Couldn’t check whether you can edit this PR.</span>
      <span className="write-failure-actions">
        <button type="button" onClick={people.retryAccess}>
          Retry
        </button>
      </span>
    </p>
  );
}
