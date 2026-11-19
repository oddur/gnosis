import * as TreeSitter from 'web-tree-sitter';
import { createSyntaxEngine, type SyntaxDefinition, type SyntaxLanguage } from './syntax-scope';
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
    }
  | { type: 'forget'; urls: string[] }
  | { type: 'clear' };
export type SyntaxResponse =
  | {
      id: number;
      definitions: SyntaxDefinition[];
      timing: { parse: number; query: number; load?: number; cached: boolean; wait?: number };
    }
  | { id: number; error: string };

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
// One parse at a time: requests queue in order, and a cached file answers without waiting for parses before it.
let queue = Promise.resolve();

self.onmessage = (event: MessageEvent<SyntaxRequest>) => {
  const message = event.data;
  if (message.type === 'forget') {
    const urls = new Set(message.urls);
    for (const [key, entry] of cache) if (urls.has(entry.url)) cache.delete(key);
    return;
  }
  if (message.type === 'clear') {
    cache.clear();
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
  const received = performance.now();
  queue = queue.then(async () => {
    const wait = performance.now() - received;
    try {
      const result = await engine.definitions(message.language, message.text);
      cache.set(message.key, { url: message.url, definitions: result.definitions });
      for (const key of cache.keys()) {
        if (cache.size <= CACHE_ENTRIES) break;
        cache.delete(key);
      }
      self.postMessage({
        id: message.id,
        definitions: result.definitions,
        timing: { parse: result.parse, query: result.query, load: result.load, cached: false, wait },
      } satisfies SyntaxResponse);
    } catch (error) {
      self.postMessage({
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      } satisfies SyntaxResponse);
    }
  });
};
