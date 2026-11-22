import { useEffect, useMemo, useRef, useState } from 'react';
import {
  MODEL_CONFLICTS_PER_SESSION,
  createProposalQueue,
  modelTargets,
  openConflicts,
  type ConflictModelOutcome,
  type ConflictModelRequest,
  type ModelCard,
} from './conflict-model';
import type { ConflictFile, ConflictSession } from './conflict-resolution';

export { ModelProposalWaits } from './conflict-model';

const cardKey = (path: string, index: number) => JSON.stringify([path, index]);
type Entry = ConflictModelRequest & { key: string };

/**
 * The workspace's model requests (#445 items 6 and 7). Nothing is sent until you choose "Ask <model> about N
 * conflicts": then every open conflict without a proposal is asked about, in parallel (the main process runs a few at a
 * time and asks each conflict once per draft), and each card shows a placeholder until its answer arrives. A proposal
 * goes into the draft through `apply`, one at a time and never during a request of yours. Your own choice on a conflict
 * cancels its request; closing the view cancels them all. A provider pause skips the model and says so.
 */
export function useConflictModel({
  session,
  file,
  contents,
  label,
  busy,
  apply,
}: {
  session: ConflictSession | undefined;
  /** The open file, whose draft on screen is `contents`. */
  file: ConflictFile | undefined;
  contents: string;
  /** The model's name for the placeholders, such as "Claude". */
  label: string;
  /** A request of yours is running: proposals wait for it. */
  busy: boolean;
  /** Puts a waiting proposal in the draft. Rejects with ModelProposalWaits to try again when `busy` ends. */
  apply: (path: string, index: number) => Promise<void>;
}) {
  const [cards, setCards] = useState<Record<string, ModelCard>>({});
  const [notice, setNotice] = useState('');
  /** Requests still running, by card. */
  const live = useRef(new Map<string, ConflictModelRequest>());
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const drop = (key: string) =>
    setCards((previous) =>
      key in previous ? Object.fromEntries(Object.entries(previous).filter(([k]) => k !== key)) : previous
    );
  const queue = useRef(
    createProposalQueue<Entry>({
      apply: (entry) => applyRef.current(entry.path, entry.index),
      busy: () => busyRef.current,
      done: (entry) => drop(entry.key),
    })
  ).current;
  const cancel = (key: string) => {
    const request = live.current.get(key) ?? queue.entries.find((entry) => entry.key === key);
    live.current.delete(key);
    queue.remove(key);
    if (request) void window.electronAPI.cancelConflictModel?.(request).catch(() => {});
    drop(key);
  };
  useEffect(() => {
    if (!busy) void queue.flush();
  }, [busy]);

  // Each file's conflicts to ask about, once per file version and draft: a keystroke re-reads only the open file.
  const targetCache = useRef(new WeakMap<ConflictFile, { draft: string; targets: number[] }>());
  const targetsOf = (f: ConflictFile, draft: string) => {
    const hit = targetCache.current.get(f);
    if (hit?.draft === draft) return hit.targets;
    const targets = modelTargets({ ...f, result: draft });
    targetCache.current.set(f, { draft, targets });
    return targets;
  };
  const open = !!window.electronAPI.conflictModel && session?.status === 'editing' && !session.stale;
  const waiting = useMemo(() => {
    if (!open) return [];
    return session.files.flatMap((f) =>
      targetsOf(f, f.path === file?.path ? contents : f.result)
        .filter((index) => !(cardKey(f.path, index) in cards))
        .map((index) => ({ path: f.path, index }))
    );
  }, [open, session, file, contents, cards]);

  /** Asks about every conflict that waits: the one click that sends anything. */
  function askAll() {
    const ask = window.electronAPI.conflictModel;
    if (!ask || !session) return;
    const id = session.id;
    for (const { path, index } of waiting.slice(0, MODEL_CONFLICTS_PER_SESSION)) {
      const key = cardKey(path, index);
      const request = { id, path, index };
      live.current.set(key, request);
      setCards((previous) => ({ ...previous, [key]: { status: 'asking', by: label } }));
      void ask(request).then(
        (outcome: ConflictModelOutcome | undefined) => {
          // Cancelled meanwhile, by your choice or by closing the view.
          if (live.current.get(key) !== request) return;
          live.current.delete(key);
          if (!outcome || typeof outcome !== 'object') {
            drop(key);
            return;
          }
          if (outcome.status === 'proposal') {
            queue.push({ ...request, key });
            return;
          }
          if (outcome.status === 'paused') setNotice(outcome.notice);
          if (outcome.status === 'question' || outcome.status === 'failed' || outcome.status === 'skipped')
            setCards((previous) => ({
              ...previous,
              [key]: {
                status: outcome.status,
                by: label,
                text: outcome.status === 'question' ? outcome.question : outcome.reason,
              } as ModelCard,
            }));
          else drop(key);
        },
        () => {
          if (live.current.get(key) !== request) return;
          live.current.delete(key);
          setCards((previous) => ({
            ...previous,
            [key]: { status: 'failed', by: label, text: `Couldn’t ask ${label} about this conflict.` },
          }));
        }
      );
    }
  }

  // Your choice on a conflict cancels its request, and a proposal waiting for it. Nothing to read when nothing waits.
  useEffect(() => {
    if (!file || (!live.current.size && !queue.entries.length)) return;
    const open = openConflicts(file.original, contents, file.proposals);
    for (const [key, request] of [...live.current, ...queue.entries.map((entry) => [entry.key, entry] as const)])
      if (request.path === file.path && !open?.has(request.index)) cancel(key);
  }, [file, contents]);

  // Closing the view cancels every request.
  useEffect(
    () => () => {
      for (const key of [...live.current.keys()]) cancel(key);
      queue.clear();
    },
    []
  );

  /** The open conflicts' cards in a file, by index. */
  const byFile = useMemo(() => {
    const files: Record<string, Record<number, ModelCard>> = {};
    for (const [key, card] of Object.entries(cards)) {
      const [path, index] = JSON.parse(key) as [string, number];
      (files[path] ??= {})[index] = card;
    }
    return files;
  }, [cards]);
  return {
    cards: (path: string): Readonly<Record<number, ModelCard>> | undefined => byFile[path],
    notice,
    /** Conflicts "Ask <model>" would send, at most MODEL_CONFLICTS_PER_SESSION. */
    waiting: Math.min(waiting.length, MODEL_CONFLICTS_PER_SESSION),
    askAll,
  };
}
