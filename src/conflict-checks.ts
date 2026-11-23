import { Worker } from 'node:worker_threads';
import { comparisonTexts, NOISE_MAX_CHARACTERS, patchHunks } from '../lib/semantic-noise';
import {
  blockVerdict,
  verifyProposals,
  verifyWholeFile,
  type Analyse,
  type Equivalent,
  type Verdict,
} from '../lib/conflict-verify';
import { parseConflicts } from '../lib/conflict-blocks';
import { blockResolutions, heldProposals, restoreMarkers, withProposals } from '../lib/conflict-carry';
import type { ConflictFile, ConflictProposal } from '../lib/conflict-resolution';
import { movedProposal } from '../lib/conflict-moved';
import {
  SYNTAX_MAX_CHARACTERS,
  syntaxLanguage,
  type createSyntaxEngine,
  type SyntaxDefinition,
  type SyntaxLanguage,
} from '../lib/syntax-scope';
import type { NoiseAnswer, NoiseRequest } from '../lib/explanation-noise';
import { createPatch } from 'diff';

/**
 * The conflict checks (lib/conflict-verify.ts) in the main process (#445 item 3), so a session's buckets do not depend
 * on an open dialog. The checks parse with tree-sitter in a worker thread (src/conflict-check-worker.ts): a parse never
 * blocks the main process.
 *
 * A check that could not run (an error, a timeout, a stopped worker) answers undefined, never a verdict: the service
 * saves nothing for it, so the dialog checks the file itself and the next open checks it again.
 */
/** The draft (`result`) too: a conflict you decided in it is checked as the text you chose. */
export type CheckedFile = Pick<
  ConflictFile,
  'path' | 'base' | 'ours' | 'theirs' | 'original' | 'proposals' | 'wholeFile'
> &
  Partial<Pick<ConflictFile, 'result'>>;
type Engine = Pick<ReturnType<typeof createSyntaxEngine>, 'definitions' | 'equivalent'>;

/**
 * Takes back each 'same' proposal (#445 item 15) and each 'layout' proposal (lib/conflict-union.ts layoutMerge) that its
 * own check didn't Merge: it failed, or there is no verdict (an error, a timeout, a language that is off, a file over the
 * limits). Fail closed: such a conflict is yours to decide, or structural merge's proposal the layout one replaced is
 * offered again, in Check.
 * Where the draft still holds the proposal's text for it, Git's markers come back, and the file is no longer resolved;
 * a conflict you changed keeps your text. The fields to change on the file; undefined when there is nothing to take back.
 */
export function withoutUnconfirmed(
  file: Pick<ConflictFile, 'original' | 'result' | 'proposals' | 'source' | 'resolved'>,
  verdict: Verdict | undefined
): Pick<ConflictFile, 'proposals' | 'result' | 'source' | 'structuralNote' | 'resolved'> | undefined {
  const proposals = file.proposals;
  const drop = (proposals ?? []).flatMap((p, index) =>
    (p?.source === 'same' || p?.source === 'layout') && blockVerdict(verdict, index)?.merged !== true ? [index] : []
  );
  if (!proposals || !drop.length) return undefined;
  // A layout proposal that took structural merge's place gives it back (`instead`): that one is in Check again.
  const kept = proposals.map((p, index): ConflictProposal | null => {
    if (!drop.includes(index)) return p;
    return p?.source === 'layout' && p.instead !== undefined ? { source: 'mergiraf', text: p.instead } : null;
  });
  const segments = parseConflicts(file.original);
  const texts = blockResolutions(segments, file.result);
  const held = heldProposals(segments, file.result, proposals, texts);
  // Only when the draft splits back into its conflicts exactly (restoreMarkers): anything else is left as it is.
  const restore = held ? drop.filter((index) => held[index]) : [];
  const restored = texts && restore.length ? restoreMarkers(segments, texts, file.result, restore) : undefined;
  const prepared = file.result === withProposals(file.original, proposals);
  const left = kept.some(Boolean);
  return {
    proposals: left ? kept : undefined,
    result: restored ?? file.result,
    resolved: restored !== undefined ? false : file.resolved,
    source: prepared && !left && file.source === 'mergiraf' ? 'manual' : file.source,
    structuralNote: left ? undefined : 'Structural merge couldn’t combine this file.',
  };
}

