import { useEffect, useMemo, useRef, useState } from 'react';
import { FileTree, useFileTree, useFileTreeSelection } from '@pierre/trees/react';
import { preparePresortedFileTreeInput, type ContextMenuItem, type FileTreeDirectoryHandle, type FileTreeItemHandle, type GitStatusEntry } from '@pierre/trees';
import { TreeSymbolMenu, TreeViewedMenu } from './TreeViewedMenu';
import { TREE_WORDS, commentDecorationCSS, decorationCSS, fileRowDecoration, type ChangeTreeEntry } from './ChangesFileTree';
import { DIFF_STAT_COLORS } from './DiffStats';
import { treeSymbolLook } from './tree-symbol-icons';
import { selectedTreeFiles } from '../lib/tree-viewed-files';
import { useFileProgress } from '../lib/file-view-progress';
import type { CodeIntelligenceSettings } from '../lib/code-intelligence';
import type { NoiseFilter } from '../lib/semantic-noise';
import { TOP_LEVEL_ID, type ChangedSymbol } from '../lib/symbol-outline';
import { definitionNoun } from '../lib/hunk-scopes';
import { setTreeCursor, useReadingPlace } from '../lib/tree-symbol-sync';
import { changedIds, matchingSymbols, pruneSymbols, readingSymbol, rowDestination, topLevelName } from '../lib/tree-symbols';
import { folderProgress, progressLabel, symbolProgress, type SymbolProgress } from '../lib/tree-symbol-review';
import { symbolRowKey, symbolTreePaths, type FileSymbols, type SymbolTreePaths, type TreeRow } from '../lib/tree-symbol-paths';
import { treeSymbolsSupported, useTreeSymbols, type TreeSymbolSource } from '../lib/use-tree-symbols';

export interface SymbolTreeEntry extends ChangeTreeEntry {
  /** The file as the diff reads it: set for every file, so the tree can tell which have symbols. */
  source?: TreeSymbolSource;
}

const STATUS = { added: 'added', modified: 'modified', deleted: 'deleted', renamed: 'renamed' } as const;

/** How long a chosen symbol stays lit while the diff scrolls to it, if the diff never says it arrived. */
const HOLD_MS = 1_500;

/**
 * The Changes file tree with each file's changed symbols under it (Settings › Review, Beta): folder › file › class ›
 * method, in @pierre/trees as ChangesFileTree is, with the same rows for files and folders, the same Viewed menu,
 * selection, search and reveal. A file with symbol support is a folder to Pierre (lib/tree-symbol-paths.ts): clicking
 * its name opens the file as before, and only its chevron or the arrow keys expand it. Expanding a file reads and
 * parses it at the top priority (lib/use-tree-symbols.ts); the selected file expands by itself, and the others stay as
 * the reader leaves them. A symbol row takes the reader to the symbol as its outline does, and shares the outline's
 * Viewed ticks; the row the reader is in is lit as the diff scrolls (lib/tree-symbol-sync.ts).
 */

