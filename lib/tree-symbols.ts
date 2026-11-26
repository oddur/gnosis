import type { GapHunk } from './diff-gaps';
import type { MoveMark } from './moved-symbols-store';
import { TOP_LEVEL_ID, bodySymbol, visibleSymbols, type ChangedSymbol, type SymbolChange } from './symbol-outline';
import type { DefinitionKind, SyntaxDefinition, SyntaxLanguage } from './syntax-scope';

/**
 * The changed symbols of a file as rows of the Changes file tree: folder › file › class › method. The rows come from
 * the outline's own `changedSymbols()` (lib/symbol-outline.ts), so the tree and the outline above the diff name the
 * same symbols under the same ids, and a Viewed tick in one shows in the other (lib/file-view-progress.ts).
 *
 * The outline is a flat list; the tree nests it. A parent that holds changed symbols but is not changed itself is a
 * context row, so the reader can drill down to the method that changed. Changed lines outside every definition
 * (imports, top-level statements) make a first row, so a file's rows add up to its changes.
 */

/** The languages whose tags queries name definitions (src/assets/tree-sitter/*-tags.scm): JSON and YAML have none. */
const TREE_LANGUAGES: ReadonlySet<SyntaxLanguage> = new Set(['typescript', 'tsx', 'javascript', 'python', 'go', 'rust', 'java', 'csharp']);
export const treeSymbolLanguage = (language: SyntaxLanguage | undefined) => !!language && TREE_LANGUAGES.has(language);

/** What a symbol row's icon shows. */
export type TreeSymbolKind = 'function' | 'method' | 'class' | 'interface' | 'type' | 'enum' | 'variable' | 'module';
const KINDS: Record<DefinitionKind, TreeSymbolKind> = {
  function: 'function',
  test: 'function',
  macro: 'function',
  method: 'method',
  class: 'class',
  struct: 'class',
  impl: 'class',
  interface: 'interface',
  trait: 'interface',
  type: 'type',
  enum: 'enum',
  property: 'variable',
  key: 'variable',
  module: 'module',
};
export const treeSymbolKind = (kind: DefinitionKind): TreeSymbolKind => KINDS[kind];

export interface TreeSymbolNode {
  /** The symbol's id (`class:Store>method:flush`): what its Viewed tick is kept under. */
  id: string;
  definition: SyntaxDefinition;
  /** `context`: a parent around changed symbols that is not changed itself. */
  change: SymbolChange | 'context';
  /** The outline's symbol; undefined for a context row. */
  symbol?: ChangedSymbol;
  /** Changed lines that are this symbol's own, not a nested changed symbol's: 0 for a context row. */
  added: number;
  deleted: number;
  /**
   * Every change of the symbol is quiet, formatting or comments the reader hides (#396): what they are, as the file's
   * header names a quiet file ("Formatting only"). Undefined for a symbol with a change that shows.
   */
  quiet?: string;
  /** Where the symbol moved from or to (#398), in words for its tooltip. */
  moved?: string;
  /**
   * The old copy of a symbol that moved (or was renamed) and is reviewed at its new copy (`moveInto` there): no item
   * of its own. It reads viewed with the new copy (`movedMirrorId`), and goes to it.
   */
  moveAway?: MoveMark;
  /** The new copy of a moved or renamed symbol: one item for the move, its tick also the old copy's. */
  moveInto?: MoveMark;
  /**
   * Its own changed lines are all trivial (blank, brackets, quiet; lib/symbol-outline.ts `trivialSymbols`): with a
   * changed symbol under it, it is a context row for review (lib/tree-symbol-review.ts).
   */
  trivial?: boolean;
  children: TreeSymbolNode[];
}

/**
 * The outline's symbols as a tree. `all` is `changedSymbols()` without the quiet lines left out, so every changed
 * symbol has a row; `shown` is the outline's own list, with them left out: a symbol in `all` but not in `shown` has
 * only quiet changes. Siblings keep the outline's order, which is the diff's.
 */