/**
 * One file's proposals checked as the conflict dialog checks them: a whole-file proposal with verifyWholeFile, else
 * each conflict's proposal with verifyProposals. A language that is off in Settings, or a text over the limits, is not
 * parsed, as in the renderer's syntax worker.
 */
export function conflictChecker(engine: Engine, disabled: readonly SyntaxLanguage[] = []) {
  return async (file: CheckedFile): Promise<Verdict | undefined> => {
    // The checks turn a parse that throws into "couldn't parse". When the engine itself failed (the runtime, a grammar
    // or its wasm file), that verdict says nothing about the file: it is not kept. A tree with an ERROR node still
    // gives "doesn't parse".
    let failure: unknown;
    const failed = (error: unknown) => {
      failure ??= error;
      throw error;
    };
    const analyse: Analyse = async (...args) => {
      const [language, text] = args;
      if (disabled.includes(language)) throw Error('This language is off in Settings');
      if (text.length > SYNTAX_MAX_CHARACTERS) throw Error('This file is too large to parse');
      // Every argument and every field passes through, so the checks read what the renderer's worker answers.
      return engine.definitions(...args).catch(failed);
    };
    const equivalent: Equivalent = (language, before, after) => {
      if (disabled.includes(language)) return Promise.reject(Error('This language is off in Settings'));
      if (Math.max(before.length, after.length) > NOISE_MAX_CHARACTERS)
        return Promise.reject(Error('This file is too large to compare'));
      return engine.equivalent(language, before, after).catch(failed);
    };
    try {
      const verdict = await (file.wholeFile
        ? verifyWholeFile(file, file.wholeFile, analyse)
        : verifyProposals(file, analyse, false, equivalent));
      if (failure === undefined) return verdict;
    } catch (error) {
      failure ??= error;
    }
    console.warn(`[conflicts] The checks failed on ${file.path}.`, failure);
    return undefined;
  };
}

/** What the move rule reads of a file (lib/conflict-moved.ts). */
export type MovedFile = Pick<
  ConflictFile,
  'path' | 'base' | 'ours' | 'theirs' | 'original' | 'proposals' | 'unsupported'
>;
/**
 * The 'moved' proposal for a file (lib/conflict-moved.ts), with each side's moved-symbol candidates read by the syntax
 * engine as Changes reads them. A language that is off in Settings, or a text over the limits, proposes nothing; so
 * does a read that fails.
 */
export function moveProposer(
  engine: Pick<ReturnType<typeof createSyntaxEngine>, 'symbols'>,
  disabled: readonly SyntaxLanguage[] = []
) {
  return async (file: MovedFile): Promise<ConflictProposal | undefined> => {
    const language = syntaxLanguage(file.path);
    if (!language || disabled.includes(language)) return undefined;
    if ([file.base, file.ours, file.theirs].some((text) => text.length > SYNTAX_MAX_CHARACTERS)) return undefined;
    try {
      return await movedProposal(file, async (id, before, after) => {
        const hunks = patchHunks(createPatch(file.path, before, after, '', '', { context: 3 })) ?? [];
        return (await engine.symbols(id, { mode: 'modified', text: after, hunks })).prints;
      });
    } catch (error) {
      console.warn(`[conflicts] The move rule failed on ${file.path}.`, error);
      return undefined;
    }
  };
}

/** Where the worker finds the tree-sitter runtime and grammars: `src/assets/tree-sitter` in development. */
export interface TreeSitterFiles {
  runtime: string;
  grammars: string;
}
/**
 * The worker's jobs: a conflict check, the move rule's proposal for a file (moveProposer), or Reduce noise's syntax
 * comparison for an explanation's files (lib/explanation-noise.ts), which needs the same grammars.
 */
export type CheckRequest =
  | { id: number; kind?: 'check' | 'moved'; file: CheckedFile; disabled: SyntaxLanguage[] }
  /** A text's definitions, for a conflict's enclosing definition (lib/conflict-model.ts). */
  | { id: number; kind: 'definitions'; path: string; text: string; disabled: SyntaxLanguage[] }
  | { id: number; kind: 'noise'; files: NoiseFile[] };
