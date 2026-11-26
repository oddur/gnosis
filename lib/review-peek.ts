import { FILE_STOP } from './tree-symbol-review';
import type { TreeSymbolNode } from './tree-symbols';

/**
 * Peek at a symbol (the Changes tree's Space, or a hover): its own hunks, rendered as Changes renders them, and the
 * changed symbols of the PR that call it. Pure parts here; components/SymbolPeek.tsx draws them.
 */

/**
 * A patch's hunks as a diff renders them (a header and its lines): those holding any of `keys` (`a12`, `b7`), or whose
 * lines on `side` overlap `start`..`end` (a symbol's definition); every hunk with neither.
 */
export function peekHunks(
  patch: string | undefined,
  want: { keys?: readonly string[]; side?: 'after' | 'before'; start?: number; end?: number } = {}
): { header: string; content: string }[] {
  if (!patch) return [];
  const keys = want.keys && new Set(want.keys);
  const range = want.side && want.start !== undefined ? { side: want.side, start: want.start, end: want.end ?? want.start } : undefined;
  const out: { header: string; content: string }[] = [];
  let current: { header: string; rows: string[]; keys: Set<string>; old: [number, number]; new: [number, number] } | undefined;
  let oldLine = 0,
    newLine = 0;
  const close = () => {
    if (!current) return;
    const span = range && (range.side === 'after' ? current.new : current.old);
    const hit = keys ? [...current.keys].some((key) => keys.has(key)) : span ? span[0] <= range.end && span[1] >= range.start : true;
    if (hit) out.push({ header: current.header, content: current.rows.join('\n') });
    current = undefined;
  };
  for (const row of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (header) {
      close();
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      current = { header: row, rows: [], keys: new Set(), old: [oldLine, oldLine - 1], new: [newLine, newLine - 1] };
      continue;
    }
    if (!current || row.startsWith('\\')) {
      if (current) current.rows.push(row);
      continue;
    }
    current.rows.push(row);
    const type = row[0];
    if (type === '+') {
      current.keys.add(`a${newLine}`);
      current.new[1] = newLine++;
    } else if (type === '-') {
      current.keys.add(`b${oldLine}`);
      current.old[1] = oldLine++;
    } else {
      current.old[1] = oldLine++;
      current.new[1] = newLine++;
    }
  }
  close();
  return out;
}

/** Words that read like a call but are the language's own: `if (`, `return (`, `function (`. */
const NOT_CALLS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'await', 'new', 'super', 'this', 'else',
  'elif', 'def', 'class', 'fn', 'func', 'match', 'with', 'yield', 'throw', 'case', 'do', 'in', 'of', 'sizeof', 'not', 'and', 'or',
]);
/**
 * The names a line of code calls: an identifier right before `(`. Comment lines say nothing, and strings are left out,
 * so `// flush()` or `"run()"` are no calls. A text reading of the changed lines, not the tags queries' references:
 * those are dropped from the parse to keep it cheap (lib/syntax-scope.ts), and TypeScript's tags have none.
 */
export function callNames(text: string): string[] {
  const line = text.trim();
  if (!line || /^(\/\/|#|\*|\/\*|--)/.test(line)) return [];
  const code = line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\/\/.*$/, '');
  const names: string[] = [];
  for (const match of code.matchAll(/([A-Za-z_$][\w$]*)\s*(?:<[^()]*>)?\s*\(/g)) if (!NOT_CALLS.has(match[1])) names.push(match[1]);
  return names;
}

/** A call one review item's changed lines make: the name called, the line it is on (`a12`), and its code. */
export interface ItemCall {
  name: string;
  line: string;
  text: string;
}
/** Each item's calls, from its changed lines (an added symbol's are all of its lines). */
export function itemCalls(lines: ReadonlyMap<string, readonly string[]>, rows: ReadonlyMap<string, string>): Record<string, ItemCall[]> {
  const out: Record<string, ItemCall[]> = {};
  for (const [id, keys] of lines) {
    const calls: ItemCall[] = [];
    for (const key of keys) {
      const text = rows.get(key);
      if (text !== undefined) for (const name of callNames(text)) calls.push({ name, line: key, text: text.trim() });
    }
    if (calls.length) out[id] = calls;
  }
  return out;
}

/** A file of the PR whose symbols are known, for callers: its tree rows and each item's calls. */
export interface CallerFile {
  key: string;
  nodes: readonly TreeSymbolNode[];
  calls?: Readonly<Record<string, readonly ItemCall[]>>;
}
export interface Caller {
  key: string;
  id: string;
  node: TreeSymbolNode;
  call: ItemCall;
}
export type CallersResult =
  /** The item has no name to call: the top level, a Body, a file. */
  | { kind: 'none' }
  /** The name is defined by more than one changed symbol across the files read: nothing is matched. */
  | { kind: 'ambiguous' }
  | { kind: 'callers'; callers: Caller[] };

const named = (node: TreeSymbolNode) => !!node.symbol && !node.moveAway && !node.id.endsWith('>@body');
function* walk(nodes: readonly TreeSymbolNode[]): Generator<TreeSymbolNode> {
  for (const node of nodes) {
    yield node;
    yield* walk(node.children);
  }
}

/**
 * The changed symbols that call an item, in this PR (fail closed): a symbol B calls A when one of B's changed lines
 * calls A's name, and that name is defined by exactly one changed symbol across the files read, same file or not. A
 * name with several definitions (overloads, `get`, `run`) matches nothing. Old copies of moves are not definitions.
 */
export function findCallers(target: { key: string; id: string }, files: readonly CallerFile[]): CallersResult {
  if (target.id === FILE_STOP || target.id.startsWith('@')) return { kind: 'none' };
  const file = files.find((one) => one.key === target.key);
  const node = file && [...walk(file.nodes)].find((one) => one.id === target.id);
  if (!node || !named(node) || node.id.endsWith('>@body')) return { kind: 'none' };
  const name = node.definition.name;
  let definitions = 0;
  for (const one of files) for (const other of walk(one.nodes)) if (named(other) && other.definition.name === name) definitions++;
  if (definitions !== 1) return { kind: 'ambiguous' };
  const callers: Caller[] = [];
  for (const one of files)
    for (const [id, calls] of Object.entries(one.calls ?? {})) {
      if (one.key === target.key && id === target.id) continue;
      const call = calls.find((item) => item.name === name);
      const caller = call && [...walk(one.nodes)].find((other) => other.id === id);
      if (call && caller) callers.push({ key: one.key, id, node: caller, call });
    }
  return { kind: 'callers', callers };
}

/** How many of the files that can list symbols have been read (their symbols known, or known to be none). */
export function callerCoverage(states: readonly ('loading' | 'none' | 'ready' | undefined)[]): { checked: number; total: number } {
  return { checked: states.filter((state) => state !== undefined && state !== 'loading').length, total: states.length };
}
