import * as TreeSitter from 'web-tree-sitter';
import { createSyntaxEngine, type SyntaxDefinition, type SyntaxLanguage, type SymbolsInput } from './syntax-scope';
import type { NoiseBlock } from './semantic-noise';
import { matchMoves, type FilePrints, type MoveFile, type MovesResult } from './moved-symbols';
import { createFollowers, createParseQueue, type SyntaxPriority } from './syntax-parse-queue';
import javascriptTags from '../src/assets/tree-sitter/javascript-tags.scm?raw';
import typescriptTags from '../src/assets/tree-sitter/typescript-tags.scm?raw';
import rustTags from '../src/assets/tree-sitter/rust-tags.scm?raw';
import goTags from '../src/assets/tree-sitter/go-tags.scm?raw';
import pythonTags from '../src/assets/tree-sitter/python-tags.scm?raw';
import javaTags from '../src/assets/tree-sitter/java-tags.scm?raw';
import csharpTags from '../src/assets/tree-sitter/csharp-tags.scm?raw';

/**
 * The tree-sitter worker (#393): parses files and answers their definitions, so no parse runs on the renderer's main
 * thread. Grammars load on demand from the URLs the page sends; definitions are cached per file revision, bounded,
 * and dropped with their PR's inspection data (lib/inspection-cache.ts `forgetInspection`).
 */
export type SyntaxRequest =
  | {
      type: 'definitions';
      id: number;
      /** A file revision and side, such as `fileRevisionKey(...) + ':after'`. */
      key: string;
      /** The PR, so its entries leave with its inspection data. */
      url: string;
      language: SyntaxLanguage;
      text: string;
      runtimeUrl: string;
      grammarUrl: string;
      /** Where the file is: on screen, near it, or prefetched (lib/syntax-parse-queue.ts). */
      priority: SyntaxPriority;
      side: 'after' | 'before';
    }
  /**
   * Formatting-only and comment-only changes (#396): both sides of a file parsed and compared, from the new side's
   * text and the hunks (lib/semantic-noise.ts). It queues with the parses, below its file's own.
   */
  | {
      type: 'noise';
      id: number;
      /** A file revision and its change blocks, such as `fileRevisionKey(...) + ':noise:' + signature`. */
      key: string;
      url: string;
      language: SyntaxLanguage;
      text: string;
      hunks: { oldStart: number; newStart: number; rows: { type: ' ' | '+' | '-'; text: string }[] }[];
      runtimeUrl: string;
      grammarUrl: string;
      priority: SyntaxPriority;
      side: 'noise';
      /** Also fingerprint the file's moved-symbol candidates from the same two trees (#398): no parse of its own. */
      symbols?: boolean;
    }
  /**
   * Moved and renamed symbols (#398): one file's candidates and their fingerprints (lib/moved-symbols.ts), from its
   * new side and hunks, or the one side of an added or deleted file. It queues below every other parse.
   */
  | {
      type: 'symbols';
      id: number;
      /** A file revision, such as `fileRevisionKey(...) + ':symbols'`. */
      key: string;
      url: string;
      language: SyntaxLanguage;
      input: SymbolsInput;
      runtimeUrl: string;
      grammarUrl: string;
      priority: SyntaxPriority;
      side: 'symbols';
    }
  /** A PR's moves, from its files' fingerprints: matched in the queue, below every parse. */
  | { type: 'moves'; id: number; files: MoveFile[] }
  /** The view came nearer a file whose parse waits: it moves up to `priority`. */
  | { type: 'priority'; key: string; priority: SyntaxPriority }
  /** The parse moves to the other worker, if it has not started here: the answer says whether it was taken. */
  | { type: 'take'; key: string; id: number }
  /** Loads these grammars while no parse waits, so a PR's first parse of each language does not load one. */
  | { type: 'warm'; runtimeUrl: string; grammars: { language: SyntaxLanguage; grammarUrl: string }[] }
  | { type: 'forget'; urls: string[] }
  | { type: 'clear' };
