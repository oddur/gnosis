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
import type { SyntaxRequest, SyntaxResponse } from './syntax-scope.worker';
import { onInspectionForget, onInspectionUses } from './inspection-cache';
import { addDiagnosticsSource } from './diagnostics-sources';
import { traceStructure } from './structure-trace';
import { higherPriority, type SyntaxPriority } from './syntax-parse-queue';

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
 * Two workers on a machine with cores to spare: files on screen and near it parse in the front one, prefetched files
 * in the back one, so a file the reader looks at never waits behind a prefetched file's parse that has started. A
 * prefetched file that comes into view while its parse waits moves to the front worker. With fewer cores, one worker
 * does both, in the same order (lib/syntax-parse-queue.ts).
 */
type Lane = 'front' | 'back';
let split = typeof navigator !== 'undefined' && (navigator.hardwareConcurrency ?? 1) >= 4;
/** One worker or two, before any starts: for the browser checks, which compare them. */
export function setSyntaxWorkerSplit(value: boolean) {
  split = value;
}
const laneFor = (priority: SyntaxPriority): Lane => (split && priority === 'prefetch' ? 'back' : 'front');
const workers: Partial<Record<Lane, Promise<Worker | undefined>>> = {};
let nextId = 0;
const waiting = new Map<number, { resolve: (value: SyntaxDefinition[]) => void; reject: (error: Error) => void }>();
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
  const started = (workers[lane] ??= import('./syntax-scope.worker?worker&inline')
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
          entry.reject(Error(response.error));
        }
        else {
          entry.resolve(response.definitions);
          timings.get(response.id)?.(response.timing);
        }
      };
      instance.onerror = (event) => {
        event.preventDefault();
        for (const entry of waiting.values()) entry.reject(Error('The syntax worker stopped'));
        waiting.clear();
        if (workers[lane] === started) delete workers[lane];
      };
      return instance;
    })
    .catch(() => undefined));
  return started;
}
const eachWorker = (send: (instance: Worker) => void) => {
  for (const started of Object.values(workers)) void started?.then((instance) => instance && send(instance));
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
        void workers[lane]?.then((instance) =>
          instance?.postMessage({ type: 'take', key: request.key, id: message.id } satisfies SyntaxRequest)
        );
      } else if (lane)
        void workers[lane]?.then((instance) =>
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
        waiting.set(id, { resolve, reject });
        timings.set(id, (timing) => {
          timings.delete(id);
          if (after)
            traceStructure(file, {
              parseDone: performance.now(),
              workerWait: timing.wait,
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
