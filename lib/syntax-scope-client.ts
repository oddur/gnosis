import runtimeWasm from 'web-tree-sitter/web-tree-sitter.wasm?url';
import typescriptWasm from '../src/assets/tree-sitter/typescript.wasm?url';
import tsxWasm from '../src/assets/tree-sitter/tsx.wasm?url';
import javascriptWasm from '../src/assets/tree-sitter/javascript.wasm?url';
import rustWasm from '../src/assets/tree-sitter/rust.wasm?url';
import goWasm from '../src/assets/tree-sitter/go.wasm?url';
import pythonWasm from '../src/assets/tree-sitter/python.wasm?url';
import javaWasm from '../src/assets/tree-sitter/java.wasm?url';
import csharpWasm from '../src/assets/tree-sitter/csharp.wasm?url';
import jsonWasm from '../src/assets/tree-sitter/json.wasm?url';
import yamlWasm from '../src/assets/tree-sitter/yaml.wasm?url';
import type { SyntaxDefinition, SyntaxLanguage } from './syntax-scope';
import { blocksSignature, changeBlocks, type NoiseBlock } from './semantic-noise';
import type { SyntaxRequest, SyntaxResponse } from './syntax-scope.worker';
import { onInspectionForget, onInspectionUses } from './inspection-cache';
import { addDiagnosticsSource } from './diagnostics-sources';
import { traceStructure } from './structure-trace';
import { higherPriority, type SyntaxPriority } from './syntax-parse-queue';
import type { FilePrints, MoveFile, MovesResult } from './moved-symbols';
import type { SymbolsInput } from './syntax-scope';

/**
 * The page's side of the tree-sitter worker (#393). Grammars are assets of the renderer build, so they load offline
 * from the app; each loads in the worker the first time a file of its language needs it. Results are kept here too,
 * so a file shown again gets its scopes in the same render, without a round trip.
 */
const GRAMMARS: Record<SyntaxLanguage, string> = {
  typescript: typescriptWasm,
  tsx: tsxWasm,
  javascript: javascriptWasm,
  rust: rustWasm,
  go: goWasm,
  python: pythonWasm,
  java: javaWasm,
  csharp: csharpWasm,
  json: jsonWasm,
  yaml: yamlWasm,
};
/** Files larger than this are not parsed: their scopes are not worth the worker's time and memory. */
export const SYNTAX_MAX_CHARACTERS = 1_000_000;
/** The prefetch limit and a few recent PRs' files (#393). A definition list is a few KB. */
const MEMO_ENTRIES = 512;

type Timing = Extract<SyntaxResponse, { definitions: unknown }>['timing'];
/**
 * One worker parses every file, nearest the reader first (lib/syntax-parse-queue.ts). It can split in two: files on
 * screen and near it in a front worker, prefetched files in a back one, so a file the reader looks at never waits
 * behind a prefetched file's parse that has started; a waiting prefetch parse that comes into view moves to the front.
 * On the large-PR bench (tests/syntax-scope-browser.ts, GNOSIS_STRUCTURE_WORKERS=1,2) two workers were no faster once
 * parses were ordered, and each loads its own grammars, so it stays off.
 */
type Lane = 'front' | 'back';
let split = false;
/** One worker or two, before any starts: for the bench, which compares them. */
export function setSyntaxWorkerSplit(value: boolean) {
  split = value;
}
const laneFor = (priority: SyntaxPriority): Lane => (split && priority === 'prefetch' ? 'back' : 'front');
const workers = new Map<Lane, Promise<Worker | undefined>>();
let nextId = 0;
const waiting = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
// `at` is the entry's last use, so a PR whose definitions outlive its files is still swept when idle (#355).
const memo = new Map<string, { url: string; definitions: SyntaxDefinition[]; at: number }>();
interface Pending {
  url: string;
  promise: Promise<SyntaxDefinition[]>;
  priority: SyntaxPriority;
  /** The worker its parse went to, once it went. */
  lane?: Lane;
  /** What was sent, to send it to the front worker if it moves there. */
  message?: Extract<SyntaxRequest, { type: 'definitions' }>;
}
const pending = new Map<string, Pending>();
/** Parses asked to leave the back worker for the front one, by id: what to do if they did. */
const moving = new Map<number, () => void>();
/** The last parses, newest last, for the diagnostics export and the browser checks. */
export const syntaxTimings: (Timing & { key: string; language: SyntaxLanguage; characters: number })[] = [];

