import { treeSymbolKind, type TopLevelChanges, type TreeSymbolKind, type TreeSymbolNode } from './tree-symbols';

/**
 * The Changes file tree's paths for @pierre/trees when it lists changed symbols (lib/tree-symbols.ts). Pierre builds
 * its rows from paths, so a file with symbol support is a folder of its own: `src/store.ts/` holds `Store/`, which holds
 * `flush`. The paths carry what the rows need and Pierre cannot be told otherwise:
 * - a file's folder ends in FILE_MARK, so the tree's CSS gives it its file-type icon rather than a folder's look;
 * - a symbol's segment is its name, then a code naming its icon and tint, which picks the row's icon (Pierre remaps
 *   icons by a part of the name) and its muted look;
 * - repeats among siblings (overloads) differ by REPEAT marks.
 * Every mark is an invisible format character, so a row shows just the name. Names keep their text; a `/` in one shows
 * as a division slash, which looks the same and does not split the path.
 *
 * Pierre's own flattening of empty folders (`a/b/c` as one row) would fold a file into a folder that holds only it, and
 * a class into a file that holds only it, so it is off: real folders are flattened here instead, the same way, and
 * file and symbol folders never are. The paths are in the order the tree shows (presorted): the files in the diff's
 * order, each file's top-level changes first, then its symbols in source order.
 */

export const FILE_MARK = '⁢';
const OPEN = '⁣',
  CLOSE = '⁤',
  REPEAT = '⁡',
  BIT0 = '​',
  BIT1 = '‌';
/** Shows like `/` in a name without splitting the path. */
export const NAME_SLASH = '∕';
/** Between the folders of a flattened row, as Pierre's own flattened rows show them. */
const FLATTENED = ` ${NAME_SLASH} `;

/** A row's icon: a symbol's kind, the file's top-level changes, or a note in place of symbols. */
export type TreeRowIcon = TreeSymbolKind | 'top' | 'imports' | 'loading' | 'note';
/** How a row is tinted: by its symbol's change, muted for context and notes. */
export type TreeRowTint = 'added' | 'modified' | 'removed' | 'context' | 'muted';
export const ROW_ICONS: readonly TreeRowIcon[] = ['function', 'method', 'class', 'interface', 'type', 'enum', 'variable', 'module', 'top', 'imports', 'loading', 'note'];
export const ROW_TINTS: readonly TreeRowTint[] = ['added', 'modified', 'removed', 'context', 'muted'];
const bits = (value: number, width: number) =>
  Array.from({ length: width }, (_, index) => ((value >> (width - 1 - index)) & 1 ? BIT1 : BIT0)).join('');
/** The invisible code at the end of a row's segment for this icon and tint. */
export const rowCode = (icon: TreeRowIcon, tint: TreeRowTint) =>
  `${OPEN}${bits(ROW_ICONS.indexOf(icon), 4)}${bits(ROW_TINTS.indexOf(tint), 3)}${CLOSE}`;
const CODE_LENGTH = rowCode('function', 'added').length;
/** Every code in use, for the icon rules and the CSS. */
export function rowCodes(): { icon: TreeRowIcon; tint: TreeRowTint; code: string }[] {
  const codes: { icon: TreeRowIcon; tint: TreeRowTint; code: string }[] = [];
  for (const icon of ROW_ICONS) {
    const tints: readonly TreeRowTint[] = icon === 'top' || icon === 'imports' || icon === 'loading' || icon === 'note' ? ['muted'] : ['added', 'modified', 'removed', 'context'];
    for (const tint of tints) codes.push({ icon, tint, code: rowCode(icon, tint) });
  }
  return codes;
}
/** The last character of every symbol row's segment. */
export const CODE_END = CLOSE;
const MARKS = new RegExp(`[${FILE_MARK}${OPEN}${CLOSE}${REPEAT}${BIT0}${BIT1}]`, 'g');
/** A name as a path segment: no slash, and none of the marks. */
const segmentName = (name: string) => (name.replace(MARKS, '').replaceAll('/', NAME_SLASH) || 'anonymous');

/** A file's symbols, as the tree has them. */
export type FileSymbols =
  | { state: 'loading' }
  | { state: 'none'; reason: string }
  | { state: 'ready'; nodes: readonly TreeSymbolNode[]; top?: TopLevelChanges };

/** What one of the tree's rows is. */
export type TreeRow =
  /** A real folder: `path` is its folder in the entries' keys, with a trailing slash. */
  | { type: 'folder'; path: string }
  /** A file: `folder` when it is a folder of symbols. */
  | { type: 'file'; key: string; folder: boolean }
  | { type: 'symbol'; key: string; node: TreeSymbolNode }
  | { type: 'top'; key: string; top: TopLevelChanges }
  | { type: 'note'; key: string; text: string; loading: boolean };

export interface SymbolTreePaths {
  /** In the order the tree shows them. */
  paths: string[];
  /** Each row by its path, directories with and without their trailing slash. */
  rows: Map<string, TreeRow>;
  /** A file's row path by its key, and a real folder's by its path (with a slash). */
  pierreOf: Map<string, string>;
  /** A symbol's row path by `symbolRowKey`. */
  symbolPaths: Map<string, string>;
  /** Every directory row by what stays the same across rebuilds: a folder's path, a file's key, a symbol's row key. */
  directories: Map<string, string>;
}
export const symbolRowKey = (file: string, id: string) => `${file}\u0000${id}`;

