import fs from 'node:fs/promises';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import * as TreeSitter from 'web-tree-sitter';
import { buildChatPrContext } from '../lib/chat-pr-context';
import { createSyntaxEngine } from '../lib/syntax-scope';
import { TAGS } from '../lib/syntax-tags';
import {
  createDefinitionsCache,
  type ChatContextRequest,
  type ChatContextResponse,
  type ParseResult,
} from './chat-context-definitions';
import type { TreeSitterFiles } from './conflict-checks';

/**
 * Chat's PR-wide context, built off the main thread (src/chat-context-definitions.ts): tree-sitter definitions,
 * kept per PR revision, then the ranking and the budget (lib/chat-pr-context.ts). It loads the runtime and grammars
 * the renderer ships, as the conflict checks' worker does (src/conflict-check-worker.ts).
 */
const port = parentPort;
if (!port) throw new Error('Chat context must be built in a worker.');
const files = workerData as TreeSitterFiles;
const engine = createSyntaxEngine(TreeSitter, {
  runtime: async () => new Uint8Array(await fs.readFile(files.runtime)),
  grammar: async (language) => new Uint8Array(await fs.readFile(path.join(files.grammars, `${language}.wasm`))),
  tags: (name) => Promise.resolve(TAGS[name] ?? ''),
});
const definitions = createDefinitionsCache(async (items) => {
  const parsed: ParseResult = { results: {}, failed: [] };
  for (const item of items) {
    try {
      const { definitions: found } = await engine.definitions(item.language, item.text);
      parsed.results[item.path] = found.map((d) => ({
        name: d.name,
        label: d.label,
        kind: d.kind,
        start: d.start,
        end: d.end,
      }));
    } catch {
      // Not kept: the next question tries again, and this one reads definition lines instead.
      parsed.failed.push(item.path);
    }
  }
  return parsed;
});
port.on('message', (message: ChatContextRequest) => {
  void (async () => {
    try {
      const found = await definitions.definitions(message.key, message.input.files, message.input.sources);
      const result = buildChatPrContext({ ...message.input, definitions: found });
      port.postMessage({ id: message.id, result } satisfies ChatContextResponse);
    } catch (error) {
      port.postMessage({
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      } satisfies ChatContextResponse);
    }
  })();
});
