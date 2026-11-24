import fs from 'node:fs/promises';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import * as TreeSitter from 'web-tree-sitter';
import { createSyntaxEngine } from '../lib/syntax-scope';
import { TAGS } from '../lib/syntax-tags';
import { sliceFile, sliceMoves } from '../lib/explanation-slices';
import {
  conflictChecker,
  definitionsOf,
  moveProposer,
  noiseAnswer,
  type CheckRequest,
  type CheckResponse,
  type TreeSitterFiles,
} from './conflict-checks';

/**
 * The conflict checks' worker thread (src/conflict-checks.ts), which also runs Reduce noise's syntax comparison for
 * explanations. It reads the runtime and grammars the renderer ships (vite.renderer.config.ts keeps their names), and
 * bundles the tag queries as the renderer's syntax worker does.
 */
const port = parentPort;
if (!port) throw new Error('The conflict checks must run in a worker.');
const files = workerData as TreeSitterFiles;
const engine = createSyntaxEngine(TreeSitter, {
  runtime: async () => new Uint8Array(await fs.readFile(files.runtime)),
  grammar: async (language) => new Uint8Array(await fs.readFile(path.join(files.grammars, `${language}.wasm`))),
  tags: (name) => Promise.resolve(TAGS[name] ?? ''),
});
port.on('message', (message: CheckRequest) => {
  if (message.kind === 'noise') {
    // Reduce noise for an explanation (lib/explanation-noise.ts): one file at a time, each failure its own null.
    void (async () => {
      const noise = [];
      for (const file of message.files) noise.push(await noiseAnswer(engine, file));
      port.postMessage({ id: message.id, noise } satisfies CheckResponse);
    })();
    return;
  }
  if (message.kind === 'slices' || message.kind === 'slice-moves') {
    // Focused explanation sections (lib/explanation-slices.ts): one file's slices, or the PR's moves among them.
    const answer: Promise<CheckResponse> =
      message.kind === 'slices'
        ? sliceFile(engine, message.file, message.disabled).then((slices) => ({ id: message.id, slices }))
        : Promise.resolve().then(() => ({ id: message.id, moves: sliceMoves(message.files) }));
    answer.then(
      (response) => port.postMessage(response satisfies CheckResponse),
      (error: unknown) =>
        port.postMessage({
          id: message.id,
          error: error instanceof Error ? error.message : String(error),
        } satisfies CheckResponse)
    );
    return;
  }
  if (message.kind === 'definitions') {
    void definitionsOf(engine, message.path, message.text, message.disabled).then((definitions) =>
      port.postMessage({ id: message.id, definitions } satisfies CheckResponse)
    );
    return;
  }
  // A conflict file: the move rule's proposal (lib/conflict-moved.ts), or its checks.
  const answer: Promise<CheckResponse> =
    message.kind === 'moved'
      ? moveProposer(engine, message.disabled)(message.file).then((proposal) => ({ id: message.id, proposal }))
      : conflictChecker(engine, message.disabled)(message.file).then((verdict) => ({ id: message.id, verdict }));
  answer.then(
    (response) => port.postMessage(response satisfies CheckResponse),
    (error: unknown) =>
      port.postMessage({
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      } satisfies CheckResponse)
  );
});