/** One file for the noise comparison: its new text, its hunks, and whether to read its import nodes. */
export type NoiseFile = Pick<NoiseRequest, 'language' | 'after' | 'hunks' | 'imports'>;
export type CheckResponse =
  | { id: number; verdict?: Verdict }
  | { id: number; proposal?: ConflictProposal }
  | { id: number; noise: (NoiseAnswer | null)[] }
  | { id: number; definitions?: SyntaxDefinition[] }
  | { id: number; error: string };

interface Job {
  request: CheckRequest;
  /** The worker's answer, or undefined when it failed, ran out of time or stopped. */
  resolve: (response: CheckResponse | undefined) => void;
  timer?: ReturnType<typeof setTimeout>;
  /** Stops listening to the request's AbortSignal. */
  release?: () => void;
}
const jobLabel = (request: CheckRequest) =>
  request.kind === 'noise'
    ? `${request.files.length} files' noise comparison`
    : request.kind === 'definitions'
      ? request.path
      : request.file.path;

/**
 * A text's tree-sitter definitions, as the checks read them. A language that is off in Settings, a text over the
 * limits, or a file Gnosis has no grammar for has none.
 */
export async function definitionsOf(
  engine: Pick<ReturnType<typeof createSyntaxEngine>, 'definitions'>,
  path: string,
  text: string,
  disabled: readonly SyntaxLanguage[] = []
): Promise<SyntaxDefinition[] | undefined> {
  const language = syntaxLanguage(path);
  if (!language || disabled.includes(language) || text.length > SYNTAX_MAX_CHARACTERS) return undefined;
  try {
    return (await engine.definitions(language, text)).definitions;
  } catch {
    return undefined;
  }
}

/** Reduce noise's comparison of one file in the worker: change block kinds, and import nodes when asked. */
export async function noiseAnswer(
  engine: Pick<ReturnType<typeof createSyntaxEngine>, 'noise' | 'imports'>,
  file: NoiseFile
): Promise<NoiseAnswer | null> {
  try {
    const { blocks } = await engine.noise(file.language, file.after, file.hunks);
    const answer: NoiseAnswer = { kinds: blocks.map((block) => block.kind) };
    if (file.imports) {
      const texts = comparisonTexts(file.after, file.hunks);
      const before = texts && (await engine.imports(file.language, texts.before));
      const after = texts && (await engine.imports(file.language, texts.after));
      answer.imports = before && after ? { before, after } : null;
    }
    return answer;
  } catch {
    return null;
  }
}
/**
 * The worker that runs the checks, started on the first check and stopped after a minute without one, so its grammars
 * leave memory. One job at a time. A job that runs over 30 seconds, counted from when it starts, answers undefined;
 * the worker restarts for the jobs after it. So does a running job whose request is cancelled (#464): the next job
 * doesn't wait for a file nobody reads; a cancelled job that hasn't started never runs. A cancelled job answers
 * undefined, never a verdict.
 */