export function symbolTree(
  all: readonly ChangedSymbol[],
  shown: readonly ChangedSymbol[] = all,
  moves: readonly MoveMark[] = [],
  /** What a quiet symbol's changes are, in the words of a quiet file's label. */
  quietLabel: (symbol: ChangedSymbol) => string = () => 'Quiet changes',
  /** Symbols whose own changed lines are all trivial (`trivialSymbols`). */
  trivial: ReadonlySet<string> = new Set()
): TreeSymbolNode[] {
  // Quiet: no change of it shows, in it or under it (`visibleSymbols`), as the outline counts it.
  const shownIds = visibleSymbols(all, shown);
  const roots: TreeSymbolNode[] = [];
  const nodes = new Map<string, TreeSymbolNode>();
  const place = (node: TreeSymbolNode, parent: TreeSymbolNode | undefined) => (parent ? parent.children : roots).push(node);
  for (const symbol of all) {
    // An id is one `kind:name` part per definition around it. A name with `>` in it (an operator) splits wrongly: the
    // symbol then lists at the top, rather than under parents that would be guessed.
    const parts = symbol.id.split('>');
    const nested = parts.length === symbol.parents.length + 1;
    let parent: TreeSymbolNode | undefined;
    if (nested)
      for (let depth = 0; depth < symbol.parents.length; depth++) {
        const id = parts.slice(0, depth + 1).join('>');
        let node = nodes.get(id);
        if (!node) {
          node = { id, definition: symbol.parents[depth], change: 'context', added: 0, deleted: 0, children: [] };
          nodes.set(id, node);
          place(node, parent);
        }
        parent = node;
      }
    const move = moves.find((mark) => mark.side === symbol.side && mark.start === symbol.definition.start && mark.name === symbol.definition.name);
    const own = {
      definition: symbol.definition,
      change: symbol.change,
      symbol,
      added: symbol.added,
      deleted: symbol.deleted,
      quiet: shownIds.has(symbol.id) ? undefined : quietLabel(symbol),
      moved: move && moveWords(move),
      moveAway: move?.side === 'before' ? move : undefined,
      moveInto: move?.side === 'after' ? move : undefined,
      trivial: trivial.has(symbol.id) || undefined,
    };
    const known = nodes.get(symbol.id);
    // A parent listed as context for a child that changed first, and changed further down itself.
    if (known) Object.assign(known, own);
    else {
      const node: TreeSymbolNode = { id: symbol.id, ...own, children: [] };
      nodes.set(symbol.id, node);
      place(node, nested ? parent : undefined);
    }
  }
  // A container (a symbol with a changed symbol under it) is no review item of its own: its own changed lines, unless
  // trivial, are a Body row first under it, as the file's top level is first under the file (lib/tree-symbol-review.ts).
  const changedUnder = (node: TreeSymbolNode): boolean =>
    node.children.some((child) => (!!child.symbol && !child.quiet && !child.moveAway) || changedUnder(child));
  const addBodies = (nodes: TreeSymbolNode[]) => {
    for (const node of nodes) {
      addBodies(node.children);
      if (!node.symbol || node.trivial || node.quiet || !changedUnder(node)) continue;
      const body = bodySymbol(node.symbol);
      node.children.unshift({ id: body.id, definition: body.definition, change: node.change, symbol: body, added: node.added, deleted: node.deleted, children: [] });
    }
  };
  addBodies(roots);
  return roots;
}

/**
 * A moved symbol is one review item, its new copy (#398's matcher reports only confident moves: an ambiguous one,
 * such as one source with several destinations, is no move, and both copies stay items). Ticking the new copy ticks
 * the old one too, under this id in the old file: its line there, as the move names it from both ends.
 */
export const MOVED_PREFIX = '@moved:';
export const movedMirrorId = (start: number) => `${MOVED_PREFIX}${start}`;
/** The symbols that are old copies of moves, by id: `changedSymbols()`'s removed symbols the marks say moved away. */
export function movedAwayIds(symbols: readonly ChangedSymbol[], marks: readonly MoveMark[]): Set<string> {
  return new Set(
    symbols
      .filter((symbol) => marks.some((mark) => mark.side === 'before' && symbol.side === 'before' && mark.start === symbol.definition.start && mark.name === symbol.definition.name))
      .map((symbol) => symbol.id)
  );
}

/** A move in words, for a symbol row's tooltip: "Moved from lib/store.ts, line 12", "Renamed from flushAll". */
export function moveWords(mark: Pick<MoveMark, 'side' | 'sameFile' | 'other' | 'renamed'>): string {
  const into = mark.side === 'after';
  const { other } = mark;
  const where = mark.sameFile ? `line ${other.start} of this file` : `${other.path}, line ${other.start}`;
  if (mark.renamed && mark.sameFile) return `${into ? 'Renamed from' : 'Renamed to'} ${other.name}, ${where}`;
  return `${into ? 'Moved from' : 'Moved to'} ${where}${mark.renamed ? `, as ${other.name}` : ''}`;
}

/** Changed lines outside every definition: what the file's first row counts. */
export interface TopLevelChanges {
  added: number;
  deleted: number;
  /** Every one of them is an import (or a blank line among imports): the row reads "Imports". */
  imports: boolean;
  /** Each changed line, `a12` (new line 12) or `b7` (old line 7), wherever in the file: what a scroll must show. */
  lines: string[];
  /** The first of them in the diff's order, on its side: where going to them lands. */
  first: { side: 'after' | 'before'; line: number };
  /** Every one of them is quiet (formatting or comments the reader hides): not counted, as a quiet symbol is not. */
  quiet?: boolean;
}

