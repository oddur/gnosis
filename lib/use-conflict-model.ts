import { useEffect, useMemo, useRef, useState } from 'react';
import {
  MODEL_CONFLICTS_PER_SESSION,
  modelTargets,
  openConflicts,
  type ConflictModelOutcome,
  type ConflictModelRequest,
  type ModelCard,
} from './conflict-model';
import type { ConflictFile, ConflictSession } from './conflict-resolution';
import { blockFingerprints } from './conflict-stats';

/** A request of yours holds the draft: the proposal waits until it is done. */
export class ModelProposalWaits extends Error {}

const cardKey = (path: string, index: number) => JSON.stringify([path, index]);

/**
 * The workspace's model requests (#445 items 6 and 7): every open conflict without a proposal is asked about once, in
 * parallel (the main process runs a few at a time), and each card shows a placeholder until its answer arrives. A
 * proposal goes into the draft through `apply`, one at a time and never during a request of yours. Your own choice on a
 * conflict cancels its request; closing the view cancels them all. A provider pause skips the model and says so.
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
  /** Each conflict asked about, with its fingerprint: asked once. */
  const asked = useRef(new Map<string, string>());
  /** Requests still running, by card. */
  const live = useRef(new Map<string, ConflictModelRequest>());
  const queue = useRef<ConflictModelRequest[]>([]);
  const flushing = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const labelRef = useRef(label);
  labelRef.current = label;
  const drop = (key: string) =>
    setCards((previous) =>
      key in previous ? Object.fromEntries(Object.entries(previous).filter(([k]) => k !== key)) : previous
    );
  const cancel = (key: string) => {
    const request = live.current.get(key) ?? queue.current.find((q) => cardKey(q.path, q.index) === key);
    live.current.delete(key);
    queue.current = queue.current.filter((q) => cardKey(q.path, q.index) !== key);
    if (request) void window.electronAPI.cancelConflictModel?.(request).catch(() => {});
    drop(key);
  };
  async function flush() {
    if (flushing.current) return;
    flushing.current = true;
    try {
      while (queue.current.length && !busyRef.current) {
        const next = queue.current[0];
        const key = cardKey(next.path, next.index);
        try {
          await applyRef.current(next.path, next.index);
        } catch (error) {
          if (error instanceof ModelProposalWaits) break;
          // The conflict changed or you decided it: the proposal is not used.
        }
        queue.current.shift();
        drop(key);
      }
    } finally {
      flushing.current = false;
    }
  }
  useEffect(() => {
    if (!busy) void flush();
  }, [busy]);

  // Ask about every open conflict without a proposal, once.
  useEffect(() => {
    const ask = window.electronAPI.conflictModel;
    if (!ask || !session || session.status !== 'editing' || session.stale) return;
    const id = session.id;
    for (const f of session.files) {
      // The open file's draft on screen: a choice not saved yet is already yours.
      const draft = f.path === file?.path ? { ...f, result: contents } : f;
      const keys = blockFingerprints(f.original);
      for (const index of modelTargets(draft)) {
        const key = cardKey(f.path, index);
        if (asked.current.get(key) === keys[index]) continue;
        if (asked.current.size >= MODEL_CONFLICTS_PER_SESSION) return;
        asked.current.set(key, keys[index]);
        const request = { id, path: f.path, index };
        live.current.set(key, request);
        setCards((previous) => ({ ...previous, [key]: { status: 'asking', by: labelRef.current } }));
        void ask(request).then(
          (outcome: ConflictModelOutcome | undefined) => {
            // Cancelled meanwhile, by your choice or a new request for the same conflict.
            if (live.current.get(key) !== request) return;
            live.current.delete(key);
            if (!outcome || typeof outcome !== 'object') {
              drop(key);
              return;
            }
            if (outcome.status === 'proposal') {
              queue.current.push(request);
              void flush();
              return;
            }
            if (outcome.status === 'paused') setNotice(outcome.notice);
            if (outcome.status === 'question' || outcome.status === 'failed' || outcome.status === 'skipped')
              setCards((previous) => ({
                ...previous,
                [key]: {
                  status: outcome.status,
                  by: labelRef.current,
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
              [key]: { status: 'failed', by: labelRef.current, text: `Couldn’t ask ${labelRef.current} about this conflict.` },
            }));
          }
        );
      }
    }
  }, [session]);

  // Your choice on a conflict cancels its request, and a proposal waiting for it.
  useEffect(() => {
    if (!file) return;
    const open = openConflicts(file.original, contents, file.proposals);
    for (const [key, request] of [...live.current, ...queue.current.map((q) => [cardKey(q.path, q.index), q] as const)])
      if (request.path === file.path && !open?.has(request.index)) cancel(key);
  }, [file, contents]);

  // Closing the view cancels every request.
  useEffect(
    () => () => {
      for (const key of [...live.current.keys()]) cancel(key);
      queue.current = [];
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
  };
}
