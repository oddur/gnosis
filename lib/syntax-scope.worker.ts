import * as TreeSitter from 'web-tree-sitter';
import { createSyntaxEngine, type SyntaxDefinition, type SyntaxLanguage } from './syntax-scope';
import { createParseQueue, type SyntaxPriority } from './syntax-parse-queue';
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
      timing: { parse: number; query: number; load?: number; cached: boolean; wait?: number; priority?: SyntaxPriority };
    }
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
type Job = Extract<SyntaxRequest, { type: 'definitions' }> & { received: number };
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
  try {
    const result = await engine.definitions(job.language, job.text);
    cache.set(job.key, { url: job.url, definitions: result.definitions });
    for (const key of cache.keys()) {
      if (cache.size <= CACHE_ENTRIES) break;
      cache.delete(key);
    }
    self.postMessage({
      id: job.id,
      definitions: result.definitions,
      timing: { parse: result.parse, query: result.query, load: result.load, cached: false, wait, priority: job.priority },
    } satisfies SyntaxResponse);
  } catch (error) {
    self.postMessage({ id: job.id, error: error instanceof Error ? error.message : String(error) } satisfies SyntaxResponse);
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
    // Parses that wait still run and answer their callers: another view (an Explanation topic) may show the file.
    return;
  }
  if (message.type === 'priority') {
    queue.raise(message.key, message.priority);
    return;
  }
  if (message.type === 'take') {
    const taken = queue.remove((job) => job.key === message.key).length > 0;
    self.postMessage({ id: message.id, taken } satisfies SyntaxResponse);
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
  queue.add({ ...message, received: performance.now() });
  void drain();
};
