/**
 * What the menu bar panel shows (#308 section 7.2, "Data flow"). Pure: main gathers the inputs from state it
 * already holds (the workbench snapshot, saved signals, Activity) and pushes the result. No GitHub request.
 *
 * Rows sent to the panel carry no URL or target. The panel sends a row id back; main resolves it against the
 * `items` it kept from the same build.
 */
import {
  ATTENTION_GROUPS,
  ATTENTION_LABEL,
  ATTENTION_SIGNALS_MAX_AGE,
  attentionItems,
  attentionSummary,
  isOwnPr,
  type AttentionGroup,
  type AttentionItem,
  type AttentionKind,
} from './attention';
import type { ActivityTask } from './activity';
import { menubarBadge, type MenubarBadge } from './menubar-settings';
import type { QueueSignalRequest, QueueSignals } from './queue-signals';
import type { ReviewMember, WorkbenchQueue } from './workbench';

export type MenubarConnection = 'ok' | 'signed-out' | 'offline' | 'paused' | 'error';
export interface MenubarRow {
  id: string;
  kinds: AttentionKind[];
  /** Status text for the first two kinds, such as "Changes requested · Checks failed". */
  labels: string[];
  title: string;
  repo: string;
  number: number;
  author: string;
  /** Your own PR: the author is not shown. */
  own: boolean;
  stackSize?: number;
  /** Rows from the same stack share it; the panel shows them together under one stack line. */
  stackId?: string;
  isNew: boolean;
  checkedAt?: number;
}
export interface MenubarGroup {
  group: AttentionGroup;
  label: string;
  /** Every row in the group; `rows` holds at most five. */
  count: number;
  rows: MenubarRow[];
}
export interface MenubarTask {
  id: string;
  title: string;
  detail: string;
  status: 'running' | 'queued' | 'paused' | 'failed';
}
export interface MenubarState {
  account?: string;
  connection: MenubarConnection;
  /** No queue snapshot has been built in this session. */
  loading: boolean;
  /** When the queue was last discovered. */
  checkedAt?: number;
  /** "GitHub updates paused until 14:32". */
  retryAt?: number;
  groups: MenubarGroup[];
  tasks: MenubarTask[];
  /**
   * The header. `marked` is the number on the menu bar icon when the icon counts new PRs (`new`, or `dot`, whose dot
   * stands for them), so the header explains the icon: "15 need you · 9 new · 20 ready". Otherwise 0.
   */
  summary: { needYou: number; ready: number; fresh: number; marked: number; line: string };
  /** Open PRs in the queue, for "Nothing needs you. 14 open PRs in your queue." */
  queueSize: number;
  /** Your open PRs whose status is older than 30 minutes, so status kinds are not shown for them. */
  unchecked: number;
  /** A refresh the user asked for is running. */
  refreshing: boolean;
  /** The first-open tip in the footer (lib/menubar-hint.ts). Only with rows to move through and open. */
  hint: boolean;
}

export const MENUBAR_GROUP_LIMIT = 5;
export const MENUBAR_TASK_LIMIT = 5;
export const MENUBAR_GROUP_LABEL: Readonly<Record<AttentionGroup, string>> = { review: 'To review', fix: 'To fix', ready: 'Ready' };

export interface MenubarInput {
  login?: string | null;
  signedIn: boolean;
  online: boolean;
  /** Undefined until the first snapshot of this session is built. */
  queue?: Pick<WorkbenchQueue, 'items' | 'sync'>;
  signals: (member: ReviewMember) => QueueSignals | undefined;
  enabled?: (kind: AttentionKind, repo: string) => boolean;
  teamRequests?: boolean;
  tasks?: readonly ActivityTask[];
  /** When GitHub reads are paused for this account, from the client backoff. */
  backoffUntil?: number;
  refreshing?: boolean;
  /** The "Number on the icon" setting, so the header names the same count. Defaults to `new`. */
  badge?: MenubarBadge;
  /** The first-open tip has not been dismissed and no row has been opened yet. */
  hint?: boolean;
  now: number;
}

const quiet = (task: ActivityTask) => task.kind === 'preload' || task.kind === 'github';

/** Running, queued and failed Activity tasks that are not routine background work. Failed ones first. */
export function menubarTasks(tasks: readonly ActivityTask[], login?: string | null): MenubarTask[] {
  const order: Record<MenubarTask['status'], number> = { failed: 0, running: 1, paused: 2, queued: 3 };
  return tasks
    .filter((task) => !quiet(task) && (!task.account || task.account === login))
    .flatMap((task): MenubarTask[] =>
      task.status === 'running' || task.status === 'queued' || task.status === 'paused' || task.status === 'failed'
        ? [{ id: task.id, title: task.title, detail: task.detail, status: task.status }]
        : []
    )
    .sort((a, b) => order[a.status] - order[b.status])
    .slice(0, MENUBAR_TASK_LIMIT);
}

function connection(input: MenubarInput): { connection: MenubarConnection; retryAt?: number } {
  if (!input.signedIn) return { connection: 'signed-out' };
  if (!input.online) return { connection: 'offline' };
  const sync = input.queue?.sync;
  const retryAt = Math.max(input.backoffUntil ?? 0, sync?.status === 'paused' ? (sync.retryAt ?? 0) : 0);
  if (retryAt > input.now) return { connection: 'paused', retryAt };
  if (sync?.status === 'error') return { connection: 'error' };
  return { connection: 'ok' };
}

