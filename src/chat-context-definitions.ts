import { Worker } from 'node:worker_threads';
import { parseHunks, type ChatContextDefinition, type ChatContextFile } from '../lib/chat-pr-context';
import { syntaxLanguage, SYNTAX_MAX_CHARACTERS, type SyntaxLanguage } from '../lib/syntax-scope';
import type { TreeSitterFiles } from './conflict-checks';

/**
 * Definitions for chat's PR-wide context, parsed with tree-sitter in a worker (src/chat-context-worker.ts) and kept
 * per PR revision, so later questions about the same PR parse nothing again. A file with its head source is parsed
 * whole; any other changed file is parsed from its hunks' new side, enough to name what it defines.
 */
export interface ChatDefinitionsRequest {
  id: number;
  items: { path: string; language: SyntaxLanguage; text: string }[];
}
export interface ChatDefinitionsResponse {
  id: number;
  results: Record<string, ChatContextDefinition[]>;
}

/** One PR's worth of parsing at most: a large PR's hunks beyond it go without tree-sitter definitions. */
const MAX_PARSE_CHARACTERS = 2_000_000;
/** Revisions kept. */
const CACHED_REVISIONS = 8;

export function createChatDefinitions(script: string, files: () => TreeSitterFiles, timeoutMs = 8000, idleMs = 60_000) {
  let worker: Worker | undefined;
  let serial = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const waiting = new Map<number, (results: ChatDefinitionsResponse['results']) => void>();
  const cache = new Map<string, Map<string, ChatContextDefinition[]>>();
  const stop = () => {
    const previous = worker;
    worker = undefined;
    previous?.removeAllListeners();
    void previous?.terminate();
    for (const resolve of waiting.values()) resolve({});
    waiting.clear();
  };
  const start = () => {
    if (worker) return worker;
    const started = new Worker(script, { workerData: files() });
    started.on('message', (message: ChatDefinitionsResponse) => {
      waiting.get(message.id)?.(message.results);
      waiting.delete(message.id);
    });
    started.on('error', (error) => {
      console.warn('[chat] The definitions worker failed.', error);
      stop();
    });
    started.on('exit', () => {
      if (worker === started) stop();
    });
    started.unref();
    worker = started;
    return started;
  };
  const parse = (items: ChatDefinitionsRequest['items']) =>
    new Promise<ChatDefinitionsResponse['results']>((resolve) => {
      if (!items.length) {
        resolve({});
        return;
      }
      clearTimeout(idle);
      const id = ++serial;
      // Too slow is the same as unavailable: the context then reads definition-like lines instead.
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve({});
      }, timeoutMs);
      waiting.set(id, (results) => {
        clearTimeout(timer);
        resolve(results);
        idle = setTimeout(stop, idleMs);
      });
      try {
        start().postMessage({ id, items } satisfies ChatDefinitionsRequest);
      } catch (error) {
        console.warn('[chat] Could not start the definitions worker.', error);
        waiting.delete(id);
        clearTimeout(timer);
        resolve({});
      }
    });
  return {
    /**
     * Definitions of `changed` files for revision `key`: parsed once, then from the cache. `sources` are head texts the
     * caller read; a file in it is parsed whole, and its entry is kept apart from the hunks-only one.
     */
    async definitions(
      key: string,
      changed: readonly ChatContextFile[],
      sources: Readonly<Record<string, string>> = {}
    ): Promise<Record<string, ChatContextDefinition[]>> {
      let known = cache.get(key);
      if (!known) {
        if (cache.size >= CACHED_REVISIONS) cache.delete(cache.keys().next().value as string);
        known = new Map();
        cache.set(key, known);
      }
      const items: ChatDefinitionsRequest['items'] = [];
      let total = 0;
      const id = (path: string) => (path in sources ? `source:${path}` : `hunks:${path}`);
      for (const file of changed) {
        const language = syntaxLanguage(file.path);
        if (!language || language === 'json' || language === 'yaml' || known.has(id(file.path))) continue;
        const text =
          sources[file.path] ??
          parseHunks(file.patch)
            .map((h) => h.newLines.join('\n'))
            .join('\n\n');
        if (!text.trim() || text.length > SYNTAX_MAX_CHARACTERS || total + text.length > MAX_PARSE_CHARACTERS) continue;
        total += text.length;
        items.push({ path: file.path, language, text });
      }
      const parsed = await parse(items);
      for (const item of items) known.set(id(item.path), parsed[item.path] ?? []);
      const result: Record<string, ChatContextDefinition[]> = {};
      for (const file of changed) {
        const definitions = known.get(id(file.path));
        if (definitions?.length) result[file.path] = definitions;
      }
      return result;
    },
    dispose: stop,
  };
}
