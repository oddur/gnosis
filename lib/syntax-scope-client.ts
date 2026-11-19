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
import { onInspectionForget } from './inspection-cache';

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
let worker: Promise<Worker | undefined> | undefined;
let nextId = 0;
const waiting = new Map<number, { resolve: (value: SyntaxDefinition[]) => void; reject: (error: Error) => void }>();
const memo = new Map<string, { url: string; definitions: SyntaxDefinition[] }>();
const pending = new Map<string, Promise<SyntaxDefinition[]>>();
/** The last parses, newest last, for the diagnostics export and the browser checks. */
export const syntaxTimings: (Timing & { key: string; language: SyntaxLanguage; characters: number })[] = [];

const absolute = (url: string) => new URL(url, document.baseURI).href;

function start(): Promise<Worker | undefined> {
  worker ??= import('./syntax-scope.worker?worker&inline')
    .then(({ default: SyntaxWorker }) => {
      const instance = new SyntaxWorker({ name: 'gnosis-syntax' });
      instance.onmessage = (event: MessageEvent<SyntaxResponse & { id: number }>) => {
        const response = event.data;
        const entry = waiting.get(response.id);
        if (!entry) return;
        waiting.delete(response.id);
        if ('error' in response) entry.reject(Error(response.error));
        else {
          entry.resolve(response.definitions);
          timings.get(response.id)?.(response.timing);
        }
      };
      instance.onerror = (event) => {
        event.preventDefault();
        for (const entry of waiting.values()) entry.reject(Error('The syntax worker stopped'));
        waiting.clear();
        worker = undefined;
      };
      return instance;
    })
    .catch(() => undefined);
  return worker;
}
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
  return entry.definitions;
}

/**
 * A file's definitions, parsed in the worker. Rejects for a file that could not parse, and when workers are not
 * available: the caller then shows the diff as it is.
 */
export function readDefinitions(request: {
  key: string;
  url: string;
  language: SyntaxLanguage;
  text: string;
}): Promise<SyntaxDefinition[]> {
  if (!languageAllowed(request.language)) return Promise.reject(Error('This language is off in Settings'));
  const known = peekDefinitions(request.key);
  if (known) return Promise.resolve(known);
  if (request.text.length > SYNTAX_MAX_CHARACTERS) return Promise.reject(Error('This file is too large to parse'));
  const existing = pending.get(request.key);
  if (existing) return existing;
  const promise = start().then(
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
          syntaxTimings.push({
            ...timing,
            key: request.key,
            language: request.language,
            characters: request.text.length,
          });
          if (syntaxTimings.length > 50) syntaxTimings.shift();
        });
        instance.postMessage({
          type: 'definitions',
          id,
          key: request.key,
          url: request.url,
          language: request.language,
          text: request.text,
          runtimeUrl: absolute(runtimeWasm),
          grammarUrl: absolute(GRAMMARS[request.language]),
        } satisfies SyntaxRequest);
      })
  );
  pending.set(request.key, promise);
  void promise.then(
    (definitions) => {
      if (pending.get(request.key) !== promise) return;
      pending.delete(request.key);
      memo.set(request.key, { url: request.url, definitions });
      for (const key of memo.keys()) {
        if (memo.size <= MEMO_ENTRIES) break;
        memo.delete(key);
      }
    },
    () => {
      if (pending.get(request.key) === promise) pending.delete(request.key);
    }
  );
  return promise;
}

/** Drops these PRs' definitions here and in the worker, with the rest of their inspection data (#355). */
export function forgetDefinitions(urls: ReadonlySet<string>) {
  for (const [key, entry] of memo) if (urls.has(entry.url)) memo.delete(key);
  void worker?.then((instance) => instance?.postMessage({ type: 'forget', urls: [...urls] } satisfies SyntaxRequest));
}
export function clearDefinitions() {
  memo.clear();
  pending.clear();
  void worker?.then((instance) => instance?.postMessage({ type: 'clear' } satisfies SyntaxRequest));
}
/** Entries kept on the page, for the diagnostics export. */
export const definitionStats = () => ({ entries: memo.size });

// Definitions leave with their PR's inspection data: a closed tab, an idle PR, or a cache reset (#355).
onInspectionForget((urls) => (urls ? forgetDefinitions(urls) : clearDefinitions()));