const absolute = (url: string) => new URL(url, document.baseURI).href;

function start(lane: Lane = 'front'): Promise<Worker | undefined> {
  const known = workers.get(lane);
  if (known) return known;
  const started: Promise<Worker | undefined> = import('./syntax-scope.worker?worker&inline')
    .then(({ default: SyntaxWorker }) => {
      const instance = new SyntaxWorker({ name: lane === 'front' ? 'gnosis-syntax' : 'gnosis-syntax-prefetch' });
      instance.onmessage = (event: MessageEvent<SyntaxResponse & { id: number }>) => {
        const response = event.data;
        if ('taken' in response) {
          const move = moving.get(response.id);
          moving.delete(response.id);
          // Not taken: its parse had started, and its answer comes from the back worker.
          if (response.taken) move?.();
          return;
        }
        const entry = waiting.get(response.id);
        if (!entry) return;
        waiting.delete(response.id);
        if ('error' in response) {
          timings.delete(response.id);
          noiseTimings.delete(response.id);
          symbolTimings.delete(response.id);
          entry.reject(Error(response.error));
        }
        else if ('noise' in response) {
          (entry.resolve as (value: Comparison) => void)({ blocks: response.noise, symbols: response.symbols, symbolsError: response.symbolsError });
          noiseTimings.get(response.id)?.(response.timing);
        } else if ('symbols' in response) {
          (entry.resolve as (value: FilePrints) => void)(response.symbols);
          symbolTimings.get(response.id)?.(response.timing);
        } else if ('moves' in response) {
          (entry.resolve as (value: MovesResult) => void)(response.moves);
        } else {
          (entry.resolve as (value: SyntaxDefinition[]) => void)(response.definitions);
          timings.get(response.id)?.(response.timing);
        }
      };
      instance.onerror = (event) => {
        event.preventDefault();
        for (const entry of waiting.values()) entry.reject(Error('The syntax worker stopped'));
        // Their timing callbacks hold the requests' texts: they go with them.
        for (const id of waiting.keys()) {
          timings.delete(id);
          noiseTimings.delete(id);
          symbolTimings.delete(id);
        }
        waiting.clear();
        if (workers.get(lane) === started) workers.delete(lane);
      };
      return instance;
    })
    .catch(() => undefined);
  workers.set(lane, started);
  return started;
}
const eachWorker = (send: (instance: Worker) => void) => {
  for (const started of workers.values()) void started.then((instance) => instance && send(instance));
};
const timings = new Map<number, (timing: Timing) => void>();

let languageAllowed: (language: SyntaxLanguage) => boolean = () => true;
/** Settings › Appearance › Code intelligence: a language that is off is never parsed (lib/code-intelligence.ts). */
export function setSyntaxLanguages(allowed: (language: SyntaxLanguage) => boolean) {
  languageAllowed = allowed;
}

/** Definitions already known for a file revision and side, or undefined. */
export function peekDefinitions(key: string): SyntaxDefinition[] | undefined {
  const entry = memo.get(key);
  if (!entry) return undefined;
  memo.delete(key);
  memo.set(key, entry);
  entry.at = Date.now();
  return entry.definitions;
}

/**
 * Loads the grammars of these languages in the worker while it has nothing to parse, and starts the worker, so the
 * first file of each language a PR shows does not wait for its grammar (#393). Languages that are off are left out.
 */
export function warmSyntax(languages: Iterable<SyntaxLanguage>) {
  const grammars = [...new Set(languages)]
    .filter((language) => languageAllowed(language))
    .map((language) => ({ language, grammarUrl: absolute(GRAMMARS[language]) }));
  if (!grammars.length) return;
  for (const lane of split ? (['front', 'back'] as const) : (['front'] as const))
    void start(lane).then((instance) =>
      instance?.postMessage({ type: 'warm', runtimeUrl: absolute(runtimeWasm), grammars } satisfies SyntaxRequest)
    );
}

