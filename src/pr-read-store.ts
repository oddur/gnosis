import fs from 'node:fs';
import path from 'node:path';
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
import type { QueueSignals } from '../lib/queue-signals';

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
  ownReviewUntil?: number;
  ownReviewIds?: string[];
  ownInlineCredits?: number;
  ownInlineUntil?: number;
}
interface State {
  initialized: boolean;
  entries: Partial<Record<string, Entry>>;
}
const validUrl = (url: string) => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url);
/** Durable user progress. Cache eviction and stack regrouping never change its identity. */
export function createPrReadStore(directory: () => string, now = Date.now) {
  const accounts = new Map<string, State>();
  const file = (account: string) =>
    path.join(directory(), `pr-read-${createHash('sha256').update(account.toLowerCase()).digest('hex')}.json`);
  function load(account: string): State {
    const key = account.toLowerCase();
    if (!accounts.has(key)) {
      let state: State = { initialized: false, entries: {} };
      try {
        // Validate persisted data before trusting its shape.
        const parsed = JSON.parse(fs.readFileSync(file(account), 'utf8')) as State;
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
  function edit(account: string, fn: (state: State) => void) {
    const previous = load(account),
      next = structuredClone(previous);
    fn(next);
    if (JSON.stringify(next) === JSON.stringify(previous)) return false;
    fs.mkdirSync(directory(), { recursive: true });
    fs.writeFileSync(file(account) + '.tmp', JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(file(account) + '.tmp', file(account));
    accounts.set(account.toLowerCase(), next);
    return true;
  }
  const bump = (entry: Entry, reason: ReadReason, own = false) => {
    const wasRead = entry.read[reason] === entry.versions[reason];
    entry.versions[reason]++;
    if (own && wasRead) entry.read[reason] = entry.versions[reason];
  };
  function observeMetadata(state: State, meta: PrMetadata, own = false) {
    if (!validUrl(meta.url)) return;
    const metadataKey = JSON.stringify(prReadMetadata(meta));
    let entry = state.entries[meta.url];
    if (!entry) {
      entry = {
        basis: prReadMetadata(meta),
        versions: emptyReadVersions(),
        read: emptyReadVersions(),
        since: now(),
        metadataAt: meta.updatedAt,
        metadataKey,
      };
      if (state.initialized && !own) bump(entry, 'new');
      state.entries[meta.url] = entry;
      return;
    }
    // A late response or saved explanation must not roll observed state backwards.
    if (entry.metadataAt && meta.updatedAt < entry.metadataAt) return;
    if (entry.metadataKey === metadataKey) return;
    entry.metadataKey = metadataKey;
    const next = prReadMetadata(meta);
    if (next.headSha !== entry.basis.headSha) bump(entry, 'commits', own);
    if (next.state !== entry.basis.state) bump(entry, 'state', own);
    for (const key of ['comments', 'inlineComments'] as const) {
      const before = entry.basis[key],
        after = next[key];
      if (after === undefined) continue;
      if (before !== undefined && after > before) {
        const increase = after - before;
        const credit = key === 'inlineComments' ? Math.min(increase, entry.ownInlineCredits ?? 0) : 0;
        if (credit) entry.ownInlineCredits = (entry.ownInlineCredits ?? 0) - credit;
        if (increase > credit) bump(entry, 'comments', own);
      }
      entry.basis[key] = after;
    }
    // Credits describe one successful local write, not a permanent allowance.
    if (Date.parse(meta.updatedAt) + 1000 >= (entry.ownInlineUntil ?? Infinity)) entry.ownInlineCredits = 0;
    entry.basis.headSha = next.headSha;
    entry.basis.state = next.state;
    entry.metadataAt = meta.updatedAt;
  }
  return {
    observe(account: string, members: PrMetadata[], finishBaseline = false, own = false) {
      return edit(account, (state) => {
        for (const member of members) observeMetadata(state, member, own);
        if (finishBaseline) state.initialized = true;
      });
    },
    signals(account: string, values: QueueSignals[]) {
      return edit(account, (state) => {
        for (const signal of values) {
          const entry = state.entries[signal.url];
          if (!entry || signal.headSha !== entry.basis.headSha || signal.checkedAt <= (entry.signalsAt ?? 0)) continue;
          entry.signalsAt = signal.checkedAt;
          if (entry.basis.comments !== undefined && signal.comments > entry.basis.comments) bump(entry, 'comments');
          entry.basis.comments = signal.comments;
          for (const [key, reason, event] of [
            ['latestComment', 'comments', signal.activity?.comment],
            ['latestReview', 'reviews', signal.activity?.review],
          ] as const) {
            if (!event) continue;
            const old = entry.basis[key];
            const identity =
              reason === 'reviews' ? `${event.id}:${'state' in event ? (event.state ?? '') : ''}` : event.id;
            if (
              identity !== old &&
              (old !== undefined || Date.parse(event.at) > entry.since) &&
              (reason !== 'comments' || Date.parse(event.at) > Date.parse(entry.metadataAt ?? ''))
            ) {
              const own =
                reason === 'reviews' &&
                ((entry.ownReviewIds ?? []).includes(event.id) ||
                  (event.author.toLowerCase() === account.toLowerCase() &&
                    Date.parse(event.at) <= (entry.ownReviewUntil ?? 0)));
              if (own) entry.ownReviewIds = entry.ownReviewIds?.filter((id) => id !== event.id);
              bump(entry, reason, own);
            }
            entry.basis[key] = identity;
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
    ownReview(account: string, url: string, inlineComments: number, until = now(), reviewUrl?: string) {
      return edit(account, (state) => {
        const entry = state.entries[url];
        if (!entry) return;
        if (reviewUrl) entry.ownReviewIds = [...(entry.ownReviewIds ?? []), reviewUrl].slice(-100);
        else entry.ownReviewUntil = until;
        entry.ownInlineCredits = (entry.ownInlineCredits ?? 0) + inlineComments;
        entry.ownInlineUntil = until;
      });
    },
    snapshot(account: string): Record<string, PrReadState> {
      return Object.fromEntries(
        Object.entries(load(account).entries).flatMap(([url, entry]) =>
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
      );
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
          const entry = state.entries[receipt.url];
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