/** What the top-level row and its outline entry are called. */
export const topLevelName = (top: Pick<TopLevelChanges, 'imports'>) => (top.imports ? 'Imports' : 'Top level');

/**
 * A file's top-level changes as one more symbol of its outline, under TOP_LEVEL_ID: ticked, counted and gone to like
 * the others. Going to it lands on its first changed line.
 */
export function topLevelSymbol(top: TopLevelChanges): ChangedSymbol {
  const name = topLevelName(top);
  const { line } = top.first;
  return {
    id: TOP_LEVEL_ID,
    // Marked as the outline marks a symbol: only added lines, only deleted ones, or both.
    change: top.deleted === 0 ? 'added' : top.added === 0 ? 'removed' : 'modified',
    definition: { kind: 'module', name, label: name, crumb: name, start: line, end: line, signatureEnd: line },
    side: top.first.side,
    parents: [],
    first: top.first,
    added: top.added,
    deleted: top.deleted,
  };
}

/** The smallest definition holding `line`; as lib/symbol-outline.ts finds it, so the two count the same lines. */
function inside(definitions: readonly SyntaxDefinition[], line: number) {
  for (const definition of definitions) if (definition.start <= line && definition.end >= line) return true;
  return false;
}

/**
 * The changed lines outside every definition, attributed as `changedSymbols()` attributes lines: an added line by the
 * new file's tree, a deleted line by the old file's, or without it by the new file's lines around where it was.
 * Undefined when there are none.
 */
export function topLevelChanges(
  hunks: readonly Pick<GapHunk, 'oldStart' | 'newStart' | 'rows'>[],
  definitions: { after?: readonly SyntaxDefinition[]; before?: readonly SyntaxDefinition[] },
  /** Lines left out, as `changedSymbols()` leaves them: quiet ones the reader hides. */
  skip?: (side: 'before' | 'after', line: number) => boolean
): TopLevelChanges | undefined {
  const after = definitions.after ?? [];
  const before = definitions.before;
  let added = 0,
    deleted = 0;
  const texts: string[] = [];
  const lines: string[] = [];
  let first: TopLevelChanges['first'] | undefined;
  for (const hunk of hunks) {
    let oldLine = hunk.oldStart,
      newLine = hunk.newStart;
    for (const row of hunk.rows) {
      if (skip && row.type !== ' ' && skip(row.type === '+' ? 'after' : 'before', row.type === '+' ? newLine : oldLine)) {
        // Left out: counted as unchanged.
      } else if (row.type === '+' && !inside(after, newLine)) {
        added++;
        texts.push(row.text);
        lines.push(`a${newLine}`);
        first ??= { side: 'after', line: newLine };
      } else if (
        row.type === '-' &&
        !(before ? inside(before, oldLine) : inside(after, Math.max(1, newLine - 1)) || inside(after, newLine))
      ) {
        deleted++;
        texts.push(row.text);
        lines.push(`b${oldLine}`);
        first ??= { side: 'before', line: oldLine };
      }
      if (row.type !== '+') oldLine++;
      if (row.type !== '-') newLine++;
    }
  }
  if (!first) return undefined;
  return { added, deleted, imports: importLines(texts), lines, first };
}

