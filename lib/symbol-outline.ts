import type { GapHunk } from './diff-gaps';
import { definitionNoun } from './hunk-scopes';
import type { SyntaxDefinition } from './syntax-scope';

/**
 * The symbols a file's changes touch (#394), for the outline above its diff: "Changes 2 functions and a class". Each
 * changed line belongs to the innermost definition around it, on its own side: added lines to the new file's tree,
 * deleted lines to the old file's. A symbol is matched across the two sides by its path of kinds and names, such as
 * `class:Store>method:flush`, so it is
 * - added when it is only in the new file,
 * - removed when it is only in the old file,
 * - modified when it is in both and a changed line falls inside it.
 * A symbol inside an added (or removed) one folds into it: an added class lists once, not once per method. Lines
 * outside every definition (imports, top-level statements) are no symbol.
 *
 * Without the old file's tree, deleted lines count towards the new file's symbol around where they were, and a
 * symbol is added only when every line of it is added.
 */
export type SymbolChange = 'added' | 'modified' | 'removed';
export interface ChangedSymbol {
  /** The symbol's path of kinds and names, stable across revisions: what its viewed mark is kept under. */
  id: string;
  change: SymbolChange;
  /** The definition, in its side's line numbers: the old file's for a removed symbol, else the new file's. */
  definition: SyntaxDefinition;
  side: 'after' | 'before';
  /** The definitions around it on its side, outermost first. */
  parents: SyntaxDefinition[];
  /** Its first changed line, on that line's side: the old side for a deleted line. */
  first: { side: 'after' | 'before'; line: number };
  added: number;
  deleted: number;
}

/** Each definition's id: its path of `kind:name`, with `#2`, `#3`… for repeats such as overloads. */
function definitionIds(definitions: readonly SyntaxDefinition[]): Map<SyntaxDefinition, { id: string; parents: SyntaxDefinition[] }> {
  const ids = new Map<SyntaxDefinition, { id: string; parents: SyntaxDefinition[] }>();
  const seen = new Map<string, number>();
  const stack: SyntaxDefinition[] = [];
  const sorted = [...definitions].sort((a, b) => a.start - b.start || b.end - a.end);
  for (const definition of sorted) {
    while (stack.length && !(stack[stack.length - 1].start <= definition.start && stack[stack.length - 1].end >= definition.end)) stack.pop();
    const parent = stack.at(-1);
    const own = `${definition.kind}:${definition.name}`;
    const base = parent ? `${ids.get(parent)?.id ?? ''}>${own}` : own;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    ids.set(definition, { id: count > 1 ? `${base}#${count}` : base, parents: [...stack] });
    stack.push(definition);
  }
  return ids;
}

/** The smallest definition holding `line`, including one that is only that line. */
function innermost(definitions: readonly SyntaxDefinition[], line: number): SyntaxDefinition | undefined {
  let best: SyntaxDefinition | undefined;
  for (const definition of definitions)
    if (definition.start <= line && definition.end >= line && (!best || definition.end - definition.start < best.end - best.start))
      best = definition;
  return best;
}