export type SyntaxResponse =
  | {
      id: number;
      definitions: SyntaxDefinition[];
      /** `wait` is the time in the queue; `priority`, the tier the parse ran at. */
      timing: {
        parse: number;
        query: number;
        load?: number;
        cached: boolean;
        wait?: number;
        priority?: SyntaxPriority;
        /** Parses the worker has made in all, for the cost checks. */
        parses?: number;
      };
    }
  | {
      id: number;
      noise: NoiseBlock[];
      /** The file's moved-symbol candidates, when asked for; absent when the hunks do not match the text. */
      symbols?: FilePrints;
      /** Why they were asked for and are absent. */
      symbolsError?: string;
      timing: { classify: number; load?: number; cached: boolean; wait?: number; priority?: SyntaxPriority; parses?: number };
    }
  | {
      id: number;
      symbols: FilePrints;
      timing: { ms: number; load?: number; cached: boolean; wait?: number; priority?: SyntaxPriority; parses?: number };
    }
  | { id: number; moves: MovesResult }
  | { id: number; error: string }
  | { id: number; taken: boolean };

const TAGS: Record<string, string> = {
  javascript: javascriptTags,
  typescript: typescriptTags,
  rust: rustTags,
  go: goTags,
  python: pythonTags,
  java: javaTags,
  csharp: csharpTags,
};
/** Files whose definitions this worker keeps. A definition list is a few KB; trees are not kept. */
const CACHE_ENTRIES = 512;

/** A file's bytes. fetch reads http and blob URLs; a file:// URL in the packaged app may need XMLHttpRequest. */
async function bytes(url: string): Promise<Uint8Array> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (!url.startsWith('file:')) throw error;
    return await new Promise<Uint8Array>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('GET', url);
      request.responseType = 'arraybuffer';
      request.onload = () =>
        request.response
          ? resolve(new Uint8Array(request.response as ArrayBuffer))
          : reject(Error(`Could not read ${url}`));
      request.onerror = () => reject(Error(`Could not read ${url}`));
      request.send();
    });
  }
}

let runtimeUrl = '';
const grammarUrls = new Map<SyntaxLanguage, string>();
const engine = createSyntaxEngine(TreeSitter, {
  runtime: () => bytes(runtimeUrl),
  grammar: (language) => bytes(grammarUrls.get(language) ?? ''),
  tags: (name) => Promise.resolve(TAGS[name] ?? ''),
});
const cache = new Map<string, { url: string; definitions: SyntaxDefinition[] }>();
/** Comparisons, by file revision and change blocks: a few bytes per block. */
const noiseCache = new Map<string, { url: string; noise: NoiseBlock[]; symbols?: FilePrints; symbolsError?: string }>();
type MovesJob = Extract<SyntaxRequest, { type: 'moves' }> & { key: string; priority: SyntaxPriority; side: 'symbols' };
type Job = (Extract<SyntaxRequest, { type: 'definitions' | 'noise' | 'symbols' }> | MovesJob) & { received: number };
/** Requests a newer job with the same key replaced in the queue: they hear that job's answer (createFollowers). */
const followers = createFollowers();
function enqueue(job: Job) {
  const replaced = queue.add(job);
  if (replaced) followers.replace(job.id, replaced.id);
  void drain();
}
/** Answers a job's request and every request it replaced. */
function answer(job: Job, response: Omit<SyntaxResponse, 'id'>) {
  for (const id of followers.answer(job.id)) self.postMessage({ id, ...response } as SyntaxResponse);
}
const failed = (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) });
// One parse at a time, nearest the reader first (lib/syntax-parse-queue.ts); a cached file answers at once.
const queue = createParseQueue<Job>();
/** Grammars to load once no parse waits. */
const warming: SyntaxLanguage[] = [];
let draining = false;
/** Lets messages that came during a parse (a file on screen, a raised priority) in before the next parse starts. */
const yieldToMessages = () =>
  new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });

