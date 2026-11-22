import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  MODEL_CONFLICTS_PER_SESSION,
  MODEL_STALE,
  createProposalQueue,
  modelTargets,
  openConflicts,
  type ConflictModelOutcome,
  type ConflictModelRequest,
  type ModelCard,
} from './conflict-model';
import type { EditTexts } from './conflict-blocks';
import type { ConflictFile, ConflictSession } from './conflict-resolution';
import { blockFingerprints } from './conflict-stats';

export { ModelProposalWaits } from './conflict-model';

/** A card belongs to one conflict: its file, its index and its text, so a fresh merge never shows an old card. */
const cardKey = (path: string, original: string, index: number) =>
  JSON.stringify([path, index, blockFingerprints(original)[index] ?? '']);
type Entry = ConflictModelRequest & { key: string };
/** A refusal's own words, without Electron's IPC prefix. */
const reasonOf = (error: unknown) =>
  (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^Error:\s*/, '');

/**
 * The workspace's model requests (#445 items 6 and 7). Nothing is sent until you choose "Ask <model> about N
 * conflicts": then every open conflict without a proposal is asked about, in parallel (the main process runs a few at a
 * time and asks each conflict once per draft), and each card shows a placeholder until its answer arrives. A proposal
 * goes into the draft through `apply`, one at a time and never during a request of yours. Your own choice on a conflict
 * cancels its request, and so does closing the view; leaving the Conflicts tab for another tab does not. A provider
 * pause skips the model and says so, until it ends.
 */
