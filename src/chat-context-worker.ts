import fs from 'node:fs/promises';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import * as TreeSitter from 'web-tree-sitter';
import { createSyntaxEngine } from '../lib/syntax-scope';
import { TAGS } from '../lib/syntax-tags';
import type { ChatDefinitionsRequest, ChatDefinitionsResponse } from './chat-context-definitions';
import type { TreeSitterFiles } from './conflict-checks';

/**
 * Tree-sitter definitions for chat's PR-wide context (lib/chat-pr-context.ts), off the main thread. It loads the
 * runtime and grammars the renderer ships, as the conflict checks' worker does (src/conflict-check-worker.ts).
 */
const port = parentPort;
if (!port) throw new Error('Chat context definitions must run in a worker.');
const files = workerData as TreeSitterFiles;
const engine = createSyntaxEngine(TreeSitter, {
  runtime: async () => new Uint8Array(await fs.readFile(files.runtime)),
  grammar: async (language) => new Uint8Array(await fs.readFile(path.join(files.grammars, `${language}.wasm`))),
  tags: (name) => Promise.resolve(TAGS[name] ?? ''),
});
port.on('message', (message: ChatDefinitionsRequest) => {
  void (async () => {
    const results: ChatDefinitionsResponse['results'] = {};
    for (const item of message.items) {
      try {
        const { definitions } = await engine.definitions(item.language, item.text);
        results[item.path] = definitions.map((d) => ({ name: d.name, label: d.label, start: d.start, end: d.end }));
      } catch {
        // A file that does not parse gives no definitions; the context falls back to definition-like lines.
      }
    }
    port.postMessage({ id: message.id, results } satisfies ChatDefinitionsResponse);
  })();
});