export function ChangesSymbolTree({
  entries,
  selected,
  query,
  onSelect,
  onPreview,
  onSetViewed,
  onGoToSymbol,
  showComments = true,
  revealSelected = false,
  codeSettings,
  noiseFilter,
  reveal,
}: {
  entries: SymbolTreeEntry[];
  selected: string;
  query: string;
  onSelect: (path: string) => void;
  onPreview?: (path: string) => void;
  onSetViewed?: (paths: string[], viewed: boolean) => Promise<boolean>;
  /** Takes the reader to a symbol of the file with this entry key. */
  onGoToSymbol: (key: string, symbol: ChangedSymbol) => void;
  showComments?: boolean;
  revealSelected?: boolean;
  codeSettings: CodeIntelligenceSettings;
  noiseFilter: NoiseFilter;
  /**
   * A symbol `n` or Shift+N went to (PrChangesView): its row is lit and selected as a click on it would, and its file
   * opens. A new `nonce` each time.
   */
  reveal?: { key: string; id: string; nonce: number };
}) {
  const progress = useFileProgress();
  // Which files list symbols: only their paths and revisions matter, not their decorations.
  const sourceSignature = entries.map((e) => `${e.key}\u0000${e.source?.fileKey ?? ''}`).join('\n');
  const supported = useMemo(() => {
    const files = new Map<string, TreeSymbolSource>();
    for (const e of entries) if (e.source && treeSymbolsSupported(e.source, codeSettings)) files.set(e.key, e.source);
    return files;
  }, [sourceSignature, codeSettings]);
  // The files expanded in the tree, as Pierre has them.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const searching = !!query.trim();
  // Every file is looked up in the caches, which reads nothing, so each file's progress shows once its symbols are
  // known; only expanded files are read and parsed.
  const known = useTreeSymbols(supported, expanded, codeSettings, noiseFilter);
  // The rows list a collapsed file's symbols only for a search: the paths, and Pierre's rebuilds, stay as small as
  // they were, and a parse landing for a collapsed file does not rebuild them.
  const listed = useRef<ReadonlyMap<string, FileSymbols>>(new Map());
  const symbols = useMemo(() => {
    if (searching) return known;
    const next = new Map([...known].filter(([key]) => expanded.has(key)));
    const last = listed.current;
    const same = next.size === last.size && [...next].every(([key, value]) => sameSymbols(value, last.get(key)));
    if (!same) listed.current = next;
    return listed.current;
  }, [known, expanded, searching]);
  // A search shows a collapsed file's matching symbols only, so a query that matches the file's path does not list
  // every symbol of every file it names.
  const shown = useMemo(() => {
    if (!searching) return symbols;
    const out = new Map<string, FileSymbols>();
    for (const [key, value] of symbols) {
      if (expanded.has(key) || value.state !== 'ready') out.set(key, value);
      else {
        const hits = matchingSymbols(value.nodes, query);
        if (hits?.size) out.set(key, { state: 'ready', nodes: pruneSymbols(value.nodes, hits) });
      }
    }
    return out;
  }, [symbols, expanded, searching, query]);
  const keys = entries.map((e) => e.key).join('\n');
  const layout = useMemo(
    () => symbolTreePaths(keys ? keys.split('\n') : [], new Set(supported.keys()), shown, expanded),
    [keys, supported, shown, expanded]
  );
  const pathSignature = layout.paths.join('\n');
  const prepared = useMemo(() => preparePresortedFileTreeInput(layout.paths), [pathSignature]);
  // Each file's progress through its changed symbols, once they are known, and each folder's sum of them: the rows'
  // `2/5` (lib/tree-symbol-review.ts). The outline's ticks, so a tick anywhere shows here.
  const fileProgress = new Map<string, SymbolProgress>();
  for (const e of entries) {
    const source = supported.get(e.key);
    const value = known.get(e.key);
    if (source && value?.state === 'ready')
      fileProgress.set(e.key, symbolProgress(value.nodes, (id) => progress.isSymbolViewed(source.fileKey, id), e.viewed, value.top));
  }
  const folderSums = folderProgress(fileProgress);
  const progressSignature = [...fileProgress, ...folderSums].map(([key, { viewed, total }]) => `${key}:${viewed}/${total}`).join('\n');
  const current = useRef({ entries, onSelect, layout, supported, progress, fileProgress, folderSums });
  current.current = { entries, onSelect, layout, supported, progress, fileProgress, folderSums };
  const rowAt = (path: string | null | undefined): TreeRow | undefined => (path ? current.current.layout.rows.get(path) : undefined);
  /** What the menus, the selection count and the Viewed actions know a row by: a file's key, a folder's path. */
  const appPath = (path: string): string | undefined => {
    const row = rowAt(path);
    return row?.type === 'file' ? row.key : row?.type === 'folder' ? row.path : undefined;
  };
  const entryOf = (key: string) => current.current.entries.find((e) => e.key === key);
  const look = treeSymbolLook();
  const { model } = useFileTree({
    preparedInput: prepared,
    // Pierre's flattening would fold a file into a folder that holds only it (lib/tree-symbol-paths.ts).
    flattenEmptyDirectories: false,
    initialExpansion: 'closed',
    initialExpandedPaths: openPaths(layout, new Set(), new Set()),
    composition: { contextMenu: { triggerMode: 'right-click' } },
    search: false,
    icons: look.icons,
    unsafeCSS: decorationCSS + (showComments ? commentDecorationCSS : '') + look.css,
    fileTreeSearchMode: 'hide-non-matches',
    renderRowDecoration: ({ item }) => {
      const row = rowAt(item.path);
      if (!row) return null;
      if (row.type === 'file') {
        const entry = entryOf(row.key);
        return entry ? fileRowDecoration(entry, showComments, current.current.fileProgress.get(row.key)) : null;
      }
      if (row.type === 'folder') {
        // The files under it whose symbols are known, summed; nothing until one of their symbols is viewed.
        const sum = current.current.folderSums.get(row.path);
        const label = progressLabel(sum);
        if (!sum || label.kind === 'none') return null;
        return {
          text: label.text,
          parts: [{ text: label.text, color: 'var(--muted-foreground)' }],
          title: `${sum.viewed} of ${sum.total} changed symbols viewed, in the files here whose symbols are listed`,
        };
      }
      if (row.type === 'top') {
        const { added, deleted, imports } = row.top;
        // Ticked like a symbol, under the top level's own id (lib/tree-symbol-review.ts).
        const topSource = current.current.supported.get(row.key);
        if (entryOf(row.key)?.viewed || (!!topSource && current.current.progress.isSymbolViewed(topSource.fileKey, TOP_LEVEL_ID)))
          return { text: 'Viewed', parts: [{ text: 'Viewed' }], title: `${topLevelName(row.top)}: viewed` };
        if (row.top.quiet) {
          const word = 'Quiet';
          return { text: word, parts: [{ text: word, color: 'var(--muted-foreground)' }], title: `${added} additions, ${deleted} deletions, every one quiet` };
        }
        return {
          text: `+${added} −${deleted}`,
          parts: [
            { text: `+${added}`, color: DIFF_STAT_COLORS.added },
            { text: `−${deleted}`, color: DIFF_STAT_COLORS.removed },
          ],
          title: `${added} additions, ${deleted} deletions ${imports ? 'to imports' : 'outside every function and class'}`,
        };
      }
      if (row.type !== 'symbol') return null;
      const { node } = row;
      if (!node.symbol) return null;
      const source = current.current.supported.get(row.key);
      const viewed = !!entryOf(row.key)?.viewed || (!!source && current.current.progress.isSymbolViewed(source.fileKey, node.id));
      const quiet = !viewed && node.quiet ? (TREE_WORDS[node.quiet] ?? 'Quiet') : undefined;
      const moved = node.moved ? [{ text: '⇄', color: 'var(--muted-foreground)' }] : [];
      const spoken = `${definitionNoun(node.definition)} ${node.definition.name}, ${node.change}`;
      return {
        text: viewed ? 'Viewed' : (quiet ?? `+${node.added} −${node.deleted}`),
        parts: [
          ...moved,
          ...(viewed
            ? [{ text: 'Viewed' }]
            : quiet
              ? [{ text: quiet, color: 'var(--muted-foreground)' }]
              : [
                  { text: `+${node.added}`, color: DIFF_STAT_COLORS.added },
                  { text: `−${node.deleted}`, color: DIFF_STAT_COLORS.removed },
                ]),
        ],
        title: `${spoken}. ${viewed ? 'Viewed' : `${node.added} additions, ${node.deleted} deletions`}${node.quiet ? `. ${node.quiet}: every change is quiet` : ''}${node.moved ? `. ${node.moved}` : ''}`,
      };
    },
  });
  const selectedPaths = useFileTreeSelection(model);
  const [matchingPaths, setMatchingPaths] = useState<ReadonlySet<string>>();
  const selectOnly = (path?: string) => {
    for (const key of model.getSelectedPaths()) if (key !== path) model.getItem(key)?.deselect();
    if (path) model.getItem(path)?.select();
  };
  const rowPath = (event: Event) => {
    const row = event.composedPath().find((node) => node instanceof Element && node.hasAttribute('data-item-path'));
    return row instanceof Element ? row.getAttribute('data-item-path') : null;
  };
  // The files Pierre shows expanded. Read on each of its changes: a chevron, an arrow key or a search opens files.
  useEffect(() => {
    const read = () => {
      const open = new Set<string>();
      for (const key of current.current.supported.keys()) {
        if (folderOf(model.getItem(current.current.layout.pierreOf.get(key) ?? ''))?.isExpanded()) open.add(key);
      }
      setExpanded((previous) => (previous.size === open.size && [...open].every((key) => previous.has(key)) ? previous : open));
    };
    read();
    return model.subscribe(read);
  }, [model, supported]);
  // Symbol rows read Viewed from the outline's ticks: a tick anywhere renders this tree, and the rows' decorations are
  // refreshed only when one of theirs changed.
  let viewedSignature = '';
  for (const id of layout.symbolPaths.keys()) {
    const [key, symbol] = id.split('\u0000');
    const source = supported.get(key);
    viewedSignature += source && progress.isSymbolViewed(source.fileKey, symbol) ? '1' : '0';
  }
  // Folders the reader closed: a rebuild of the paths keeps what is open as it was. Real folders and symbols with
  // children open the first time they show; files do not.
  const closed = useRef(new Set<string>());
  const applied = useRef<{ layout: SymbolTreePaths; entries: unknown; viewed: string; progress: string }>(undefined);
  const applyStatus = useRef(() => {});
  useEffect(() => {
    const last = applied.current;
    if (last && last.layout === layout && last.entries === entries && last.viewed === viewedSignature && last.progress === progressSignature) return;
    // What is open now, by what stays the same across rebuilds.
    const open = new Set<string>();
    if (last)
      for (const [id, path] of last.layout.directories) {
        const item = folderOf(model.getItem(path));
        if (!item) continue;
        if (item.isExpanded()) {
          open.add(id);
          closed.current.delete(id);
        } else closed.current.add(id);
      }
    applied.current = { layout, entries, viewed: viewedSignature, progress: progressSignature };
    // Resetting also refreshes Pierre's row decorations: counts, Viewed, quiet words.
    model.resetPaths({ preparedInput: prepared, initialExpandedPaths: openPaths(layout, open, closed.current) });
    applyStatus.current();
  }, [model, layout, prepared, entries, viewedSignature, progressSignature]);
  // The file and the symbol the reader is in.
  const readingFile = supported.get(selected);
  const place = useReadingPlace(readingFile?.fileKey);
  // A symbol the reader chose is lit at once, and stays lit while the diff scrolls to it: on the way, the diff names
  // the places it passes (the file's top level, other symbols), which would flash in the tree for a frame. The hold
  // ends when the diff arrives inside the symbol, or after HOLD_MS if it never says so.
  const [held, setHeld] = useState<{ key: string; id: string } | undefined>();
  const live = useMemo((): { path: string | undefined; id?: string } => {
    const known = symbols.get(selected);
    if (!place || known?.state !== 'ready') return { path: undefined };
    // Outside every definition: the file's top-level row.
    if (!place.length) {
      const path = layout.symbolPaths.get(symbolRowKey(selected, TOP_LEVEL_ID));
      return { path, id: path ? TOP_LEVEL_ID : undefined };
    }
    const id = readingSymbol(known.nodes, place);
    return { path: id ? layout.symbolPaths.get(symbolRowKey(selected, id)) : undefined, id };
  }, [place, symbols, selected, layout]);
  const arrived = !!held && held.key === selected && !!live.id && (live.id === held.id || live.id.startsWith(`${held.id}>`));
  useEffect(() => {
    if (!held) return;
    // A symbol in another file waits for that file to be selected; the timer ends the hold either way.
    if (arrived) {
      setHeld(undefined);
      return;
    }
    const timer = setTimeout(() => setHeld(undefined), HOLD_MS);
    return () => clearTimeout(timer);
  }, [held, arrived]);
  const readingPath = held && !arrived && held.key === selected ? layout.symbolPaths.get(symbolRowKey(held.key, held.id)) : live.path;
  applyStatus.current = () => {
    const status: GitStatusEntry[] = [];
    for (const e of entries) {
      const path = layout.pierreOf.get(e.key);
      if (path) status.push({ path, status: STATUS[e.status] });
    }
    // The one status no file here has lights the reading row (components/tree-symbol-icons.ts).
    if (readingPath) status.push({ path: readingPath, status: 'untracked' });
    model.setGitStatus(status);
  };
  useEffect(() => applyStatus.current(), [model, readingPath]);
  const searched = useRef<unknown>(undefined);
  useEffect(() => {
    // Rows that came in during a search (a file's symbols landed) are matched too: Pierre matches the rows it had.
    if (query.trim() && searched.current !== undefined && searched.current !== prepared) model.setSearch(null);
    searched.current = query.trim() ? prepared : undefined;
    model.setSearch(query || null);
    const matching = query.trim() ? new Set(model.getSearchMatchingPaths().flatMap((path) => { const row = rowAt(path); return row && row.type !== 'folder' ? [row.key] : []; })) : undefined;
    setMatchingPaths(matching);
    if (matching) {
      const files = new Set(selectedTreeFiles(current.current.entries, mapped(model.getSelectedPaths()), matching).map((entry) => entry.key));
      for (const path of model.getSelectedPaths()) {
        const app = appPath(path);
        if (!app || (!files.has(app) && ![...files].some((file) => app.endsWith('/') && file.startsWith(app)))) model.getItem(path)?.deselect();
      }
    }
  }, [model, query, prepared]);
  /** Pierre's selected rows as the entries know them; symbol rows are not files and drop out. */
  const mapped = (paths: readonly string[]) => paths.flatMap((path) => appPath(path) ?? []);
  // The selected file opens by itself, and closes again when the reader moves on, unless they opened or closed it.
  const auto = useRef<string>(undefined);
  // The selection last acted on: a file the reader closed by hand stays closed while it stays selected.
  const handled = useRef<string>(undefined);
  const selectedPath = layout.pierreOf.get(selected);
  useEffect(() => {
    if (handled.current === selected || !selectedPath || model.getSelectedPaths().length > 1) return;
    handled.current = selected;
    const previous = auto.current;
    if (previous && previous !== selected) {
      const item = folderOf(model.getItem(layout.pierreOf.get(previous) ?? ''));
      if (item?.isExpanded()) item.collapse();
      auto.current = undefined;
    }
    const item = supported.has(selected) ? folderOf(model.getItem(selectedPath)) : undefined;
    if (item && !item.isExpanded()) {
      item.expand();
      auto.current = selected;
    }
  }, [model, selected, selectedPath, supported]);
  const revealed = useRef<{ model: typeof model; path: string } | null>(null);
  useEffect(() => {
    const item = selectedPath ? model.getItem(selectedPath) : null;
    // The scrolling diff identifies the current file; it must not expand a user's bulk selection.
    if (model.getSelectedPaths().length <= 1) {
      // A symbol row of the current file stays selected: the reader chose it.
      const keep = (path: string) => {
        const row = rowAt(path);
        return path === selectedPath || (!!row && row.type !== 'file' && row.type !== 'folder' && row.key === selected);
      };
      for (const path of model.getSelectedPaths()) if (!keep(path)) model.getItem(path)?.deselect();
      if (!model.getSelectedPaths().length) item?.select();
    }
    if (!item || !selectedPath || !revealSelected || model.getSelectedPaths().length > 1) {
      revealed.current = null;
      return;
    }
    // An inventory or decoration update must not undo manual tree scrolling.
    // Reveal only a new selection (or the first time that selection is available).
    if (revealed.current?.model !== model || revealed.current.path !== selectedPath) {
      model.scrollToPath(selectedPath, { focus: false, offset: 'nearest' });
      revealed.current = { model, path: selectedPath };
    }
  }, [model, selected, selectedPath, prepared, revealSelected]);
  // The symbol the reader is in comes into view as the diff scrolls, as the current file does.
  useEffect(() => {
    if (readingPath && revealSelected && model.getSelectedPaths().length <= 1) model.scrollToPath(readingPath, { focus: false, offset: 'nearest' });
  }, [model, readingPath, revealSelected]);
  // A symbol `n` went to: lit at once and held until the diff arrives, as a click holds it. Its file opens; a file
  // being selected opens by itself, and one already selected that the reader closed opens again: they asked for it.
  const revealing = useRef<{ key: string; id: string }>(undefined);
  useEffect(() => {
    if (!reveal) return;
    setHeld({ key: reveal.key, id: reveal.id });
    revealing.current = { key: reveal.key, id: reveal.id };
    if (reveal.key === selected) folderOf(model.getItem(layout.pierreOf.get(reveal.key) ?? ''))?.expand();
  }, [reveal?.nonce]);
  // Its row is selected once it is listed and its file is the current one, so the current file's selection keeps it.
  useEffect(() => {
    const target = revealing.current;
    if (!target || target.key !== selected) return;
    const path = layout.symbolPaths.get(symbolRowKey(target.key, target.id));
    if (!path) return;
    revealing.current = undefined;
    if (model.getSelectedPaths().length <= 1) selectOnly(path);
  }, [model, layout, selected, reveal?.nonce]);
  const activate = (row: TreeRow | undefined) => {
    if (!row || row.type === 'folder') return;
    if (row.type === 'symbol') {
      const symbol = rowDestination(row.node);
      if (symbol) {
        setHeld({ key: row.key, id: row.node.id });
        setTreeCursor(row.key, row.node.id);
        onGoToSymbol(row.key, symbol);
      }
      return;
    }
    if (row.type === 'top') {
      // The file's top-level changes go to their first changed line, as a symbol row goes to its symbol.
      setHeld({ key: row.key, id: TOP_LEVEL_ID });
      setTreeCursor(row.key, TOP_LEVEL_ID);
      const symbol = rowDestination(row.top);
      if (symbol) onGoToSymbol(row.key, symbol);
      return;
    }
    current.current.onSelect(row.key);
  };
  /** What V and the Viewed menu tick for a row: a symbol's changed symbols, or the file's top-level changes. */
  const symbolIds = (row: TreeRow | undefined) => (row?.type === 'symbol' ? changedIds(row.node) : row?.type === 'top' ? [TOP_LEVEL_ID] : []);
  const markSymbols = (row: TreeRow | undefined, viewed?: boolean) => {
    const source = row?.type === 'symbol' || row?.type === 'top' ? supported.get(row.key) : undefined;
    const ids = symbolIds(row);
    if (!source || !ids.length) return;
    const now = ids.filter((id) => progress.isSymbolViewed(source.fileKey, id)).length;
    // Never the file: Viewed collapses it, which would take the code away from under the reader.
    void progress.markSymbolsViewed(source.fileKey, ids, viewed ?? now < ids.length);
  };
  const selectedFiles = selectedTreeFiles(entries, mapped(selectedPaths), matchingPaths);
  return (
    <div className="file-tree-selection-workspace">
      <div className="file-tree-selection-status">
        {selectedFiles.length > 1 ? (
          <>
            <span role="status">{selectedFiles.length} files selected</span>
            <button type="button" onClick={() => { selectOnly(); model.getFocusedItem()?.focus(); }} aria-label="Clear file selection">Clear</button>
          </>
        ) : (
          <span>Shift-click to select a range</span>
        )}
      </div>
      <FileTree
        model={model}
        renderContextMenu={onSetViewed ? (item, context) => {
          const row = rowAt(item.path);
          if (row?.type === 'symbol' || row?.type === 'top') {
            const source = supported.get(row.key);
            const ids = symbolIds(row);
            if (!source || !ids.length) return null;
            return (
              <TreeSymbolMenu
                context={context}
                label={row.type === 'top' ? topLevelName(row.top) : `${definitionNoun(row.node.definition)} ${row.node.definition.name}`}
                what={row.type === 'top' ? (row.top.imports ? 'imports' : 'top-level changes') : undefined}
                count={ids.length}
                viewed={ids.filter((id) => progress.isSymbolViewed(source.fileKey, id)).length}
                onSetViewed={(viewed) => markSymbols(row, viewed)}
              />
            );
          }
          // A file's other rows act on the file, as its own row does.
          const target: ContextMenuItem | undefined =
            row?.type === 'folder'
              ? { kind: 'directory', name: item.name, path: row.path }
              : row
                ? { kind: 'file', name: row.key.slice(row.key.lastIndexOf('/') + 1), path: row.key }
                : undefined;
          if (!target) return null;
          return (
            <TreeViewedMenu
              item={target}
              context={context}
              entries={entries}
              matchingPaths={matchingPaths}
              selectedPaths={mapped(model.getSelectedPaths())}
              onSetViewed={onSetViewed}
            />
          );
        } : undefined}
        className="changes-file-tree"
        aria-label="Changed files"
        onClickCapture={(event) => {
          if (event.shiftKey || event.metaKey || event.ctrlKey) return;
          const path = rowPath(event.nativeEvent);
          const row = rowAt(path);
          // Folders and plain files act as Pierre has them act.
          if (!path || !row || row.type === 'folder' || (row.type === 'file' && !row.folder)) return;
          event.stopPropagation();
          const item = model.getItem(path);
          const chevron = event.nativeEvent.composedPath().some((node) => node instanceof Element && node.getAttribute('data-item-section') === 'icon');
          const folder = folderOf(item);
          if (chevron && folder) {
            if (row.type === 'file' && auto.current === row.key) auto.current = undefined;
            folder.toggle();
            return;
          }
          // The name opens the file, or goes to the symbol; only the chevron expands.
          selectOnly(path);
          item?.focus();
          activate(row);
        }}
        onClick={(event) => {
          if (event.shiftKey || event.metaKey || event.ctrlKey || !rowPath(event.nativeEvent)) return;
          const row = rowAt(model.getFocusedPath());
          if (row?.type === 'file') activate(row);
        }}
        onContextMenuCapture={(event) => {
          const path = rowPath(event.nativeEvent);
          if (path && !model.getSelectedPaths().includes(path)) selectOnly(path);
        }}
        onPointerOver={(event) => {
          const row = rowAt(rowPath(event.nativeEvent));
          if (row && row.type !== 'folder') onPreview?.(row.key);
        }}
        onFocusCapture={() => {
          const row = rowAt(model.getFocusedPath());
          if (row && row.type !== 'folder') onPreview?.(row.key);
        }}
        onKeyUp={(event) => {
          const row = rowAt(model.getFocusedPath());
          if (row && row.type !== 'folder') onPreview?.(row.key);
          // A symbol row moved to with the keys is where `n` starts from, as one chosen is.
          if ((row?.type === 'symbol' || row?.type === 'top') && TREE_MOVES.has(event.key))
            setTreeCursor(row.key, row.type === 'top' ? TOP_LEVEL_ID : row.node.id);
        }}
        onKeyDownCapture={(event) => {
          if (event.nativeEvent.composedPath().some((node) => node instanceof Element && node.closest('[data-file-tree-context-menu-root]'))) return;
          if (event.key === 'Escape' && model.getSelectedPaths().length > 1) {
            event.preventDefault();
            event.stopPropagation();
            selectOnly();
            return;
          }
          const path = model.getFocusedPath();
          const row = rowAt(path);
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            if (path && !model.getSelectedPaths().includes(path)) selectOnly(path);
          }
          // The arrow keys open and close a file as its chevron does; the reader's choice then stays.
          if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && row?.type === 'file' && auto.current === row.key) auto.current = undefined;
          // V marks the symbol Viewed, as its tick in the outline does.
          if ((event.key === 'v' || event.key === 'V') && !event.metaKey && !event.ctrlKey && !event.altKey && (row?.type === 'symbol' || row?.type === 'top')) {
            event.preventDefault();
            event.stopPropagation();
            markSymbols(row);
            return;
          }
          if (event.key === 'Enter' && row && row.type !== 'folder') {
            event.preventDefault();
            event.stopPropagation();
            activate(row);
          }
        }}
      />
    </div>
  );
}

/**
 * The directories to show open after a rebuild: real folders and symbols with children unless the reader closed them,
 * and files only when they were open.
 */
function openPaths(layout: SymbolTreePaths, open: ReadonlySet<string>, closed: ReadonlySet<string>) {
  const paths: string[] = [];
  for (const [id, path] of layout.directories) {
    const file = layout.rows.get(path)?.type === 'file';
    if (open.has(id) || (!file && !closed.has(id))) paths.push(path);
  }
  return paths;
}

/** The keys that move the tree's focus from row to row. */
const TREE_MOVES = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

const folderOf = (item: FileTreeItemHandle | null | undefined): FileTreeDirectoryHandle | undefined =>
  item?.isDirectory() ? (item as FileTreeDirectoryHandle) : undefined;

/** Whether a file's symbols are the same for the rows: the same result, or both still loading, or both none alike. */
function sameSymbols(a: FileSymbols, b: FileSymbols | undefined) {
  if (a === b) return true;
  if (!b || a.state !== b.state) return false;
  return a.state === 'loading' || (a.state === 'none' && b.state === 'none' && a.reason === b.reason);
}