/**
 * A file's definitions, parsed in the worker. Rejects for a file that could not parse, and when workers are not
 * available: the caller then shows the diff as it is. `priority` says where the file is (lib/syntax-parse-queue.ts):
 * the worker parses files on screen first, then files near the view, then prefetched ones. Asking again for a file
 * whose parse waits, at a higher priority, moves it up.
 */
export function readDefinitions(request: {
  key: string;
  url: string;
  language: SyntaxLanguage;
  text: string;
  priority?: SyntaxPriority;
}): Promise<SyntaxDefinition[]> {
  if (!languageAllowed(request.language)) return Promise.reject(Error('This language is off in Settings'));
  const known = peekDefinitions(request.key);
  if (known) return Promise.resolve(known);
  if (request.text.length > SYNTAX_MAX_CHARACTERS) return Promise.reject(Error('This file is too large to parse'));
  const priority = request.priority ?? 'view';
  const existing = pending.get(request.key);
  if (existing) {
    const raised = higherPriority(existing.priority, priority);
    if (raised !== existing.priority) {
      existing.priority = raised;
      const { lane, message } = existing;
      if (lane && message && lane !== laneFor(raised)) {
        // Waiting in the back worker: it leaves for the front one, unless its parse has started.
        existing.lane = laneFor(raised);
        moving.set(message.id, () => {
          void start(laneFor(raised)).then((instance) => {
            message.priority = existing.priority;
            instance?.postMessage(message);
          });
        });
        void workers.get(lane)?.then((instance) =>
          instance?.postMessage({ type: 'take', key: request.key, id: message.id } satisfies SyntaxRequest)
        );
      } else if (lane)
        void workers.get(lane)?.then((instance) =>
          instance?.postMessage({ type: 'priority', key: request.key, priority: raised } satisfies SyntaxRequest)
        );
    }
    return existing.promise;
  }
  const file = request.key.replace(/:(after|before)$/, '');
  const after = !request.key.endsWith(':before');
  if (after) traceStructure(file, { parseRequest: performance.now() });
  const lane = laneFor(priority);
  const promise = start(lane).then(
    (instance) =>
      new Promise<SyntaxDefinition[]>((resolve, reject) => {
        if (!instance) {
          reject(Error('The syntax worker is not available'));
          return;
        }
        const id = ++nextId;
        waiting.set(id, { resolve: resolve as (value: never) => void, reject });
        timings.set(id, (timing) => {
          timings.delete(id);
          if (after)
            traceStructure(file, {
              parseDone: performance.now(),
              workerWait: timing.wait,
              passedBy: timing.passedBy,
              load: timing.load,
              parse: timing.parse,
              query: timing.query,
            });
          else traceStructure(file, { beforeDone: performance.now() });
          if (after) traceStructure(file, { tier: timing.priority });
          syntaxTimings.push({
            ...timing,
            key: request.key,
            language: request.language,
            characters: request.text.length,
          });
          if (syntaxTimings.length > 50) syntaxTimings.shift();
        });
        if (after) traceStructure(file, { parsePosted: performance.now() });
        const entry = pending.get(request.key);
        const message = {
          type: 'definitions' as const,
          id,
          key: request.key,
          url: request.url,
          language: request.language,
          text: request.text,
          runtimeUrl: absolute(runtimeWasm),
          grammarUrl: absolute(GRAMMARS[request.language]),
          // A request that came in the meantime may have raised it.
          priority: entry?.priority ?? priority,
          side: after ? ('after' as const) : ('before' as const),
        } satisfies SyntaxRequest;
        if (entry?.promise === promise) {
          entry.message = message;
          entry.lane = laneFor(message.priority);
        }
        // Raised to the front while the back worker started.
        if (laneFor(message.priority) !== lane) void start(laneFor(message.priority)).then((front) => (front ?? instance).postMessage(message));
        else instance.postMessage(message);
      })
  );
  pending.set(request.key, { url: request.url, promise, priority });
  void promise.then(
    (definitions) => {
      // A parse whose PR left the caches while it ran answers its caller and keeps nothing.
      if (pending.get(request.key)?.promise !== promise) return;
      pending.delete(request.key);
      memo.set(request.key, { url: request.url, definitions, at: Date.now() });
      for (const key of memo.keys()) {
        if (memo.size <= MEMO_ENTRIES) break;
        memo.delete(key);
      }
    },
    () => {
      if (pending.get(request.key)?.promise === promise) pending.delete(request.key);
    }
  );
  return promise;
}