export function createConflictCheckWorker(
  script: string,
  files: () => TreeSitterFiles,
  idleMs = 60_000,
  timeoutMs = 30_000
) {
  let worker: Worker | undefined;
  let serial = 0;
  let disposed = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const queue: Job[] = [];
  let current: Job | undefined;
  const terminate = () => {
    const previous = worker;
    worker = undefined;
    previous?.removeAllListeners();
    void previous?.terminate();
  };
  /** Answers a job: its timer and its signal listener go. */
  const settle = (job: Job, response: CheckResponse | undefined) => {
    clearTimeout(job.timer);
    job.release?.();
    job.resolve(response);
  };
  /** Answers the running job, then starts the next. `restart`: the worker is stuck or gone, so a new one takes over. */
  const finish = (job: Job, response: CheckResponse | undefined, restart = false) => {
    if (current !== job) return;
    current = undefined;
    settle(job, response);
    if (restart) terminate();
    pump();
  };
  const start = () => {
    if (worker) return worker;
    const started = new Worker(script, { workerData: files() });
    started.on('message', (message: CheckResponse) => {
      if (!current || message.id !== current.request.id) return;
      if ('error' in message) console.warn('[conflicts] A check failed.', message.error);
      finish(current, 'error' in message ? undefined : message);
    });
    started.on('error', (error) => {
      console.warn('[conflicts] The check worker failed.', error);
      if (current) finish(current, undefined, true);
      else terminate();
    });
    started.on('exit', () => {
      if (worker !== started) return;
      worker = undefined;
      if (current) finish(current, undefined);
    });
    started.unref();
    worker = started;
    return started;
  };
  function pump() {
    if (current || disposed) return;
    const job = queue.shift();
    if (!job) {
      clearTimeout(idle);
      idle = setTimeout(terminate, idleMs);
      return;
    }
    clearTimeout(idle);
    current = job;
    job.timer = setTimeout(() => {
      console.warn(`[conflicts] The checks ran out of time on ${jobLabel(job.request)}.`);
      finish(job, undefined, true);
    }, timeoutMs);
    try {
      start().postMessage(job.request);
    } catch (error) {
      console.warn('[conflicts] The check worker did not start.', error);
      finish(job, undefined, true);
    }
  }
  const run = (request: CheckRequest, signal?: AbortSignal) =>
    new Promise<CheckResponse | undefined>((resolve) => {
      // After dispose, or for a request already cancelled, no job starts.
      if (disposed || signal?.aborted) {
        resolve(undefined);
        return;
      }
      const job: Job = { request, resolve };
      if (signal) {
        const cancel = () => {
          if (current === job) {
            finish(job, undefined, true);
            return;
          }
          const at = queue.indexOf(job);
          if (at < 0) return;
          queue.splice(at, 1);
          settle(job, undefined);
        };
        signal.addEventListener('abort', cancel, { once: true });
        job.release = () => signal.removeEventListener('abort', cancel);
      }
      queue.push(job);
      pump();
    });
  /** A conflict file's job: its check, or the move rule's proposal. */
  const ask = (file: CheckedFile, disabled: SyntaxLanguage[], kind: 'check' | 'moved', signal?: AbortSignal) => {
    const { path, base, ours, theirs, original, proposals, wholeFile, result } = file;
    return run(
      {
        id: ++serial,
        ...(kind === 'moved' ? { kind } : {}),
        file: { path, base, ours, theirs, original, proposals, wholeFile, result },
        disabled,
      },
      signal
    );
  };
  return {
    async check(
      file: CheckedFile,
      disabled: SyntaxLanguage[] = [],
      signal?: AbortSignal
    ): Promise<Verdict | undefined> {
      const response = await ask(file, disabled, 'check', signal);
      return response && 'verdict' in response ? response.verdict : undefined;
    },
    /** A text's definitions (definitionsOf), in the same worker, one job at a time with the checks. */
    async definitions(path: string, text: string, disabled: SyntaxLanguage[] = []) {
      const response = await run({ id: ++serial, kind: 'definitions', path, text, disabled });
      return response && 'definitions' in response ? response.definitions : undefined;
    },
    /** The move rule's proposal for a file (moveProposer), in the same worker, one job at a time with the checks. */
    async moved(
      file: CheckedFile,
      disabled: SyntaxLanguage[] = [],
      signal?: AbortSignal
    ): Promise<ConflictProposal | undefined> {
      const response = await ask(file, disabled, 'moved', signal);
      return response && 'proposal' in response ? response.proposal : undefined;
    },
    /**
     * Reduce noise's comparison of an explanation's files, one job per file so each has its own time limit. Fail
     * closed: a file that fails answers null; after a timeout, an error, a stopped worker or `signal`, the files not
     * yet classified answer null too, so no hunk of theirs is cut by the rules that need a syntax tree.
     */
    async noise(files: readonly NoiseFile[], signal?: AbortSignal): Promise<(NoiseAnswer | null)[]> {
      const answers: (NoiseAnswer | null)[] = files.map(() => null);
      for (const [index, { language, after, hunks, imports }] of files.entries()) {
        if (disposed || signal?.aborted) break;
        const response = await run(
          { id: ++serial, kind: 'noise', files: [{ language, after, hunks, imports }] },
          signal
        );
        if (!response || !('noise' in response) || response.noise.length !== 1) break;
        answers[index] = response.noise[0];
      }
      return answers;
    },
    dispose() {
      disposed = true;
      clearTimeout(idle);
      terminate();
      for (const job of [...(current ? [current] : []), ...queue.splice(0)]) settle(job, undefined);
      current = undefined;
    },
  };
}