export function useConflictModel({
  session,
  file,
  contents,
  label,
  busy,
  apply,
  root,
  edits,
}: {
  session: ConflictSession | undefined;
  /** The open file, whose draft on screen is `contents`. */
  file: ConflictFile | undefined;
  contents: string;
  /** Your in-place edits of the open file, saved or not: an edited conflict is decided, the others stay askable. */
  edits?: EditTexts;
  /** The model's name for the placeholders, such as "Claude". */
  label: string;
  /** A request of yours is running: proposals wait for it. */
  busy: boolean;
  /** Puts a waiting proposal in the draft. Rejects with ModelProposalWaits to try again when `busy` ends. */
  apply: (path: string, index: number) => Promise<void>;
  /** The view's element: still in the document when the tab is only hidden. */
  root: RefObject<HTMLElement | null>;
}) {
  const [cards, setCards] = useState<Record<string, ModelCard>>({});
  const [notice, setNotice] = useState<{ text: string; until?: number }>();
  /** Answers delivered and handled, used or not: tests wait on it. */
  const [handled, setHandled] = useState(0);
  /** Requests still running, by card. */
  const live = useRef(new Map<string, ConflictModelRequest>());
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
  const show = (key: string, card: ModelCard) => setCards((previous) => ({ ...previous, [key]: card }));
  const queue = useRef(
    createProposalQueue<Entry>({
      apply: (entry) => applyRef.current(entry.path, entry.index),
      busy: () => busyRef.current,
      // A proposal the service refused says why on its card, instead of vanishing.
      done: (entry, refused) =>
        refused
          ? show(entry.key, { status: 'failed', by: labelRef.current, text: reasonOf(refused.reason) })
          : drop(entry.key),
    })
  ).current;
  const cancel = (key: string) => {
    const request = live.current.get(key) ?? queue.entries.find((entry) => entry.key === key);
    live.current.delete(key);
    queue.remove(key);
    if (request) void window.electronAPI.cancelConflictModel?.(request).catch(() => {});
    drop(key);
  };
  /** Cancels everything and forgets every card: the view closes, or the merge is prepared again. */
  function reset() {
    for (const key of [...live.current.keys(), ...queue.entries.map((entry) => entry.key)]) cancel(key);
    queue.clear();
    setCards({});
    setNotice(undefined);
  }
  useEffect(() => {
    if (!busy) void queue.flush();
  }, [busy]);
  // The pause notice leaves when the pause ends.
  useEffect(() => {
    if (notice?.until === undefined) return;
    const timer = setTimeout(() => setNotice(undefined), Math.max(0, notice.until - Date.now()));
    return () => clearTimeout(timer);
  }, [notice]);

  // Each file's conflicts to ask about, once per file version and draft: a keystroke re-reads only the open file.
  const targetCache = useRef(
    new WeakMap<ConflictFile, { draft: string; edits: EditTexts | undefined; targets: number[] }>()
  );
  const targetsOf = (f: ConflictFile, draft: string, own: EditTexts | undefined = f.edits) => {
    const hit = targetCache.current.get(f);
    if (hit?.draft === draft && hit.edits === own) return hit.targets;
    const targets = modelTargets({ ...f, result: draft, edits: own });
    targetCache.current.set(f, { draft, edits: own, targets });
    return targets;
  };
  const open = !!window.electronAPI.conflictModel && session?.status === 'editing' && !session.stale;
  const waiting = useMemo(() => {
    if (!open) return [];
    return session.files.flatMap((f) =>
      (f.path === file?.path ? targetsOf(f, contents, edits) : targetsOf(f, f.result))
        .filter((index) => {
          const card = cards[cardKey(f.path, f.original, index)] as ModelCard | undefined;
          // A failed request can be asked again; an answer or a request still running can't.
          return !card || card.status === 'failed';
        })
        .map((index) => ({ path: f.path, original: f.original, index }))
    );
  }, [open, session, file, contents, cards, edits]);

  /** Asks about every conflict that waits: the one click that sends anything. */
  function askAll() {
    const ask = window.electronAPI.conflictModel;
    if (!ask || !session) return;
    const id = session.id;
    for (const { path, original, index } of waiting.slice(0, MODEL_CONFLICTS_PER_SESSION)) {
      const key = cardKey(path, original, index);
      const request = { id, path, index };
      live.current.set(key, request);
      show(key, { status: 'asking', by: label });
      void ask(request).then(
        (outcome: ConflictModelOutcome | undefined) => {
          setHandled((n) => n + 1);
          // Cancelled meanwhile, by your choice or by closing the view.
          if (live.current.get(key) !== request) return;
          live.current.delete(key);
          if (!outcome || typeof outcome !== 'object') {
            drop(key);
            return;
          }
          // An answer shows the provider is available again.
          if (outcome.status === 'proposal' || outcome.status === 'question') setNotice(undefined);
          if (outcome.status === 'proposal') {
            queue.push({ ...request, key });
            return;
          }
          if (outcome.status === 'paused') setNotice({ text: outcome.notice, until: outcome.until });
          if (outcome.status === 'question' || outcome.status === 'failed' || outcome.status === 'skipped')
            show(key, {
              status: outcome.status,
              by: label,
              text: outcome.status === 'question' ? outcome.question : outcome.reason,
            } as ModelCard);
          else drop(key);
        },
        () => {
          setHandled((n) => n + 1);
          if (live.current.get(key) !== request) return;
          live.current.delete(key);
          show(key, { status: 'failed', by: label, text: `Couldn’t ask ${label} about this conflict.` });
        }
      );
    }
  }

  // Your choice on a conflict cancels its request, and a proposal waiting for it. Nothing to read when nothing waits.
  useEffect(() => {
    if (!file || (!live.current.size && !queue.entries.length)) return;
    const openNow = openConflicts(file.original, contents, file.proposals, edits);
    for (const [key, request] of [...live.current, ...queue.entries.map((entry) => [entry.key, entry] as const)])
      if (request.path === file.path && !openNow?.has(request.index)) cancel(key);
  }, [file, contents, edits]);

  // Closing the view cancels every request. Another tab only hides it (React Activity runs this cleanup too, with the
  // view still in the document): requests keep running, and their proposals arrive when you come back.
  useEffect(() => {
    const element = root.current;
    return () => {
      if (element?.isConnected) return;
      reset();
    };
  }, []);

  const byFile = useMemo(() => {
    const files: Record<string, Record<string, ModelCard>> = {};
    for (const [key, card] of Object.entries(cards)) {
      const [path] = JSON.parse(key) as [string, number, string];
      (files[path] ??= {})[key] = card;
    }
    return files;
  }, [cards]);
  return {
    /**
     * The cards of a file's conflicts, by index, for this version of the file only. A conflict whose model proposal was
     * from before main moved (ConflictFile.modelStale) says to ask again.
     */
    cards(f: ConflictFile): Readonly<Record<number, ModelCard>> | undefined {
      const own = byFile[f.path] ?? {};
      const result: Record<number, ModelCard> = {};
      for (const index of f.modelStale ?? []) result[index] = { status: 'skipped', by: label, text: MODEL_STALE };
      for (const index of blockFingerprints(f.original).keys()) {
        const card = own[cardKey(f.path, f.original, index)] as ModelCard | undefined;
        if (card) result[index] = card;
      }
      return Object.keys(result).length ? result : undefined;
    },
    notice: notice?.text ?? '',
    /** Conflicts "Ask <model>" would send, at most MODEL_CONFLICTS_PER_SESSION. */
    waiting: Math.min(waiting.length, MODEL_CONFLICTS_PER_SESSION),
    askAll,
    reset,
    handled,
  };
}