/**
 * Moves a file side's waiting parse up to `priority`, as asking for it again would, without a caller to answer. A
 * side that is parsed, or not asked for, is left alone.
 */
export function raiseDefinitions(key: string, priority: SyntaxPriority) {
  const existing = pending.get(key);
  if (!existing || higherPriority(existing.priority, priority) === existing.priority) return;
  existing.priority = priority;
  const { lane } = existing;
  if (lane) void workers.get(lane)?.then((instance) => instance?.postMessage({ type: 'priority', key, priority } satisfies SyntaxRequest));
}

/** Drops these PRs' definitions here and in the worker, with the rest of their inspection data (#355). */
export function forgetDefinitions(urls: ReadonlySet<string>) {
  for (const [key, entry] of memo) if (urls.has(entry.url)) memo.delete(key);
  for (const [key, entry] of pending) if (urls.has(entry.url)) pending.delete(key);
  eachWorker((instance) => instance.postMessage({ type: 'forget', urls: [...urls] } satisfies SyntaxRequest));
}
export function clearDefinitions() {
  memo.clear();
  pending.clear();
  eachWorker((instance) => instance.postMessage({ type: 'clear' } satisfies SyntaxRequest));
}
/** Entries kept on the page, for the diagnostics export. */
export const definitionStats = () => ({
  entries: memo.size,
  parsing: pending.size,
  prs: new Set([...memo.values(), ...pending.values()].map((entry) => entry.url)).size,
});
addDiagnosticsSource('syntaxDefinitions', definitionStats);

// Definitions leave with their PR's inspection data: a closed tab, an idle PR, or a cache reset (#355).
onInspectionForget((urls) => (urls ? forgetDefinitions(urls) : clearDefinitions()));
onInspectionUses((into) => {
  for (const { url, at } of memo.values()) if ((into.get(url) ?? -Infinity) < at) into.set(url, at);
});

// ── Formatting and comment comparison (#396) ────────────────────────────────

type NoiseTiming = Extract<SyntaxResponse, { noise: unknown }>['timing'];
const noiseTimings = new Map<number, (timing: NoiseTiming) => void>();
/** The last comparisons, newest last, for the diagnostics export and the browser checks. */
export const noiseClassifyTimings: (NoiseTiming & { key: string; language: SyntaxLanguage; characters: number })[] = [];
/**
 * Files larger than this are not compared: a comparison parses both sides in the one worker, and a long one would hold
 * up the next file's breadcrumbs.
 */
export const NOISE_MAX_CHARACTERS = 400_000;
type NoiseHunks = Extract<SyntaxRequest, { type: 'noise' }>['hunks'];
let symbolsWanted: (fileKey: string) => boolean = () => false;
/** Which files' whole comparisons fingerprint moved symbols too (lib/moved-symbols-store.ts). */
export function setSymbolsWanted(wanted: (fileKey: string) => boolean) {
  symbolsWanted = wanted;
}
/** A comparison: its blocks, and the file's moved-symbol candidates for a whole file's (#398). */
interface Comparison {
  blocks: NoiseBlock[];
  symbols?: FilePrints;
  /** Why candidates asked for are absent: the blocks stand regardless. */
  symbolsError?: string;
}
const noiseMemo = new Map<string, { url: string; blocks: NoiseBlock[]; symbols?: FilePrints; symbolsError?: string; at: number }>();
const noisePending = new Map<string, { url: string; promise: Promise<Comparison>; priority: SyntaxPriority; lane: Lane; symbols: boolean }>();
/** The newest whole-file comparison of each file revision, for views that list files (the file tree, the stats). */
const noiseByFile = new Map<string, { url: string; blocks: NoiseBlock[] }>();
const noiseListeners = new Set<() => void>();
let noiseVersion = 0;
const noiseChanged = () => {
  noiseVersion++;
  for (const listener of noiseListeners) listener();
};
/** Tells `listener` when a comparison lands or leaves; the return stops it. */
export function onNoise(listener: () => void): () => void {
  noiseListeners.add(listener);
  return () => noiseListeners.delete(listener);
}
export const noiseRevision = () => noiseVersion;

