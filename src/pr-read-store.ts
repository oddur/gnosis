import type { StateStorage } from './app-data-store';
import { createHash } from 'node:crypto';
import {
  emptyReadVersions,
  prReadMetadata,
  READ_REASONS,
  type MarkPrReadRequest,
  type PrReadState,
  type ReadReason,
  type ReadVersions,
} from '../lib/pr-read-state';
import type { PrMetadata } from '../lib/types';
import { deepFreeze } from '../lib/deep-freeze';
import type { QueueSignals } from '../lib/queue-signals';
import { isAutomationActor, sameLogin } from '../lib/github-actors';

type Basis = ReturnType<typeof prReadMetadata> & {
  latestComment?: string;
  latestReview?: string;
  decision?: string | null;
};
interface Entry {
  basis: Basis;
  versions: ReadVersions;
  read: ReadVersions;
  since: number;
  signalsAt?: number;
  metadataAt?: string;
  metadataKey?: string;
  ownReviewIds?: string[];
  /** Newest conversation comment and review seen, for finding the events a signal adds. */
  latestCommentAt?: string;
  latestReviewAt?: string;
  /**
   * A head change waiting for its commit's author. On your own PR the bump waits for it. On another PR it
   * is undone when the new head turns out to be your push and the commits were read before it.
   */
  headCheck?: { sha: string; deferred: boolean; wasRead: boolean };
}
interface State {
  initialized: boolean;
  entries: Partial<Record<string, Entry>>;
}
/** A change in progress. `entry` copies an entry on first use, so only touched entries are compared. */
interface Draft {
  initialized: boolean;
  entry(url: string): Entry | undefined;
  add(url: string, entry: Entry): void;
}
type ActivityEvent = NonNullable<NonNullable<QueueSignals['activity']>['recent']>[number];
const eventIdentity = (event: ActivityEvent) => (event.kind === 'review' ? `${event.id}:${event.state ?? ''}` : event.id);
/** Signals saved before `recent` existed carry only the newest comment and review. */
function legacyEvents(signal: QueueSignals): ActivityEvent[] {
  const { comment, review } = signal.activity ?? {};
  return [
    ...(comment ? [{ kind: 'comment' as const, ...comment, automated: isAutomationActor({ login: comment.author }) }] : []),
    ...(review ? [{ kind: 'review' as const, ...review, automated: isAutomationActor({ login: review.author }) }] : []),
  ];
}
/**
 * The events after the last one seen, oldest first. A review whose state changed, such as a dismissal,
 * counts again. Without a known position, events after the newest seen time count. A first observation
 * counts only events after the PR was first tracked.
 */
