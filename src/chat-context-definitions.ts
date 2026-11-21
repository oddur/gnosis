import { Worker } from 'node:worker_threads';
import {
  buildChatPrContext,
  parseHunks,
  type ChatContextDefinition,
  type ChatContextFile,
  type ChatContextInput,
  type ChatContextResult,
} from '../lib/chat-pr-context';
import { syntaxLanguage, SYNTAX_MAX_CHARACTERS, type SyntaxLanguage } from '../lib/syntax-scope';
import type { TreeSitterFiles } from './conflict-checks';

/**
 * Chat's PR-wide context is built off the main thread: the context worker (src/chat-context-worker.ts) parses
 * definitions with tree-sitter, keeps them per PR revision, ranks the files and slices the budget. The main process
 * only sends the PR's files and the question, and receives the context.
 */
export type DefinitionItem = { path: string; language: SyntaxLanguage; text: string };
/** One parse: definitions by path, and the files whose parse threw. */
export type ParseResult = { results: Record<string, ChatContextDefinition[]>; failed: string[] };

/** One PR's worth of parsing at most: a large PR's hunks beyond it go without tree-sitter definitions. */
const MAX_PARSE_CHARACTERS = 2_000_000;
/** Revisions kept. */
const CACHED_REVISIONS = 8;

/**
 * Definitions kept per PR revision, so later questions about the same PR parse nothing again. A file with its head
 * source is parsed whole; any other changed file from its hunks' new side, enough to name what it defines. Only
 * parses that finished are kept: a parse that timed out or threw is tried again on the next question.
 */
export function createDefinitionsCache(parse: (items: DefinitionItem[]) => Promise<ParseResult>, timeoutMs = 8000) {
  const cache = new Map<string, Map<string, ChatContextDefinition[]>>();
  const timed = (items: DefinitionItem[]) =>
    new Promise<ParseResult | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), timeoutMs);
      parse(items).then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        () => {
          clearTimeout(timer);
          resolve(undefined);
        }
      );
    });
  return {
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
      const items: DefinitionItem[] = [];
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
      const parsed = items.length ? await timed(items) : undefined;
      if (parsed)
        for (const item of items) {
          if (parsed.failed.includes(item.path)) continue;
          known.set(id(item.path), parsed.results[item.path] ?? []);
        }
      const result: Record<string, ChatContextDefinition[]> = {};
      for (const file of changed) {
        const definitions = known.get(id(file.path));
        if (definitions?.length) result[file.path] = definitions;
      }
      return result;
    },
    /** A revision's kept entries, for tests. */
    cached: (key: string) => [...(cache.get(key)?.keys() ?? [])],
  };
}

export interface ChatContextRequest {
  id: number;
  key: string;
  input: Omit<ChatContextInput, 'definitions'>;
}
export type ChatContextResponse = { id: number; result: ChatContextResult } | { id: number; error: string };

/**
 * The main process's side of the context worker. A request that times out, or a worker that fails, gives undefined:
 * the caller builds without definitions instead. The worker stops after a quiet minute, never while a request
 * waits for it.
 */
export function createChatContextWorker(
  script: string,
  files: () => TreeSitterFiles,
  timeoutMs = 10_000,
  idleMs = 60_000
) {
  let worker: Worker | undefined;
  let serial = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const waiting = new Map<number, (result: ChatContextResult | undefined) => void>();
  const terminate = () => {
    const previous = worker;
    worker = undefined;
    previous?.removeAllListeners();
    void previous?.terminate();
  };
  const fail = () => {
    for (const resolve of waiting.values()) resolve(undefined);
    waiting.clear();
    terminate();
  };
  const scheduleIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      if (!waiting.size) terminate();
    }, idleMs);
    idle.unref();
  };
  const start = () => {
    if (worker) return worker;
    const started = new Worker(script, { workerData: files() });
    started.on('message', (message: ChatContextResponse) => {
      if ('error' in message) console.warn('[chat] The context worker could not build a context.', message.error);
      waiting.get(message.id)?.('result' in message ? message.result : undefined);
      waiting.delete(message.id);
    });
    started.on('error', (error) => {
      console.warn('[chat] The context worker failed.', error);
      if (worker === started) fail();
    });
    started.on('exit', () => {
      if (worker === started) fail();
    });
    started.unref();
    worker = started;
    return started;
  };
  return {
    build: (key: string, input: Omit<ChatContextInput, 'definitions'>) =>
      new Promise<ChatContextResult | undefined>((resolve) => {
        clearTimeout(idle);
        const id = ++serial;
        const timer = setTimeout(() => {
          waiting.delete(id);
          resolve(undefined);
          scheduleIdle();
        }, timeoutMs);
        waiting.set(id, (result) => {
          clearTimeout(timer);
          resolve(result);
          scheduleIdle();
        });
        try {
          start().postMessage({ id, key, input } satisfies ChatContextRequest);
        } catch (error) {
          console.warn('[chat] Could not start the context worker.', error);
          waiting.delete(id);
          clearTimeout(timer);
          resolve(undefined);
          scheduleIdle();
        }
      }),
    dispose: () => {
      clearTimeout(idle);
      fail();
    },
  };
}

/** Builds in the worker; without it, on this thread and without definitions. */
export async function buildChatContext(
  worker: Pick<ReturnType<typeof createChatContextWorker>, 'build'>,
  key: string,
  input: Omit<ChatContextInput, 'definitions'>
) {
  return (await worker.build(key, input)) ?? buildChatPrContext(input);
}