/** The key a comparison is kept under: the file revision and its change blocks, whatever context the view shows. */
export const noiseKey = (fileKey: string, hunks: readonly { oldStart: number; newStart: number; rows: readonly { type: ' ' | '+' | '-' }[] }[]) =>
  `${fileKey}:noise:${blocksSignature(changeBlocks(hunks.map((hunk) => ({ ...hunk, rows: hunk.rows.map((row) => ({ type: row.type, text: '' })) }))))}`;

/** A comparison already made, or undefined. */
export function peekNoise(key: string): NoiseBlock[] | undefined {
  const entry = noiseMemo.get(key);
  if (!entry) return undefined;
  entry.at = Date.now();
  return entry.blocks;
}
/** A file's newest whole-file comparison (Changes, prefetch), by its revision key. */
export const peekFileNoise = (fileKey: string) => noiseByFile.get(fileKey)?.blocks;

/**
 * Each change block of a file's hunks, compared in the worker (lib/semantic-noise.ts). `whole` says the hunks are the
 * file's whole patch, so the file tree and the stats can use the result. Rejects when the language is off, the file
 * too large, or the worker not available: the caller then hides nothing.
 */
export function readNoise(request: NoiseRequest): Promise<NoiseBlock[]> {
  return compare(request).then((comparison) => comparison.blocks);
}
type NoiseRequest = {
  fileKey: string;
  url: string;
  language: SyntaxLanguage;
  text: string;
  hunks: NoiseHunks;
  priority?: SyntaxPriority;
  whole?: boolean;
};
/**
 * A file's comparison, and with a whole file's, its moved-symbol candidates from the same two trees (#398): a file is
 * parsed once for both, whichever asks first.
 */
