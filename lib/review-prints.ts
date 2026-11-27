import { BODY_PART, TOP_LEVEL_ID, bodyOwner, isBody } from './symbol-outline';
import type { TopLevelChanges, TreeSymbolNode } from './tree-symbols';

/**
 * Re-review only what changed. A tick keeps what its item read when it was ticked, as a print: a hash of the item's
 * text. When the author pushes, a tick carries to the file's new revision only where the item reads the same; one
 * whose text changed is Updated, unviewed again; one new in the revision is plain unviewed. A tick saved before
 * prints existed has none, and never carries (fail closed).
 *
 * The text is the item's own:
 * - a symbol: its definition's lines on its side (the new file's; the old file's for a removed symbol);
 * - the file's top level (`@top`): its changed lines outside every definition, added and deleted, in diff order;
 * - a container's Body: the container's own changed lines;
 * - a file without symbols (`@file`), or a whole file marked Viewed by hand: its patch.
 * Whitespace does not count: lines are trimmed, runs of spaces and tabs read as one, and blank lines drop out, so a
 * reindent or a reflowed blank line keeps the tick. Comments do count: the noise filter's comment detection works on
 * whole-file comparisons, not on one item's text.
 */

/** The prints' format: a print of another version never matches, so a change of the rules fails closed. */
export const PRINT_VERSION = 'v1';

/** The text as a print reads it: whitespace-insensitive. */
export function printText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join('\n');
}

/** FNV-1a, 32-bit, with the length: cheap and stable across runs; nothing depends on it resisting attack. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16).padStart(8, '0')}${text.length.toString(36)}`;
}

/** An item's print: its text's hash, under this version. */
export const itemPrint = (text: string) => `${PRINT_VERSION}:${hash(printText(text))}`;

/**
 * What an untick saves in place of a print (`savedPrint(UNTICKED, at)`): the item's earlier ticks stop carrying past
 * it, after a restart or the next push alike.
 */
export const UNTICKED = '-';

/** A print as saved with its tick: the print and when the tick was made, so the newest earlier tick wins. */
export const savedPrint = (print: string, at: number) => `${print}@${at}`;
export function readSavedPrint(value: string | undefined): { print: string; at: number } | undefined {
  if (!value) return undefined;
  const split = value.lastIndexOf('@');
  if (split < 0) return undefined;
  const at = Number(value.slice(split + 1));
  return Number.isFinite(at) ? { print: value.slice(0, split), at } : undefined;
}

/** The changed lines of a diff by key (`a12`, `b7`), each with its text. */
export function changedRowTexts(hunks: readonly { oldStart: number; newStart: number; rows: readonly { type: ' ' | '+' | '-'; text: string }[] }[]): Map<string, string> {
  const texts = new Map<string, string>();
  for (const hunk of hunks) {
    let oldLine = hunk.oldStart,
      newLine = hunk.newStart;
    for (const row of hunk.rows) {
      if (row.type === '+') texts.set(`a${newLine}`, row.text);
      else if (row.type === '-') texts.set(`b${oldLine}`, row.text);
      if (row.type !== '+') oldLine++;
      if (row.type !== '-') newLine++;
    }
  }
  return texts;
}

/**
 * Each counted item's print, by id. `after` and `before` are the file's two sides (either may be missing); `rows` the
 * changed lines' texts; `own` each symbol's own changed lines (`changedSymbolLines`), for Bodies. An item whose text is
 * not at hand gets no print, so it can neither carry nor be Updated.
 */
export function itemPrints({
  items,
  nodes,
  top,
  after,
  before,
  rows,
  own,
}: {
  items: readonly string[];
  nodes: readonly TreeSymbolNode[];
  top?: TopLevelChanges;
  after?: string;
  before?: string;
  rows: ReadonlyMap<string, string>;
  own?: ReadonlyMap<string, readonly string[]>;
}): Record<string, string> {
  const byId = new Map<string, TreeSymbolNode>();
  const walk = (node: TreeSymbolNode) => {
    byId.set(node.id, node);
    node.children.forEach(walk);
  };
  nodes.forEach(walk);
  const lines = { after: after?.split('\n'), before: before?.split('\n') };
  const linesText = (keys: readonly string[]) => keys.map((key) => `${key[0] === 'a' ? '+' : '-'}${rows.get(key) ?? ''}`).join('\n');
  const out: Record<string, string> = {};
  for (const id of items) {
    if (id === TOP_LEVEL_ID) {
      if (top) out[id] = itemPrint(linesText(top.lines));
      continue;
    }
    if (isBody({ id })) {
      const keys = own?.get(bodyOwner(id));
      if (keys?.length) out[id] = itemPrint(`${BODY_PART}\n${linesText(keys)}`);
      continue;
    }
    const symbol = byId.get(id)?.symbol;
    const side = symbol && lines[symbol.side];
    if (!symbol || !side) continue;
    out[id] = itemPrint(side.slice(symbol.definition.start - 1, symbol.definition.end).join('\n'));
  }
  return out;
}

/** An item's newest tick in the file's earlier revisions: its print, or none for a tick saved before prints. */
export interface EarlierTick {
  print?: string;
  at: number;
}

/**
 * What a new revision makes of the earlier ticks. Each counted item whose newest earlier tick has the print it has now
 * carries (ticked here too); one whose newest earlier tick has another print is Updated; one with no earlier tick, or
 * only one without a print, is neither. Items ticked here already are left as they are.
 */
export function planCarry({
  items,
  prints,
  earlier,
  viewed,
}: {
  items: readonly string[];
  prints: Readonly<Record<string, string>>;
  earlier: ReadonlyMap<string, EarlierTick>;
  viewed: (id: string) => boolean;
}): { carry: { id: string; at: number }[]; updated: string[] } {
  const carry: { id: string; at: number }[] = [];
  const updated: string[] = [];
  for (const id of items) {
    const tick = earlier.get(id);
    const now = prints[id];
    if (!tick?.print || !now) continue;
    if (tick.print === now) {
      if (!viewed(id)) carry.push({ id, at: tick.at });
    } else if (!viewed(id)) updated.push(id);
  }
  return { carry, updated };
}