function unseen(events: ActivityEvent[], seen: string | undefined, seenAt: string | undefined, since: number) {
  if (seen === undefined) return events.filter((event) => Date.parse(event.at) > since);
  let index = events.length - 1;
  while (index >= 0 && seen !== eventIdentity(events[index]) && !seen.startsWith(`${events[index].id}:`)) index--;
  if (index >= 0) return events.slice(eventIdentity(events[index]) === seen ? index + 1 : index);
  if (seenAt) return events.filter((event) => event.at > seenAt);
  // Saved before positions were kept: only the newest event can be judged.
  return events.slice(-1).filter((event) => eventIdentity(event) !== seen);
}
/** Your own comment or review, from any client. Review ids cover reviews posted through Gnosis. */
function isOwnEvent(event: ActivityEvent, entry: Entry, account: string) {
  return sameLogin(event.author, account) || (event.kind === 'review' && (entry.ownReviewIds ?? []).includes(event.id));
}
/** Your push: you wrote the head commit and committed it yourself or through GitHub's web interface. */
function isOwnCommit(head: { author: string | null; committer: string | null }, account: string) {
  return (
    sameLogin(head.author, account) &&
    (head.committer === null || sameLogin(head.committer, account) || sameLogin(head.committer, 'web-flow'))
  );
}
const validUrl = (url: string) => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url);
/** Durable user progress. Cache eviction and stack regrouping never change its identity. */
export function createPrReadStore(storage: StateStorage, now = Date.now) {
  const accounts = new Map<string, State>();
  const name = (account: string) => `pr-read-${createHash('sha256').update(account.toLowerCase()).digest('hex')}.json`;
  function load(account: string): State {
    const key = account.toLowerCase();
    if (!accounts.has(key)) {
      let state: State = { initialized: false, entries: {} };
      try {
        // Validate persisted data before trusting its shape.
        const saved = storage.read(name(account));
        if (saved === undefined) throw Object.assign(new Error('No saved progress'), { code: 'ENOENT' });
        const parsed = saved as State;
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime JSON validation
        if (typeof parsed.initialized !== 'boolean' || !parsed.entries || typeof parsed.entries !== 'object')
          throw Error('Invalid read state');
        for (const [url, entry] of Object.entries(parsed.entries)) {
          /* eslint-disable @typescript-eslint/no-unnecessary-condition -- runtime JSON validation */
          if (
            !entry ||
            !validUrl(url) ||
            typeof entry.basis?.headSha !== 'string' ||
            !entry.versions ||
            !entry.read ||
            !Number.isFinite(entry.since) ||
            !READ_REASONS.every(
              (reason) =>
                Number.isSafeInteger(entry.versions[reason]) &&
                entry.versions[reason] >= 0 &&
                Number.isSafeInteger(entry.read[reason]) &&
                entry.read[reason] >= 0
            )
          )
            throw Error('Invalid read entry');
          /* eslint-enable @typescript-eslint/no-unnecessary-condition */
        }
        state = parsed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw new Error('Could not load unread progress. Your saved progress has not been replaced.');
      }
      accounts.set(key, state);
    }
    const state = accounts.get(key);
    if (!state) throw new Error('Unread progress was not loaded.');
    return state;
  }
  const snapshots = new WeakMap<State, Readonly<Record<string, PrReadState>>>();
  function edit(account: string, fn: (draft: Draft) => void) {
    const previous = load(account);
    const entries = { ...previous.entries };
    const touched = new Set<string>();
    const draft: Draft = {
      initialized: previous.initialized,
      entry(url) {
        if (!touched.has(url)) {
          touched.add(url);
          const entry = previous.entries[url];
          if (entry) entries[url] = structuredClone(entry);
        }
        return entries[url];
      },
      add(url, entry) {
        touched.add(url);
        entries[url] = entry;
      },
    };
    fn(draft);
    const next: State = { initialized: draft.initialized, entries };
    const changed = [...touched].filter((url) => JSON.stringify(entries[url]) !== JSON.stringify(previous.entries[url]));
    if (next.initialized === previous.initialized && !changed.length) return false;
    // Only the touched entries are saved. The header is tiny and always sent, so a first save creates it.
    storage.patch(name(account), {
      header: { initialized: next.initialized },
      put: Object.fromEntries(changed.flatMap((url) => (entries[url] ? [[url, entries[url]]] : []))),
    });
    accounts.set(account.toLowerCase(), next);
    return true;
  }
  const bump = (entry: Entry, reason: ReadReason, own = false) => {
    const wasRead = entry.read[reason] === entry.versions[reason];
    entry.versions[reason]++;
    if (own && wasRead) entry.read[reason] = entry.versions[reason];
  };
  function observeMetadata(state: Draft, meta: PrMetadata, account: string, own = false) {
    if (!validUrl(meta.url)) return;
    const metadataKey = JSON.stringify(prReadMetadata(meta));
    const ownPr = sameLogin(meta.author, account);
    let entry = state.entry(meta.url);
    if (!entry) {
      entry = {
        basis: prReadMetadata(meta),
        versions: emptyReadVersions(),
        read: emptyReadVersions(),
        since: now(),
        metadataAt: meta.updatedAt,
        metadataKey,
      };
      // A PR you opened yourself, from a terminal or on github.com, is not news to you.
      if (state.initialized && !own && !ownPr) bump(entry, 'new');
      state.add(meta.url, entry);
      return;
    }
    // A late response or saved explanation must not roll observed state backwards.
    if (entry.metadataAt && meta.updatedAt < entry.metadataAt) return;
    if (entry.metadataKey === metadataKey) return;
    entry.metadataKey = metadataKey;
    const next = prReadMetadata(meta);
    if (next.headSha !== entry.basis.headSha) {
      const wasRead = entry.read.commits === entry.versions.commits;
      if (own) {
        bump(entry, 'commits', true);
        delete entry.headCheck;
      } else {
        // On your own PR this is usually your push: wait for the head commit's author before calling it new.
        if (!ownPr) bump(entry, 'commits');
        entry.headCheck = { sha: next.headSha, deferred: ownPr, wasRead };
      }
    }
    if (next.state !== entry.basis.state) bump(entry, 'state', own);
    // Comment counts name no author, so comments become unread from signals, which do.
    entry.basis.comments = next.comments ?? entry.basis.comments;
    entry.basis.inlineComments = next.inlineComments ?? entry.basis.inlineComments;
    entry.basis.headSha = next.headSha;
    entry.basis.state = next.state;
    entry.metadataAt = meta.updatedAt;
  }
  return {
    observe(account: string, members: PrMetadata[], finishBaseline = false, own = false) {
      const current = load(account);
      const changed = members.filter(member => {
        if (!validUrl(member.url)) return false;
        const entry = current.entries[member.url];
        if (!entry) return true;
        if (entry.metadataAt && member.updatedAt < entry.metadataAt) return false;
        return entry.metadataKey !== JSON.stringify(prReadMetadata(member));
      });
      if (!changed.length && (!finishBaseline || current.initialized)) return false;
      return edit(account, (state) => {
        for (const member of changed) observeMetadata(state, member, account, own);
        if (finishBaseline) state.initialized = true;
      });
    },
    signals(account: string, values: QueueSignals[]) {
      return edit(account, (state) => {
        for (const signal of values) {
          // Read the saved entry first, so a signal that changes nothing copies nothing.
          const saved = load(account).entries[signal.url];
          if (!saved || signal.headSha !== saved.basis.headSha || signal.checkedAt <= (saved.signalsAt ?? 0)) continue;
          const entry = state.entry(signal.url);
          if (!entry) continue;
          entry.signalsAt = signal.checkedAt;
          entry.basis.comments = signal.comments;
          const head = signal.activity?.head;
          if (head && entry.headCheck?.sha === signal.headSha) {
            const mine = isOwnCommit(head, account);
            if (entry.headCheck.deferred && !mine) bump(entry, 'commits');
            if (!entry.headCheck.deferred && mine && entry.headCheck.wasRead) entry.read.commits = entry.versions.commits;
            delete entry.headCheck;
          }
          // Your own comments and reviews, from any client, and bot or hidden comments are never news.
          const recent = signal.activity?.recent ?? legacyEvents(signal);
          for (const kind of ['comment', 'review'] as const) {
            const events = recent.filter((event) => event.kind === kind);
            const newest = events.at(-1);
            if (!newest) continue;
            const key = kind === 'comment' ? 'latestComment' : 'latestReview';
            const atKey = kind === 'comment' ? 'latestCommentAt' : 'latestReviewAt';
            const added = unseen(events, entry.basis[key], entry[atKey], entry.since);
            for (const event of added) {
              if (isOwnEvent(event, entry, account) || event.automated || event.minimized) continue;
              // A comment-only review is how GitHub submits inline comments and replies.
              bump(entry, kind === 'comment' || event.state === 'COMMENTED' ? 'comments' : 'reviews');
            }
            if (kind === 'review' && entry.ownReviewIds)
              entry.ownReviewIds = entry.ownReviewIds.filter((id) => !added.some((event) => event.id === id));
            entry.basis[key] = eventIdentity(newest);
            entry[atKey] = newest.at;
          }
          if (signal.readiness && signal.checkedAt >= Date.parse(entry.metadataAt ?? '')) {
            const ready = signal.readiness;
            const state = `${ready.state === 'OPEN' ? 'open' : 'closed'}:${ready.state === 'MERGED'}:${ready.isDraft}`;
            if (state !== entry.basis.state) {
              bump(entry, 'state');
              entry.basis.state = state;
            }
          }
          // Latest review identity catches repeated approvals and comment-only reviews.
          const decision = signal.readiness?.reviewDecision;
          if (
            !signal.activity?.review &&
            entry.basis.decision !== undefined &&
            decision !== undefined &&
            decision !== entry.basis.decision
          )
            bump(entry, 'reviews');
          if (decision !== undefined) entry.basis.decision = decision;
        }
      });
    },
    /**
     * A review posted through Gnosis. Its author is the account, which already makes it your own; the
     * saved id also covers a login GitHub reports differently. Replies and comments need nothing here.
     */
    ownReview(account: string, url: string, reviewUrl?: string) {
      if (!reviewUrl) return false;
      return edit(account, (state) => {
        const entry = state.entry(url);
        if (entry) entry.ownReviewIds = [...(entry.ownReviewIds ?? []), reviewUrl].slice(-100);
      });
    },
    /** Frozen and shared until the next saved change. */
    snapshot(account: string): Readonly<Record<string, PrReadState>> {
      const state = load(account);
      const known = snapshots.get(state);
      if (known) return known;
      const value = deepFreeze(
        Object.fromEntries(
          Object.entries(state.entries).flatMap(([url, entry]) =>
            entry
              ? [
                  [
                    url,
                    {
                      url,
                      headSha: entry.basis.headSha,
                      versions: { ...entry.versions },
                      unread: READ_REASONS.filter((reason) => entry.versions[reason] > entry.read[reason]),
                    },
                  ],
                ]
              : []
          )
        )
      );
      snapshots.set(state, value);
      return value;
    },
    mark(account: string, request: MarkPrReadRequest) {
      /* eslint-disable @typescript-eslint/no-unnecessary-condition -- IPC is an untrusted runtime boundary */
      if (
        typeof request?.account !== 'string' ||
        request.account.toLowerCase() !== account.toLowerCase() ||
        typeof request.read !== 'boolean' ||
        !Array.isArray(request.receipts) ||
        request.receipts.length > 10000 ||
        !request.receipts.every(
          (receipt) =>
            receipt &&
            validUrl(receipt.url) &&
            typeof receipt.headSha === 'string' &&
            receipt.versions &&
            READ_REASONS.every(
              (reason) => Number.isSafeInteger(receipt.versions[reason]) && receipt.versions[reason] >= 0
            )
        )
      )
        throw Error('Choose valid PRs to mark as read.');
      /* eslint-enable @typescript-eslint/no-unnecessary-condition */
      return edit(account, (state) => {
        for (const receipt of request.receipts) {
          const entry = state.entry(receipt.url);
          if (!entry) continue;
          if (!request.read) {
            bump(entry, 'manual');
            continue;
          }
          for (const reason of READ_REASONS) {
            if ((reason === 'commits' || reason === 'new') && receipt.headSha !== entry.basis.headSha) continue;
            entry.read[reason] = Math.max(
              entry.read[reason],
              Math.min(receipt.versions[reason], entry.versions[reason])
            );
          }
        }
      });
    },
  };
}