function compare(request: NoiseRequest): Promise<Comparison> {
  if (!languageAllowed(request.language)) return Promise.reject(Error('This language is off in Settings'));
  const key = noiseKey(request.fileKey, request.hunks);
  // A whole file's comparison also fingerprints moved symbols, for a file the moves store tracks and wants: not a
  // commit range's, a stack comparison's, or a file of a language without functions.
  const symbols = !!request.whole && symbolsWanted(request.fileKey);
  const known = noiseMemo.get(key);
  if (known && (!symbols || known.symbols || known.symbolsError)) {
    known.at = Date.now();
    return Promise.resolve({ blocks: known.blocks, symbols: known.symbols, symbolsError: known.symbolsError });
  }
  if (request.text.length > NOISE_MAX_CHARACTERS) return Promise.reject(Error('This file is too large to compare'));
  const priority = request.priority ?? 'view';
  const existing = noisePending.get(key);
  if (existing && (!symbols || existing.symbols)) {
    const raised = higherPriority(existing.priority, priority);
    if (raised !== existing.priority) {
      existing.priority = raised;
      void workers.get(existing.lane)?.then((instance) =>
        instance?.postMessage({ type: 'priority', key, priority: raised } satisfies SyntaxRequest)
      );
    }
    return existing.promise;
  }
  // Comparisons stay in the front worker: they are few, and moving one between workers is not worth it.
  const lane: Lane = 'front';
  const characters = request.text.length;
  const promise = start(lane).then(
    (instance) =>
      new Promise<Comparison>((resolve, reject) => {
        if (!instance) {
          reject(Error('The syntax worker is not available'));
          return;
        }
        const id = ++nextId;
        waiting.set(id, { resolve: resolve as (value: never) => void, reject });
        noiseTimings.set(id, (timing) => {
          noiseTimings.delete(id);
          noiseClassifyTimings.push({ ...timing, key, language: request.language, characters });
          if (noiseClassifyTimings.length > 50) noiseClassifyTimings.shift();
          if (symbols) countSymbolRead(timing.classify, timing.wait, timing.parses);
          else countParses(timing.parses);
        });
        const entry = noisePending.get(key);
        instance.postMessage({
          type: 'noise',
          id,
          key,
          url: request.url,
          language: request.language,
          text: request.text,
          hunks: request.hunks.map((hunk) => ({
            oldStart: hunk.oldStart,
            newStart: hunk.newStart,
            rows: hunk.rows.map((row) => ({ type: row.type, text: row.text })),
          })),
          runtimeUrl: absolute(runtimeWasm),
          grammarUrl: absolute(GRAMMARS[request.language]),
          priority: entry?.priority ?? priority,
          side: 'noise',
          symbols,
        } satisfies SyntaxRequest);
      })
  );
  noisePending.set(key, { url: request.url, promise, priority, lane, symbols });
  void promise.then(
    ({ blocks, symbols: prints, symbolsError }) => {
      if (noisePending.get(key)?.promise !== promise) return;
      noisePending.delete(key);
      noiseMemo.set(key, { url: request.url, blocks, symbols: prints, symbolsError, at: Date.now() });
      for (const old of noiseMemo.keys()) {
        if (noiseMemo.size <= MEMO_ENTRIES) break;
        noiseMemo.delete(old);
      }
      if (request.whole) {
        noiseByFile.delete(request.fileKey);
        noiseByFile.set(request.fileKey, { url: request.url, blocks });
        for (const old of noiseByFile.keys()) {
          if (noiseByFile.size <= MEMO_ENTRIES) break;
          noiseByFile.delete(old);
        }
      }
      noiseChanged();
    },
    () => {
      if (noisePending.get(key)?.promise === promise) noisePending.delete(key);
    }
  );
  return promise;
}
/** A waiting comparison moves up to `priority`, as its file comes nearer the view (raiseDefinitions). */
export function raiseNoise(key: string, priority: SyntaxPriority) {
  const existing = noisePending.get(key);
  if (!existing || higherPriority(existing.priority, priority) === existing.priority) return;
  existing.priority = priority;
  void workers.get(existing.lane)?.then((instance) => instance?.postMessage({ type: 'priority', key, priority } satisfies SyntaxRequest));
}
function forgetNoise(urls?: ReadonlySet<string>) {
  for (const [key, entry] of noiseMemo) if (!urls || urls.has(entry.url)) noiseMemo.delete(key);
  for (const [key, entry] of noisePending) if (!urls || urls.has(entry.url)) noisePending.delete(key);
  for (const [key, entry] of noiseByFile) if (!urls || urls.has(entry.url)) noiseByFile.delete(key);
  noiseChanged();
}
// Comparisons leave with their PR's inspection data, as definitions do (#355).
onInspectionForget((urls) => forgetNoise(urls));
onInspectionUses((into) => {
  for (const { url, at } of noiseMemo.values()) if ((into.get(url) ?? -Infinity) < at) into.set(url, at);
});
addDiagnosticsSource('semanticNoise', () => ({
  entries: noiseMemo.size,
  comparing: noisePending.size,
  timings: noiseClassifyTimings.slice(-10),
}));

// ── Moved and renamed symbols (#398) ────────────────────────────────────────

type SymbolTiming = Extract<SyntaxResponse, { symbols: unknown }>['timing'];
const symbolTimings = new Map<number, (timing: SymbolTiming) => void>();
/** Every fingerprint read since the page loaded: how many, and the worker time they took in all and at most. */
export const symbolReadTotals = { reads: 0, ms: 0, maxMs: 0, waitMs: 0 };
/** Files larger than this are not fingerprinted, as for the noise comparison: both sides parse in the one worker. */
export const SYMBOLS_MAX_CHARACTERS = NOISE_MAX_CHARACTERS;