interface Folder {
  name: string;
  path: string;
  folders: Map<string, Folder>;
  /** Children in the entries' order: folders and file keys. */
  order: (Folder | string)[];
}

const TEXT = { loading: 'Loading symbols…' };

/**
 * The tree's paths for `keys`, the entries' keys in the tree's order (lib/tree-file-order.ts). Files in `folders` are
 * folders of symbols; `symbols` has what is known of each one's symbols. A file in `expanded` that is still loading, or
 * has no symbols to show, has one note row saying so; one that is not expanded has its symbols when they are known,
 * so search finds them, and nothing otherwise.
 */
export function symbolTreePaths(
  keys: readonly string[],
  folders: ReadonlySet<string>,
  symbols: ReadonlyMap<string, FileSymbols>,
  expanded: ReadonlySet<string>
): SymbolTreePaths {
  const root: Folder = { name: '', path: '', folders: new Map(), order: [] };
  for (const key of keys) {
    const parts = key.split('/');
    let folder = root;
    for (const part of parts.slice(0, -1)) {
      let next = folder.folders.get(part);
      if (!next) {
        next = { name: part, path: `${folder.path}${part}/`, folders: new Map(), order: [] };
        folder.folders.set(part, next);
        folder.order.push(next);
      }
      folder = next;
    }
    folder.order.push(key);
  }
  const out: SymbolTreePaths = { paths: [], rows: new Map(), pierreOf: new Map(), symbolPaths: new Map(), directories: new Map() };
  const setRow = (path: string, row: TreeRow, directory: boolean) => {
    out.rows.set(path, row);
    if (directory) out.rows.set(path.slice(0, -1), row);
  };
  const leaf = (path: string, row: TreeRow) => {
    out.paths.push(path);
    setRow(path, row, false);
  };
  const emitNodes = (file: string, base: string, nodes: readonly TreeSymbolNode[]) => {
    const used = new Set<string>();
    for (const node of nodes) {
      const icon: TreeRowIcon = treeSymbolKind(node.definition.kind);
      const tint: TreeRowTint = node.change === 'context' ? 'context' : node.change;
      let segment = `${segmentName(node.definition.name)}${rowCode(icon, tint)}`;
      while (used.has(segment)) segment = `${segment.slice(0, -CODE_LENGTH)}${REPEAT}${segment.slice(-CODE_LENGTH)}`;
      used.add(segment);
      const row: TreeRow = { type: 'symbol', key: file, node };
      if (node.children.length) {
        const path = `${base}${segment}/`;
        setRow(path, row, true);
        out.symbolPaths.set(symbolRowKey(file, node.id), path);
        out.directories.set(symbolRowKey(file, node.id), path);
        emitNodes(file, path, node.children);
      } else {
        const path = `${base}${segment}`;
        out.symbolPaths.set(symbolRowKey(file, node.id), path);
        leaf(path, row);
      }
    }
  };
  const emitFile = (key: string, base: string) => {
    const name = key.slice(key.lastIndexOf('/') + 1);
    if (!folders.has(key)) {
      out.pierreOf.set(key, base + name);
      leaf(base + name, { type: 'file', key, folder: false });
      return;
    }
    const path = `${base}${name}${FILE_MARK}/`;
    out.pierreOf.set(key, path);
    out.directories.set(key, path);
    setRow(path, { type: 'file', key, folder: true }, true);
    const known = symbols.get(key);
    const note = (text: string, loading: boolean) =>
      leaf(`${path}${segmentName(text)}${rowCode(loading ? 'loading' : 'note', 'muted')}`, { type: 'note', key, text, loading });
    const before = out.paths.length;
    if (known?.state === 'ready') {
      // Imports and top-level statements head the file, as they do in its source: first, then the symbols.
      if (known.top)
        leaf(`${path}${known.top.imports ? 'Imports' : 'Top level'}${rowCode(known.top.imports ? 'imports' : 'top', 'muted')}`, { type: 'top', key, top: known.top });
      emitNodes(key, path, known.nodes);
      if (out.paths.length === before && expanded.has(key)) note('No symbols changed', false);
    } else if (expanded.has(key)) note(known?.state === 'none' ? known.reason : TEXT.loading, known?.state !== 'none');
    // A folder with nothing in it yet is listed as one, so it shows its chevron.
    if (out.paths.length === before) out.paths.push(path);
  };
  const emitFolder = (folder: Folder, base: string) => {
    // Flattened as Pierre flattens: a folder whose one child is a folder shows as one row with it.
    let chain = folder;
    const names = [folder.name];
    while (chain.order.length === 1 && typeof chain.order[0] !== 'string') {
      chain = chain.order[0];
      names.push(chain.name);
    }
    const path = `${base}${names.map(segmentName).join(FLATTENED)}/`;
    const row: TreeRow = { type: 'folder', path: chain.path };
    setRow(path, row, true);
    // Each folder of the chain finds the one row.
    for (let at: Folder | undefined = folder; at; at = at === chain ? undefined : (at.order[0] as Folder)) out.pierreOf.set(at.path, path);
    out.directories.set(chain.path, path);
    emitChildren(chain, path);
  };
  const emitChildren = (folder: Folder, base: string) => {
    for (const child of folder.order) {
      if (typeof child === 'string') emitFile(child, base);
      else emitFolder(child, base);
    }
  };
  emitChildren(root, '');
  return out;
}