export function buildMenubarState(input: MenubarInput): { state: MenubarState; items: AttentionItem[] } {
  const login = input.login ?? '';
  const signedIn = input.signedIn && !!login;
  const queue = signedIn ? input.queue : undefined;
  const items = queue
    ? attentionItems({
        items: queue.items,
        signals: input.signals,
        login,
        enabled: input.enabled ?? (() => true),
        now: input.now,
        teamRequests: input.teamRequests,
      })
    : [];
  const groups = ATTENTION_GROUPS.flatMap((group): MenubarGroup[] => {
    const rows = clusterStacks(items.filter((item) => item.group === group));
    return rows.length
      ? [{ group, label: MENUBAR_GROUP_LABEL[group], count: rows.length, rows: rows.slice(0, MENUBAR_GROUP_LIMIT).map((item) => menubarRow(item, login)) }]
      : [];
  });
  const open = (queue?.items ?? []).flatMap((item) => item.subject.members).filter((member) => member.state === 'open' && !member.merged);
  const unchecked = open.filter((member) => {
    if (!isOwnPr(member, login)) return false;
    const value = input.signals(member);
    return !!value && value.headSha === member.headSha && input.now - value.checkedAt > ATTENTION_SIGNALS_MAX_AGE;
  }).length;
  const status = connection({ ...input, signedIn });
  return {
    items,
    state: {
      ...(signedIn ? { account: login } : {}),
      ...status,
      loading: signedIn && !input.queue,
      ...(queue?.sync?.checkedAt ? { checkedAt: queue.sync.checkedAt } : {}),
      groups,
      tasks: signedIn ? menubarTasks(input.tasks ?? [], login) : [],
      summary: menubarSummary(items, input.badge ?? 'new'),
      queueSize: new Set(open.map((member) => member.url)).size,
      unchecked,
      refreshing: !!input.refreshing,
      hint: !!input.hint && groups.length > 0,
    },
  };
}

/** Rows from one stack move up to the first of them, so the panel shows a stack once. Otherwise the order holds. */
export function clusterStacks<T extends { id: string; stackId?: string }>(rows: readonly T[]): T[] {
  const placed = new Set<string>();
  return rows.flatMap((row) => {
    if (placed.has(row.id)) return [];
    const run = row.stackId ? rows.filter((other) => other.stackId === row.stackId && !placed.has(other.id)) : [row];
    for (const member of run) placed.add(member.id);
    return run;
  });
}

/** The header line. The new count is the icon's own `menubarBadge` count, never a second reckoning. */
export function menubarSummary(items: readonly AttentionItem[], badge: MenubarBadge): MenubarState['summary'] {
  const { needYou, ready, fresh } = attentionSummary(items);
  const marked = badge === 'new' || badge === 'dot' ? menubarBadge(items, badge).count : 0;
  const parts = [needYou ? `${needYou} need${needYou === 1 ? 's' : ''} you` : '', marked ? `${marked} new` : '', ready ? `${ready} ready` : ''].filter(Boolean);
  return { needYou, ready, fresh, marked, line: parts.length ? parts.join(' · ') : 'Nothing needs you' };
}

export function menubarRow(item: AttentionItem, login: string): MenubarRow {
  return {
    id: item.id,
    kinds: item.kinds,
    labels: item.kinds.slice(0, 2).map((kind) => ATTENTION_LABEL[kind]),
    title: item.title,
    repo: item.repo,
    number: item.number,
    author: item.author,
    own: isOwnPr(item, login),
    ...(item.stackSize ? { stackSize: item.stackSize } : {}),
    ...(item.stackId ? { stackId: item.stackId } : {}),
    isNew: item.isNew,
    ...(item.checkedAt ? { checkedAt: item.checkedAt } : {}),
  };
}

/** "Gnosis: 3 need you, 2 ready", for the tooltip that VoiceOver reads with the title. */
export function menubarTooltip(state: Pick<MenubarState, 'connection' | 'summary' | 'loading'>): string {
  if (state.connection === 'signed-out') return 'Gnosis: not connected to GitHub';
  if (state.loading) return 'Gnosis';
  const { needYou, ready } = state.summary;
  if (!needYou && !ready) return 'Gnosis: nothing needs you';
  return `Gnosis: ${[needYou ? `${needYou} need${needYou === 1 ? 's' : ''} you` : '', ready ? `${ready} ready` : ''].filter(Boolean).join(', ')}`;
}

/** The PRs a panel open reads status for: the rows first, then your other open PRs. At most 25, one request. */
export function menubarSignalRequests(
  items: readonly AttentionItem[],
  queue: Pick<WorkbenchQueue, 'items'> | undefined,
  login: string,
  limit = 25
): QueueSignalRequest[] {
  const members = new Map<string, ReviewMember>();
  for (const item of queue?.items ?? []) for (const member of item.subject.members) members.set(member.url, member);
  const urls = [
    ...items.map((item) => item.url),
    ...[...members.values()].filter((member) => member.state === 'open' && !member.merged && isOwnPr(member, login)).map((member) => member.url),
  ];
  return [...new Set(urls)]
    .flatMap((url) => {
      const member = members.get(url);
      return member ? [{ url, headSha: member.headSha }] : [];
    })
    .slice(0, limit);
}

/** `window.gnosisMenubar`, from `src/menubar-preload.ts`. The browser fixture provides a fake. */
export interface MenubarApi {
  get(): Promise<MenubarState | null>;
  onState(callback: (state: MenubarState) => void): () => void;
  /** The panel was shown: focus the list with the first row current. */
  onShown(callback: () => void): () => void;
  open(id: string): void;
  openApp(): void;
  openSettings(): void;
  close(): void;
  refresh(): Promise<void>;
  resize(height: number): void;
  /** The first-open tip's close button. Main remembers it and pushes a state without the tip. */
  dismissHint(): void;
}