/**
 * A file's moved-symbol candidates, fingerprinted in the worker (lib/moved-symbols.ts). A modified file's come from its
 * whole-file comparison's two trees (`compare`), so it is parsed once for both; an added or deleted file's one side is
 * parsed below every other parse. One read per key at a time. Rejects when the language is off, the file too large,
 * the hunks do not match the text, or the worker is not available. The caller keeps the result.
 */
export function readSymbols(request: {
  key: string;
  /** The file's revision key, under which its comparison is kept. */
  fileKey: string;
  url: string;
  language: SyntaxLanguage;
  input: SymbolsInput;
  priority?: SyntaxPriority;
}): Promise<FilePrints> {
  const { input } = request;
  // A whole-file comparison made or on its way already parses both sides: its trees give the candidates.
  if (input.mode === 'modified') {
    const key = noiseKey(request.fileKey, input.hunks);
    const known = noiseMemo.get(key);
    if (known?.symbols) return Promise.resolve(known.symbols);
    if (known?.symbolsError) return Promise.reject(Error(known.symbolsError));
    const pending = noisePending.get(key);
    if (pending?.symbols)
      return pending.promise.then(
        (comparison) => comparison.symbols ?? Promise.reject(Error(comparison.symbolsError ?? 'The file does not match its diff'))
      );
  }
  if (!languageAllowed(request.language)) return Promise.reject(Error('This language is off in Settings'));
  if (input.text.length > SYMBOLS_MAX_CHARACTERS) return Promise.reject(Error('This file is too large to compare'));
  const known = symbolsPending.get(request.key);
  if (known) return known;
  // The timing record keeps the size, not the request: the text is not held once the worker has it.
  const { key, language } = request;
  const promise = start('front').then(
    (instance) =>
      new Promise<FilePrints>((resolve, reject) => {
        if (!instance) {
          reject(Error('The syntax worker is not available'));
          return;
        }
        const id = ++nextId;
        waiting.set(id, { resolve: resolve as (value: never) => void, reject });
        symbolTimings.set(id, (timing) => {
          symbolTimings.delete(id);
          countSymbolRead(timing.ms, timing.wait, timing.parses);
        });
        instance.postMessage({
          type: 'symbols',
          id,
          key,
          url: request.url,
          language,
          input,
          runtimeUrl: absolute(runtimeWasm),
          grammarUrl: absolute(GRAMMARS[language]),
          priority: request.priority ?? 'prefetch',
          side: 'symbols',
        } satisfies SyntaxRequest);
      })
  );
  symbolsPending.set(key, promise);
  const done = () => {
    if (symbolsPending.get(key) === promise) symbolsPending.delete(key);
  };
  promise.then(done, done);
  return promise;
}
const symbolsPending = new Map<string, Promise<FilePrints>>();
/** Parses the worker made, as its last answer said (definitions, comparisons and moved symbols together). */
let workerParses = 0;
const countParses = (parses?: number) => {
  if (parses !== undefined) workerParses = Math.max(workerParses, parses);
};
function countSymbolRead(ms: number, wait?: number, parses?: number) {
  symbolReadTotals.reads++;
  symbolReadTotals.ms += ms;
  symbolReadTotals.maxMs = Math.max(symbolReadTotals.maxMs, ms);
  symbolReadTotals.waitMs += wait ?? 0;
  countParses(parses);
}
/** Parses the worker has made so far, for the cost checks. */
export const syntaxWorkerParses = () => workerParses;

/** A PR's moves, matched in the worker from its files' fingerprints, between two parses. */
export function readMoves(files: MoveFile[]): Promise<MovesResult> {
  return start('front').then(
    (instance) =>
      new Promise<MovesResult>((resolve, reject) => {
        if (!instance) {
          reject(Error('The syntax worker is not available'));
          return;
        }
        const id = ++nextId;
        waiting.set(id, { resolve: resolve as (value: never) => void, reject });
        instance.postMessage({ type: 'moves', id, files } satisfies SyntaxRequest);
      })
  );
}