// An import in any of the tree's languages: `import`, `from x import`, `use`, `using`, `extern crate`, `require(…)`,
// and re-exports. Go's and multi-line TypeScript imports spread over lines that name only a path or a binding: those
// count among imports when an import line is there too.
const IMPORT = /^(import\b|export\s+(type\s+)?(\*|\{[^}]*\})\s*(as\s+\w+\s*)?from\b|from\s+\S+\s+import\b|use\s|pub\s+use\s|using\s|extern\s+crate\s|package\s|(const|let|var)\s+[\w${},\s]+=\s*require\()/;
const IMPORT_PART = /^(["'`][^"'`]+["'`];?|[\w.]+\s+["'`][^"'`]+["'`]|(type\s+)?[\w$]+(\s+as\s+[\w$]+)?,?|\}\s*(from\s+["'`][^"'`]+["'`])?;?|\)|\{|\(|\*\s+as\s+\w+)$/;
function importLines(texts: readonly string[]): boolean {
  let any = false;
  for (const text of texts) {
    const line = text.trim();
    if (!line) continue;
    if (IMPORT.test(line)) any = true;
    else if (!IMPORT_PART.test(line)) return false;
  }
  return any;
}

/** Symbol rows whose name has `query` in it, with the rows around them; undefined for no query. */
export function matchingSymbols(nodes: readonly TreeSymbolNode[], query: string): Set<string> | undefined {
  const needle = query.trim().toLowerCase();
  if (!needle) return undefined;
  const found = new Set<string>();
  const walk = (node: TreeSymbolNode): boolean => {
    let hit = node.definition.name.toLowerCase().includes(needle);
    for (const child of node.children) if (walk(child)) hit = true;
    if (hit) found.add(node.id);
    return hit;
  };
  for (const node of nodes) walk(node);
  return found;
}

/**
 * The row of the symbol the reader is in, from the pinned breadcrumb's definitions around the line at the top of the
 * view (outermost first, `kind:name@start` each, the start optional): the innermost one with a row, so reading a
 * changed method inside an unchanged class lights the method, and reading elsewhere in the class lights the class's
 * context row. Repeats such as overloads share a kind and name, and are told apart by where they start.
 */
export function readingSymbol(nodes: readonly TreeSymbolNode[], path: readonly string[] | undefined): string | undefined {
  if (!path?.length) return undefined;
  const byPath = new Map<string, TreeSymbolNode[]>();
  const walk = (node: TreeSymbolNode) => {
    // Repeats have `#2` on their part: the reader's place names the kind and name only.
    const plain = node.id.replace(/#\d+(?=>|$)/g, '');
    byPath.set(plain, [...(byPath.get(plain) ?? []), node]);
    node.children.forEach(walk);
  };
  nodes.forEach(walk);
  const parts = path.map((part) => {
    const at = part.lastIndexOf('@');
    return at > 0 && /^\d+$/.test(part.slice(at + 1)) ? { name: part.slice(0, at), start: Number(part.slice(at + 1)) } : { name: part };
  });
  for (let depth = parts.length; depth > 0; depth--) {
    const found = byPath.get(parts.slice(0, depth).map((part) => part.name).join('>'));
    if (!found) continue;
    const start = parts[depth - 1].start;
    return (found.find((node) => node.definition.start === start) ?? found[0]).id;
  }
  return undefined;
}

/** The ids of a node's changed symbols, itself included: what a context row's Viewed marks. */
export function changedIds(node: TreeSymbolNode): string[] {
  const ids: string[] = node.symbol ? [node.id] : [];
  for (const child of node.children) ids.push(...changedIds(child));
  return ids;
}

/** The rows in `keep`, nested as before: a search's matches in a file the reader has not opened. */
export function pruneSymbols(nodes: readonly TreeSymbolNode[], keep: ReadonlySet<string>): TreeSymbolNode[] {
  return nodes.filter((node) => keep.has(node.id)).map((node) => ({ ...node, children: pruneSymbols(node.children, keep) }));
}

/**
 * Where a row takes the reader: its symbol, or for a context row, its definition, revealing down to the first change
 * under it. The definition is the one on that change's side, from the change's own parents: a context row's own was
 * read on the side of the child that made it, which a search can leave out, and a removed child's old-side lines would
 * then land on the new file's line numbers. The file's top-level row (Imports, Top level) goes to its first changed
 * line, as its outline entry does (`topLevelSymbol`).
 */
export function rowDestination(node: TreeSymbolNode | TopLevelChanges): ChangedSymbol | undefined {
  if (!('id' in node)) return topLevelSymbol(node);
  if (node.symbol) return node.symbol;
  const first = (function find(nodes: readonly TreeSymbolNode[]): ChangedSymbol | undefined {
    for (const child of nodes) {
      const found = child.symbol ?? find(child.children);
      if (found) return found;
    }
    return undefined;
  })(node.children);
  if (!first) return undefined;
  const depth = node.id.split('>').length - 1;
  const definition = first.id.startsWith(`${node.id}>`) ? (first.parents[depth] ?? node.definition) : node.definition;
  return { ...first, id: node.id, change: 'modified', definition, parents: first.parents.slice(0, depth) };
}

/**
 * A symbol row's name. An impl block reads as the outline names it, its keyword first (`impl FieldCommand`,
 * `impl Display for Field`), so it reads apart from `struct FieldCommand` beside it; any other symbol whose name a
 * sibling's shows the same takes its keyword too (`fn`, `class`), and the rest read as their names.
 */
export function rowName(node: TreeSymbolNode, siblings: readonly TreeSymbolNode[] = []): string {
  if (node.id.endsWith('>@body')) return node.definition.name;
  const shown = (one: TreeSymbolNode) => (one.definition.kind === 'impl' ? one.definition.crumb || `impl ${one.definition.name}` : one.definition.name);
  const own = shown(node);
  const { crumbKeyword } = node.definition;
  if (node.definition.kind !== 'impl' && crumbKeyword && siblings.some((other) => other !== node && shown(other) === own)) return `${crumbKeyword} ${own}`;
  return own;
}