export function changedSymbols(
  hunks: readonly GapHunk[],
  definitions: { after?: readonly SyntaxDefinition[]; before?: readonly SyntaxDefinition[] },
  /**
   * Changed lines the outline leaves out, by side and line: formatting or comments the reader hides (#396). A symbol
   * whose every change is left out is not listed; its diff still shows the change, collapsed.
   */
  skip?: (side: 'before' | 'after', line: number) => boolean
): ChangedSymbol[] | undefined {
  const after = definitions.after;
  if (!after) return undefined;
  const before = definitions.before;
  const afterIds = definitionIds(after);
  const beforeIds = before ? definitionIds(before) : undefined;
  const beforeById = new Set(beforeIds ? [...beforeIds.values()].map((entry) => entry.id) : []);
  const afterById = new Map([...afterIds].map(([definition, entry]) => [entry.id, definition]));
  interface Entry {
    definition: SyntaxDefinition;
    side: 'after' | 'before';
    order: number;
    first: ChangedSymbol['first'];
    added: number;
    deleted: number;
  }
  const entries = new Map<string, Entry>();
  const addedLines = new Set<number>();
  const touch = (definition: SyntaxDefinition, side: 'after' | 'before', order: number, at: ChangedSymbol['first'], added: number, deleted: number) => {
    const id = (side === 'after' ? afterIds : beforeIds)?.get(definition)?.id;
    if (!id) return;
    // A symbol in both files gathers its added and deleted lines under the new file's definition.
    const own = side === 'before' && afterById.has(id) ? { definition: afterById.get(id) as SyntaxDefinition, side: 'after' as const } : { definition, side };
    const entry = entries.get(id);
    if (entry) {
      entry.added += added;
      entry.deleted += deleted;
      return;
    }
    entries.set(id, { ...own, order, first: at, added, deleted });
  };
  let order = 0;
  for (const hunk of hunks) {
    let oldLine = hunk.oldStart,
      newLine = hunk.newStart;
    for (const row of hunk.rows) {
      order++;
      if (skip && row.type !== ' ' && skip(row.type === '+' ? 'after' : 'before', row.type === '+' ? newLine : oldLine)) {
        // Left out: counted as unchanged.
      } else if (row.type === '+') {
        addedLines.add(newLine);
        const definition = innermost(after, newLine);
        if (definition) touch(definition, 'after', order, { side: 'after', line: newLine }, 1, 0);
      } else if (row.type === '-') {
        const definition = before ? innermost(before, oldLine) : innermost(after, Math.max(1, newLine - 1)) ?? innermost(after, newLine);
        if (definition) touch(definition, before ? 'before' : 'after', order, { side: 'before', line: oldLine }, 0, 1);
      }
      if (row.type !== '+') oldLine++;
      if (row.type !== '-') newLine++;
    }
  }
  const symbols: (ChangedSymbol & { order: number })[] = [];
  for (const [id, entry] of entries) {
    const parents = (entry.side === 'after' ? afterIds : beforeIds)?.get(entry.definition)?.parents ?? [];
    let change: SymbolChange;
    if (entry.side === 'before') change = 'removed';
    else if (beforeIds) change = beforeById.has(id) ? 'modified' : 'added';
    else {
      let whole = true;
      for (let line = entry.definition.start; line <= entry.definition.end && whole; line++) whole = addedLines.has(line);
      change = whole ? 'added' : 'modified';
    }
    symbols.push({ id, change, definition: entry.definition, side: entry.side, parents, first: entry.first, added: entry.added, deleted: entry.deleted, order: entry.order });
  }
  // A symbol inside an added or removed one is part of it.
  const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const folded = symbols.filter((symbol) => {
    if (symbol.change === 'modified') return true;
    const parts = symbol.id.split('>');
    for (let depth = parts.length - 1; depth > 0; depth--) {
      const ancestor = byId.get(parts.slice(0, depth).join('>'));
      if (ancestor && ancestor.change === symbol.change) {
        ancestor.added += symbol.added;
        ancestor.deleted += symbol.deleted;
        if (symbol.order < ancestor.order) {
          ancestor.order = symbol.order;
          ancestor.first = symbol.first;
        }
        return false;
      }
    }
    return true;
  });
  return folded
    .sort((a, b) => a.order - b.order)
    .map((symbol): ChangedSymbol => ({
      id: symbol.id,
      change: symbol.change,
      definition: symbol.definition,
      side: symbol.side,
      parents: symbol.parents,
      first: symbol.first,
      added: symbol.added,
      deleted: symbol.deleted,
    }));
}

const PLURALS: Record<string, string> = { class: 'classes', property: 'properties', entry: 'entries' };
const plural = (noun: string, n: number) => (n === 1 ? noun : (PLURALS[noun] ?? `${noun}s`));
/**
 * What a file's changes touch, in words: "Changes 3 functions", "Changes 2 functions and 1 class", "Adds 1 test".
 * Kinds are counted in the order they first appear.
 */
export function outlineSummary(symbols: readonly ChangedSymbol[]): string {
  if (!symbols.length) return 'No functions or classes changed';
  const counts = new Map<string, number>();
  for (const symbol of symbols) {
    const noun = definitionNoun(symbol.definition);
    counts.set(noun, (counts.get(noun) ?? 0) + 1);
  }
  const parts = [...counts].map(([noun, n]) => `${n} ${plural(noun, n)}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  const changes = new Set(symbols.map((symbol) => symbol.change));
  const verb = changes.size > 1 ? 'Changes' : changes.has('added') ? 'Adds' : changes.has('removed') ? 'Removes' : 'Changes';
  return `${verb} ${list}`;
}

/** A symbol in words, for its button's accessible name: "function merge, added". */
export const spokenSymbol = (symbol: Pick<ChangedSymbol, 'definition' | 'change'>) =>
  `${definitionNoun(symbol.definition)} ${symbol.definition.name}, ${symbol.change}`;