async function run(job: Job) {
  const wait = performance.now() - job.received;
  if (job.type === 'moves') {
    try {
      answer(job, { moves: matchMoves(job.files) });
    } catch (error) {
      answer(job, failed(error));
    }
    return;
  }
  if (job.type === 'symbols') {
    try {
      const result = await engine.symbols(job.language, job.input);
      // Kept on the page only (lib/moved-symbols-store.ts): the worker has nothing to answer twice.
      answer(job, {
        symbols: result.prints,
        timing: { ms: result.ms, load: result.load, cached: false, wait, priority: job.priority, parses: engine.parses() },
      });
    } catch (error) {
      answer(job, failed(error));
    }
    return;
  }
  if (job.type === 'noise') {
    try {
      const result = await engine.noise(job.language, job.text, job.hunks, !!job.symbols);
      noiseCache.set(job.key, { url: job.url, noise: result.blocks, symbols: result.symbols, symbolsError: result.symbolsError });
      for (const key of noiseCache.keys()) {
        if (noiseCache.size <= CACHE_ENTRIES) break;
        noiseCache.delete(key);
      }
      answer(job, {
        noise: result.blocks,
        symbols: result.symbols,
        symbolsError: result.symbolsError,
        timing: { classify: result.classify, load: result.load, cached: false, wait, priority: job.priority, parses: engine.parses() },
      });
    } catch (error) {
      answer(job, failed(error));
    }
    return;
  }
  try {
    const result = await engine.definitions(job.language, job.text);
    cache.set(job.key, { url: job.url, definitions: result.definitions });
    for (const key of cache.keys()) {
      if (cache.size <= CACHE_ENTRIES) break;
      cache.delete(key);
    }
    answer(job, {
      definitions: result.definitions,
      timing: {
        parse: result.parse,
        query: result.query,
        load: result.load,
        cached: false,
        wait,
        priority: job.priority,
        parses: engine.parses(),
      },
    });
  } catch (error) {
    answer(job, failed(error));
  }
}
async function drain() {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      await yieldToMessages();
      const job = queue.take();
      const grammar = job ? undefined : warming.shift();
      if (job) await run(job);
      else if (grammar) await engine.warm(grammar).catch(() => {});
      else break;
    }
  } finally {
    draining = false;
  }
}

self.onmessage = (event: MessageEvent<SyntaxRequest>) => {
  const message = event.data;
  if (message.type === 'forget' || message.type === 'clear') {
    const urls = message.type === 'forget' ? new Set(message.urls) : undefined;
    for (const [key, entry] of cache) if (!urls || urls.has(entry.url)) cache.delete(key);
    for (const [key, entry] of noiseCache) if (!urls || urls.has(entry.url)) noiseCache.delete(key);
    // Parses that wait still run and answer their callers: another view (an Explanation topic) may show the file.
    return;
  }
  if (message.type === 'priority') {
    queue.raise(message.key, message.priority);
    return;
  }
  if (message.type === 'take') {
    const removed = queue.remove((job) => job.key === message.key);
    // Requests the taken job had replaced are not answered by the other worker: they end here.
    // Only jobs actually taken: a running job with the same key still answers the requests it replaced.
    for (const job of removed)
      for (const id of followers.drop(job.id)) self.postMessage({ id, error: 'The parse moved to the other worker' } satisfies SyntaxResponse);
    self.postMessage({ id: message.id, taken: removed.length > 0 } satisfies SyntaxResponse);
    return;
  }
  if (message.type === 'warm') {
    runtimeUrl ||= message.runtimeUrl;
    for (const { language, grammarUrl } of message.grammars) {
      grammarUrls.set(language, grammarUrl);
      if (!warming.includes(language)) warming.push(language);
    }
    void drain();
    return;
  }
  if (message.type === 'moves') {
    // Matched at the lowest tier, between parses: breadcrumbs never wait for a large refactor's match.
    enqueue({ ...message, key: `moves:${message.id}`, priority: 'prefetch', side: 'symbols', received: performance.now() });
    return;
  }
  if (message.type === 'symbols') {
    runtimeUrl ||= message.runtimeUrl;
    grammarUrls.set(message.language, message.grammarUrl);
    enqueue({ ...message, received: performance.now() });
    return;
  }
  if (message.type === 'noise') {
    const known = noiseCache.get(message.key);
    if (known && (!message.symbols || known.symbols || known.symbolsError)) {
      self.postMessage({ id: message.id, noise: known.noise, symbols: known.symbols, symbolsError: known.symbolsError, timing: { classify: 0, cached: true } } satisfies SyntaxResponse);
      return;
    }
    runtimeUrl ||= message.runtimeUrl;
    grammarUrls.set(message.language, message.grammarUrl);
    enqueue({ ...message, received: performance.now() });
    return;
  }
  const hit = cache.get(message.key);
  if (hit) {
    cache.delete(message.key);
    cache.set(message.key, hit);
    self.postMessage({
      id: message.id,
      definitions: hit.definitions,
      timing: { parse: 0, query: 0, cached: true },
    } satisfies SyntaxResponse);
    return;
  }
  runtimeUrl ||= message.runtimeUrl;
  grammarUrls.set(message.language, message.grammarUrl);
  enqueue({ ...message, received: performance.now() });
};
