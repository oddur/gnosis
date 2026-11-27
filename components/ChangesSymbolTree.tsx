import { useEffect, useMemo, useRef, useState } from 'react';
import { FileTree, useFileTree, useFileTreeSelection } from '@pierre/trees/react';
import { preparePresortedFileTreeInput, type ContextMenuItem, type FileTreeDirectoryHandle, type FileTreeItemHandle, type GitStatusEntry } from '@pierre/trees';
import { TreeSymbolMenu, TreeViewedMenu } from './TreeViewedMenu';
import { CHANGED_COLOR, TREE_WORDS, commentDecorationCSS, decorationCSS, fileRowDecoration, type ChangeTreeEntry } from './ChangesFileTree';
import { DIFF_STAT_COLORS } from './DiffStats';
import { treeSymbolLook } from './tree-symbol-icons';
import { selectedTreeFiles } from '../lib/tree-viewed-files';
import { isSymbolViewed, progressVersion, useFileProgress } from '../lib/file-view-progress';
import type { CodeIntelligenceSettings } from '../lib/code-intelligence';
import type { NoiseFilter } from '../lib/semantic-noise';
import { BODY_PART, TOP_LEVEL_ID, bodyOwner, isBody, type ChangedSymbol } from '../lib/symbol-outline';
import { definitionNoun } from '../lib/hunk-scopes';
import { peekReviewTarget, setReviewTarget, setTreeCursor, useReadingPlace, useReviewTarget } from '../lib/tree-symbol-sync';
import { markReviewSymbols } from '../lib/symbol-file-sync';
import { ensureCarried, isUpdated, updatedCount, useCarry } from '../lib/symbol-carry';
import { SymbolPeek, type PeekView } from './SymbolPeek';
import { callerCoverage, findCallers, type CallerFile } from '../lib/review-peek';
import type { DiffAppearance } from '../lib/review-diff';
import { readingLabel, usePaging } from '../lib/review-paging';
import { matchingSymbols, movedMirrorId, pruneSymbols, readingSymbol, rowDestination, rowName, topLevelName, treeSymbolKind, type TreeSymbolNode } from '../lib/tree-symbols';
import { FILE_STOP, itemCounts, treeOrder, folderProgress, folderSums as sumFolders, rowLabel, rowReviewIds, reviewIds, reviewed, rolledUp, symbolProgress, type SymbolProgress } from '../lib/tree-symbol-review';
import { ancestorPaths, symbolRowKey, symbolTreePaths, type FileSymbols, type SymbolTreePaths, type TreeRow } from '../lib/tree-symbol-paths';
import { loadTreeSymbols, treeSymbolsSupported, useTreeSymbols, type TreeSymbolSource } from '../lib/use-tree-symbols';

export interface SymbolTreeEntry extends ChangeTreeEntry {
  /** The file as the diff reads it: set for every file, so the tree can tell which have symbols. */
  source?: TreeSymbolSource;
}

const STATUS = { added: 'added', modified: 'modified', deleted: 'deleted', renamed: 'renamed' } as const;

/**
 * A viewed symbol's mark in place of its counts. Files read "Viewed"; a symbol row sits deeper in a narrow tree, and
 * the word took the width its name needs. The tooltip still says "Viewed", and the file rows' progress uses ✓ too.
 */
const VIEWED_MARK = '✓';

/**
 * An item that changed since the reader viewed it in an earlier revision (lib/symbol-carry.ts): "↻ Changed" in the
 * info ink in place of its counts, which move to the tooltip. The glyph reads at 12 px where a dot reads as a bullet.
 */
const CHANGED_TEXT = '↻ Changed';
/** A symbol row's counts, the zero half left out (lib/tree-symbol-review.ts `itemCounts`). */
const countText = (added: number, deleted: number) => itemCounts(added, deleted).text;
const countParts = (added: number, deleted: number) =>
  itemCounts(added, deleted).parts.map((part) => ({ text: `${part.sign}${part.count}`, color: part.sign === '+' ? DIFF_STAT_COLORS.added : DIFF_STAT_COLORS.removed }));
/** An item V is paging through: how much of it the reader has seen, muted, in place of its counts. */
const reading = (share: number, rest: string) => {
  const label = readingLabel(share);
  return { text: label.text, parts: [{ text: label.text, color: label.full ? CHANGED_COLOR : 'var(--muted-foreground)' }], title: `${label.title}. ${rest}` };
};
const changedItem = (added: number, deleted: number, rest: string) => ({
  text: CHANGED_TEXT,
  parts: [{ text: CHANGED_TEXT, color: CHANGED_COLOR }],
  title: `Changed since you viewed it · +${added} −${deleted}. ${rest}`,
});

/** A hover on a symbol row this long opens its peek (components/SymbolPeek.tsx). */
const HOVER_PEEK_MS = 400;
/** A hover peek stays this long after the pointer leaves the row and the popover, so it can travel into it. */
const PEEK_GRACE_MS = 250;
/** "Look in all files": files read at once, and how long each may take. */
const LOOK_ALL_LANES = 3;
const LOOK_ALL_WAIT_MS = 10_000;

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
  onReviewKey,
  onCommentKey,
  onReviewCurrent,
  peekTheme,
  peekAppearance,
  peekOnHover = true,
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
  reveal?: { key: string; id: string; nonce: number; focus?: boolean };
  /**
   * V on a row, in place of ticking it here: PrChangesView ticks what the row names (a file, or the review items under
   * a symbol row) and moves on to the next unviewed item, as V does anywhere in Changes.
   */
  onReviewKey?: (tick: { key: string; ids: string[]; viewed: boolean; file: boolean }) => void;
  /** A peek's diff theme and appearance (components/SymbolPeek.tsx), as Changes draws its diffs. */
  peekTheme?: string;
  peekAppearance?: DiffAppearance;
  /** Whether resting the pointer on a symbol row opens its peek (Preferences.peekOnHover); Space opens one either way. */
  peekOnHover?: boolean;
  /** Enter on the row of the item under review comments on it (PrChangesView); true when it did. */
  onCommentKey?: (item: { key: string; id: string }) => boolean;
  /** V on a row with nothing of its own to mark (a folder, a note): Changes' own V, on the item under review. */
  onReviewCurrent?: () => void;
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
  // Worked out again only when the files, what is known of them, the marks or a carry change.
  const carried = useCarry();
  const marksVersion = progressVersion();
  const { fileProgress, folderSums, fileChanged, folderChanged } = useMemo(() => {
    const fileProgress = new Map<string, SymbolProgress>();
    for (const e of entries) {
      const source = supported.get(e.key);
      const value = known.get(e.key);
      if (source && value?.state === 'ready')
        fileProgress.set(e.key, symbolProgress(value.nodes, (id) => isSymbolViewed(source.fileKey, id), e.viewed, value.top));
    }
    // Items changed since the reader viewed them, per file and summed per folder: "2 changed" first on their rows.
    const fileChanged = new Map(entries.flatMap((e) => (e.source ? [[e.key, updatedCount([e.source.fileKey])] as const] : [])));
    return { fileProgress, folderSums: folderProgress(fileProgress), fileChanged, folderChanged: sumFolders(fileChanged) };
  }, [entries, supported, known, marksVersion, carried]);
  // Carry-over (lib/symbol-carry.ts): a file's ticks come over from its earlier revisions once its symbols are known,
  // and the rows mark what changed since the reader viewed it.
  useEffect(() => {
    for (const [key, value] of known) {
      const source = supported.get(key);
      if (source && value.state !== 'loading') ensureCarried(source.fileKey, value.state === 'ready' ? value : undefined);
    }
  }, [known, supported]);
  // An item V is paging through reads "Reading 40%" until it is ticked (lib/review-paging.ts).
  const pagingNow = usePaging();
  // The item under review: lit while it holds, and its row offers Enter to comment (lib/review-comment.ts).
  const target = useReviewTarget();
  // Old copies of moves read viewed with their new copies, in other files: their rows refresh when those are ticked.
  let movedSignature = '';
  for (const [key, value] of symbols) {
    const source = supported.get(key);
    if (value.state !== 'ready' || !source) continue;
    for (const node of treeOrder(value.nodes))
      if (node.moveAway) movedSignature += isSymbolViewed(source.fileKey, movedMirrorId(node.definition.start)) ? '1' : '0';
  }
  const progressSignature = `${carried}\n${target ? `${target.key}\u0000${target.id}` : ''}\n${movedSignature}\n${pagingNow ? `${pagingNow.key}:${pagingNow.id}:${pagingNow.share}` : ''}\n${[...fileProgress, ...folderSums].map(([key, { viewed, total }]) => `${key}:${viewed}/${total}`).join('\n')}`;
  const current = useRef({ entries, onSelect, layout, supported, progress, fileProgress, folderSums, fileChanged, folderChanged, pagingNow, target });
  current.current = { entries, onSelect, layout, supported, progress, fileProgress, folderSums, fileChanged, folderChanged, pagingNow, target };
  /** The share seen of the item V is paging through, if it is this row's. */
  const readingNow = (key: string, id: string) => {
    const now = current.current.pagingNow;
    return now && now.key === key && now.id === id ? now.share : undefined;
  };
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
    renderRowDecoration: ({ item }) => withCommentHint(item.path, decorate(item.path)),
  });
  /** Each row's decoration: its counts, progress, Viewed, Changed or Reading. */
  function decorate(path: string) {
    const item = { path };
      const row = rowAt(item.path);
      if (!row) return null;
      if (row.type === 'file') {
        const entry = entryOf(row.key);
        if (!entry) return null;
        // A file without symbols whose patch changed since the reader viewed it is one changed item.
        const fileKey = entry.source?.fileKey;
        if (!row.folder && fileKey && isUpdated(fileKey, FILE_STOP)) return changedItem(entry.additions, entry.deletions, row.key);
        return fileRowDecoration(entry, showComments, current.current.fileProgress.get(row.key), current.current.fileChanged.get(row.key));
      }
      if (row.type === 'folder') {
        // The files under it whose symbols are known, summed; nothing until one of their symbols is viewed. Items
        // changed since the reader viewed them come first.
        const sum = current.current.folderSums.get(row.path);
        const label = rowLabel(sum, current.current.folderChanged.get(row.path));
        if (label.kind === 'changed') return { text: label.text, parts: [{ text: label.text, color: CHANGED_COLOR }], title: `${label.text} since you viewed them, in the files here` };
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
          return { text: VIEWED_MARK, parts: [{ text: VIEWED_MARK, color: 'var(--muted-foreground)' }], title: `${topLevelName(row.top)}: viewed` };
        if (row.top.quiet) {
          const word = 'Quiet';
          return { text: word, parts: [{ text: word, color: 'var(--muted-foreground)' }], title: `${added} additions, ${deleted} deletions, every one quiet` };
        }
        const counts = {
          text: countText(added, deleted),
          parts: countParts(added, deleted),
          title: `${added} additions, ${deleted} deletions ${imports ? 'to imports' : 'outside every function and class'}`,
        };
        const share = readingNow(row.key, TOP_LEVEL_ID);
        if (share !== undefined) return reading(share, counts.title);
        return topSource && isUpdated(topSource.fileKey, TOP_LEVEL_ID) ? changedItem(added, deleted, counts.title) : counts;
      }
      if (row.type !== 'symbol') return null;
      const { node } = row;
      const source = current.current.supported.get(row.key);
      // Viewed once every review item under the row is ticked, itself included (lib/tree-symbol-review.ts).
      const done = rolledUp(node, (id) => !!source && current.current.progress.isSymbolViewed(source.fileKey, id), !!entryOf(row.key)?.viewed);
      if (node.moveAway) {
        // The old copy of a move: reviewed at its new copy, and viewed with it (lib/tree-symbols.ts `movedMirrorId`).
        const away = node.moveAway;
        const seen = !!entryOf(row.key)?.viewed || (!!source && current.current.progress.isSymbolViewed(source.fileKey, movedMirrorId(node.definition.start)));
        const where = away.sameFile ? `line ${away.other.start}` : `${away.other.diffPath}, line ${away.other.start}`;
        const text = seen ? '✓ moved' : 'Moved';
        return {
          text,
          parts: [{ text, color: 'var(--muted-foreground)' }],
          title: `${away.renamed && away.sameFile ? `Renamed to ${away.other.name}` : `Moved to ${where}`}: reviewed there${seen ? ', viewed' : ''}`,
        };
      }
      if (!reviewed(node) && !node.quiet) {
        // A container (or a context row): no tick of its own. It reads as viewed once everything under it is, its
        // Body included; its own lines' counts are on its Body row.
        if (!done) return null;
        return { text: VIEWED_MARK, parts: [{ text: VIEWED_MARK, color: 'var(--muted-foreground)' }], title: `${definitionNoun(node.definition)} ${node.definition.name}: everything changed in it viewed` };
      }
      if (!node.symbol) return null;
      const viewed = done ?? (!!entryOf(row.key)?.viewed || (!!source && current.current.progress.isSymbolViewed(source.fileKey, node.id)));
      const quiet = !viewed && node.quiet ? (TREE_WORDS[node.quiet] ?? 'Quiet') : undefined;
      const moved = node.moved ? [{ text: '⇄', color: 'var(--muted-foreground)' }] : [];
      const spoken = isBody(node) ? node.definition.crumb : `${definitionNoun(node.definition)} ${node.definition.name}, ${node.change}`;
      const decoration = {
        text: viewed ? VIEWED_MARK : (quiet ?? countText(node.added, node.deleted)),
        parts: [
          ...moved,
          ...(viewed
            ? [{ text: VIEWED_MARK, color: 'var(--muted-foreground)' }]
            : quiet
              ? [{ text: quiet, color: 'var(--muted-foreground)' }]
              : countParts(node.added, node.deleted)),
        ],
        title: `${spoken}. ${viewed ? 'Viewed' : `${node.added} additions, ${node.deleted} deletions`}${node.quiet ? `. ${node.quiet}: every change is quiet` : ''}${node.moved ? `. ${node.moved}` : ''}`,
      };
      const share = viewed ? undefined : readingNow(row.key, node.id);
      if (share !== undefined) return reading(share, spoken);
      return !viewed && source && isUpdated(source.fileKey, node.id) ? changedItem(node.added, node.deleted, spoken) : decoration;
  }
  /** The row of the item under review also says Enter comments on it. */
  function withCommentHint<T extends { title: string }>(path: string, decoration: T | null): T | null {
    const row = rowAt(path);
    const target = current.current.target;
    if (!decoration || !row || !target || (row.type !== 'symbol' && row.type !== 'top' && row.type !== 'file') || row.key !== target.key) return decoration;
    const id = row.type === 'symbol' ? row.node.id : row.type === 'top' ? TOP_LEVEL_ID : FILE_STOP;
    return id === target.id ? { ...decoration, title: `${decoration.title} · Enter to comment` } : decoration;
  }
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
    // The row with the keyboard before the rebuild: if the rebuild drops it (Unviewed only, a file just finished), Pierre
    // moves its focus to a neighbour the reader never chose, and the keyboard goes back to the row V went to.
    const focusedBefore = model.getFocusedPath();
    const displaced = !!focusedBefore && !layout.rows.has(focusedBefore) && !layout.paths.includes(focusedBefore);
    // Resetting also refreshes Pierre's row decorations: counts, Viewed, quiet words.
    model.resetPaths({ preparedInput: prepared, initialExpandedPaths: openPaths(layout, open, closed.current) });
    applyStatus.current();
    // Focus lost with the rows a rebuild dropped goes back to the row V went to.
    const target = focusTarget.current;
    if (target) {
      const path = target.id === FILE_STOP ? layout.pierreOf.get(target.key) : layout.symbolPaths.get(symbolRowKey(target.key, target.id));
      if (path) {
        expandTo(path);
        // After a rebuild only focus the rows took with them comes back: a row the reader moved to stays theirs.
        focusWhenDrawn(path, { fromTree: displaced });
      }
    }
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
  // A Body has no definition of its own: the diff arrives at it inside its container.
  const arrived =
    !!held &&
    held.key === selected &&
    !!live.id &&
    (live.id === held.id || live.id.startsWith(`${held.id}>`) || (held.id.endsWith(`>${BODY_PART}`) && live.id === bodyOwner(held.id)));
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
  // The item the reader was taken to stays lit until they move on their own, whatever the pinned crumb names: a jump to
  // a top-level line between two functions lands with one of them named. Then the light follows the reader.
  // A file stop (a file without symbols, or one whose symbols could not be listed) lights the file's own row.
  const targetPath =
    target && target.key === selected
      ? target.id === FILE_STOP
        ? layout.pierreOf.get(target.key)
        : layout.symbolPaths.get(symbolRowKey(target.key, target.id))
      : undefined;
  const readingPath = targetPath ?? (held && !arrived && held.key === selected ? layout.symbolPaths.get(symbolRowKey(held.key, held.id)) : live.path);
  applyStatus.current = () => {
    const status: GitStatusEntry[] = [];
    for (const e of entries) {
      const path = layout.pierreOf.get(e.key);
      // A file that is the lit stop (a file without symbols) takes the light instead of its own status: a path has one
      // status, and its own would win over the light, leaving the stop unlit.
      if (path && path !== readingPath) status.push({ path, status: STATUS[e.status] });
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
  const revealing = useRef<{ key: string; id: string; focus?: boolean }>(undefined);
  // The row V went to, which keeps keyboard focus across rebuilds: Unviewed only drops the rows just finished, and
  // Pierre's focus would go with them, to the tree's top or the page.
  const focusTarget = useRef<{ key: string; id: string }>(undefined);
  // Whether the reader has clicked or arrowed in the tree since V or n last took them somewhere. Until they do, a row
  // other than the item under review that holds the keyboard has it from Pierre, trailing the light, not from the reader:
  // Enter there is meant for the item under review.
  const readerChose = useRef(false);
  /** Opens every collapsed directory row above `path`: folders, the file, its containers. */
  const expandTo = (path: string) => {
    for (const ancestor of ancestorPaths(path)) {
      const folder = folderOf(model.getItem(ancestor));
      if (folder && !folder.isExpanded()) folder.expand();
    }
  };
  const workspaceRef = useRef<HTMLDivElement>(null);
  /**
   * Puts the keyboard on the row at `path` once Pierre has drawn it: a row whose folders just opened is drawn a frame
   * later, and focusing it before then does nothing. It takes the keyboard only from places that hold no input of the
   * reader's (the page, the diff stream, the tree itself), never from a text field, the composer or a menu.
   */
  // Each call takes a new number, and its retries stop once another call, or a peek opening, takes a newer one: a late
  // retry would take the keyboard back from where it went since.
  const focusRun = useRef(0);
  const focusWhenDrawn = (path: string, { fromTree = true }: { fromTree?: boolean } = {}, frames = 20, run = ++focusRun.current) => {
    if (run !== focusRun.current) return;
    let active: Element | null = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    if (active?.closest('[data-item-path]')?.getAttribute('data-item-path') === path) return;
    const free =
      !active ||
      active === document.body ||
      !!active.closest('.commit-diff-stream') ||
      // The peek gives the keyboard back to its row as it closes, while focus is still inside it.
      !!active.closest('.symbol-peek') ||
      // Another tree row is the reader's own choice, unless V or n is taking them on (`fromTree`).
      (fromTree && (!!active.closest('[role=tree], [role=treeitem]') || active.tagName === 'FILE-TREE-CONTAINER'));
    const editable = !active?.closest('.symbol-peek') && !!active?.closest('input, textarea, select, [contenteditable=true], [role=menu], [role=dialog]');
    if (!free || editable) return;
    model.getItem(path)?.focus();
    // Pierre moves the browser's focus only while the tree holds it: from the page (a peek just closed, the diff), the
    // drawn row takes it itself.
    const host = workspaceRef.current?.querySelector('file-tree-container');
    const drawn = host?.shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${CSS.escape(path)}"]`);
    drawn?.focus({ preventScroll: true });
    if (frames > 0) requestAnimationFrame(() => focusWhenDrawn(path, { fromTree }, frames - 1, run));
  };
  const pathOf = (target: { key: string; id: string }) =>
    target.id === FILE_STOP ? layout.pierreOf.get(target.key) : layout.symbolPaths.get(symbolRowKey(target.key, target.id));
  useEffect(() => {
    if (!reveal) return;
    // A file without symbols is lit by its selection; a symbol by the hold, until the diff arrives.
    if (reveal.id !== FILE_STOP) setHeld({ key: reveal.key, id: reveal.id });
    revealing.current = { key: reveal.key, id: reveal.id, focus: reveal.focus };
    focusTarget.current = reveal.focus ? { key: reveal.key, id: reveal.id } : undefined;
    readerChose.current = false;
    if (reveal.key === selected && reveal.id !== FILE_STOP) folderOf(model.getItem(layout.pierreOf.get(reveal.key) ?? ''))?.expand();
  }, [reveal?.nonce]);
  // Its row is selected once it is listed and its file is the current one, so the current file's selection keeps it.
  useEffect(() => {
    const target = revealing.current;
    if (!target || target.key !== selected) return;
    const path = pathOf(target);
    if (!path) return;
    revealing.current = undefined;
    // Every collapsed row above it opens first, as if the reader had opened them: they stay open across rebuilds.
    expandTo(path);
    if (model.getSelectedPaths().length <= 1) selectOnly(path);
    model.scrollToPath(path, { focus: false, offset: 'nearest' });
    if (target.focus) focusWhenDrawn(path);
  }, [model, layout, selected, reveal?.nonce]);
  const activate = (row: TreeRow | undefined) => {
    if (!row || row.type === 'folder') return;
    if (row.type === 'symbol' && row.node.moveAway) {
      // A moved symbol's old copy goes to its new copy, which is the move's one item.
      const away = row.node.moveAway;
      const target = current.current.entries.find((e) => e.source?.fileKey === away.other.file);
      const { other } = away;
      // The new copy is where the reader now is: V there marks it, as it would had they chosen it.
      const into = target && known.get(target.key);
      const findInto = (nodes: readonly TreeSymbolNode[]): TreeSymbolNode | undefined => {
        for (const node of nodes) {
          if (node.moveInto && node.definition.start === other.start) return node;
          const found = findInto(node.children);
          if (found) return found;
        }
        return undefined;
      };
      const newCopy = into?.state === 'ready' ? findInto(into.nodes) : undefined;
      setReviewTarget(target && newCopy && reviewed(newCopy) ? { key: target.key, id: newCopy.id } : undefined);
      if (target)
        onGoToSymbol(target.key, {
          id: '',
          change: 'added',
          definition: { kind: other.kind, name: other.name, label: other.label, crumb: other.label, start: other.start, end: other.end, signatureEnd: other.signatureEnd },
          side: other.side,
          parents: [],
          first: { side: other.side, line: other.start },
          added: 0,
          deleted: 0,
        });
      return;
    }
    if (row.type === 'symbol') {
      const symbol = rowDestination(row.node);
      if (symbol) {
        setHeld({ key: row.key, id: row.node.id });
        setTreeCursor(row.key, row.node.id);
        // The row the reader chose is where they are, until they move on (lib/tree-symbol-sync.ts).
        setReviewTarget(reviewed(row.node) ? { key: row.key, id: row.node.id } : undefined);
        onGoToSymbol(row.key, symbol);
      }
      return;
    }
    if (row.type === 'top') {
      // The file's top-level changes go to their first changed line, as a symbol row goes to its symbol.
      setHeld({ key: row.key, id: TOP_LEVEL_ID });
      setTreeCursor(row.key, TOP_LEVEL_ID);
      setReviewTarget({ key: row.key, id: TOP_LEVEL_ID });
      const symbol = rowDestination(row.top);
      if (symbol) onGoToSymbol(row.key, symbol);
      return;
    }
    // A file chosen: a file without symbols is one stop, the reader's target; a file with symbols is no item itself.
    setReviewTarget(row.type === 'file' && !row.folder ? { key: row.key, id: FILE_STOP } : undefined);
    current.current.onSelect(row.key);
  };
  /** What V and the Viewed menu tick for a row: a symbol's changed symbols, or the file's top-level changes. */
  const symbolIds = (row: TreeRow | undefined) => (row ? rowReviewIds(row) : []);
  const markSymbols = (row: TreeRow | undefined, viewed?: boolean) => {
    if (row?.type !== 'symbol' && row?.type !== 'top') return;
    const source = supported.get(row.key);
    const ids = symbolIds(row);
    if (!source || !ids.length) return;
    const now = ids.filter((id) => symbolOn(row.key, source.fileKey, id)).length;
    // The file follows its ticks (lib/symbol-file-sync.ts): the last one marks it, kept open while the reader is on it.
    void markReviewSymbols(source.fileKey, ids, viewed ?? now < ids.length);
  };
  /** A symbol reads as ticked when it is, or when its file is Viewed. */
  const symbolOn = (key: string, fileKey: string, id: string) => !!entryOf(key)?.viewed || progress.isSymbolViewed(fileKey, id);
  const selectedFiles = selectedTreeFiles(entries, mapped(selectedPaths), matchingPaths);
  // ── Peek (components/SymbolPeek.tsx): Space on a row, or a hover, shows the item's own hunks and its changed callers,
  // without moving the review, the light or the diff. ──
  const [peek, setPeek] = useState<{ stack: { key: string; id: string }[]; focus: boolean; path: string; anchor: Element }>();
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hoverPath = useRef<string | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** What a row peeks at: a symbol (not a move's old copy), the top level, or a file without symbols. */
  const peekItemOf = (row: TreeRow | undefined): { key: string; id: string } | undefined => {
    if (!row) return undefined;
    if (row.type === 'symbol') return row.node.moveAway ? undefined : { key: row.key, id: row.node.id };
    if (row.type === 'top') return { key: row.key, id: TOP_LEVEL_ID };
    if (row.type === 'file' && (!row.folder || known.get(row.key)?.state === 'none')) return { key: row.key, id: FILE_STOP };
    return undefined;
  };
  const rowElement = (event: Event) => event.composedPath().find((node): node is Element => node instanceof Element && node.hasAttribute('data-item-path'));
  const openPeek = (item: { key: string; id: string }, path: string, anchor: Element, focus: boolean) => {
    clearTimeout(closeTimer.current);
    // A row still waiting for the keyboard (a peek just closed) gives it up to the peek opening now.
    if (focus) focusRun.current++;
    setPeek({ stack: [item], focus, path, anchor });
  };
  const closePeek = (returnFocus = peek?.focus) => {
    clearTimeout(closeTimer.current);
    const path = peek?.path;
    setPeek(undefined);
    if (returnFocus && path) focusWhenDrawn(path);
  };
  // A hover peek closes a moment after the pointer leaves the row and the popover, so it can travel into it.
  const leaveSoon = () => {
    clearTimeout(hoverTimer.current);
    if (!peek || peek.focus) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setPeek((open) => (open && !open.focus ? undefined : open)), PEEK_GRACE_MS);
  };
  useEffect(() => () => {
    clearTimeout(hoverTimer.current);
    clearTimeout(closeTimer.current);
  }, []);
  const peekView = (item: { key: string; id: string }): PeekView | undefined => {
    const entry = entryOf(item.key);
    const source = entry?.source;
    if (!entry || !source) return undefined;
    const symbols = known.get(item.key);
    const ready = symbols?.state === 'ready' ? symbols : undefined;
    const fileViewed = entry.viewed;
    const base = { key: item.key, id: item.id, snapshot: source.snapshot, file: source.file };
    const look = (text: string, color?: string) => ({ text, color });
    if (item.id === FILE_STOP)
      return {
        ...base,
        name: item.key.slice(item.key.lastIndexOf('/') + 1),
        icon: 'note',
        added: entry.additions,
        deleted: entry.deletions,
        state: fileViewed ? look('✓ Viewed') : isUpdated(source.fileKey, FILE_STOP) ? look('Changed', CHANGED_COLOR) : look(''),
        hunks: {},
      };
    if (item.id === TOP_LEVEL_ID) {
      const top = ready?.top;
      if (!top) return undefined;
      const viewed = fileViewed || progress.isSymbolViewed(source.fileKey, TOP_LEVEL_ID);
      return { ...base, name: topLevelName(top), icon: top.imports ? 'imports' : 'top', added: top.added, deleted: top.deleted, state: viewed ? look('✓ Viewed') : look(''), hunks: { keys: top.lines } };
    }
    const node = ready && treeOrder(ready.nodes).find((one) => one.id === item.id);
    if (!node) return undefined;
    const body = isBody(node);
    // A Body's hunks are its container's; a symbol's, those over its definition on its side.
    const definition = body ? (node.symbol?.parents.at(-1) ?? node.definition) : node.definition;
    const side = node.symbol?.side ?? 'after';
    const share = readingNow(item.key, item.id);
    const viewed = rolledUp(node, (id) => progress.isSymbolViewed(source.fileKey, id), fileViewed);
    const state =
      viewed ? look('✓ Viewed')
      : share !== undefined ? look(readingLabel(share).text, readingLabel(share).full ? CHANGED_COLOR : undefined)
      : isUpdated(source.fileKey, item.id) ? look('Changed', CHANGED_COLOR)
      : look('');
    return {
      ...base,
      name: body ? node.definition.crumb : rowName(node),
      icon: body ? 'top' : treeSymbolKind(node.definition.kind),
      added: node.added,
      deleted: node.deleted,
      state,
      hunks: { side, start: definition.start, end: definition.end },
    };
  };
  const peekFiles = (): CallerFile[] =>
    [...known].flatMap(([key, value]) => (value.state === 'ready' ? [{ key, nodes: value.nodes, calls: value.calls }] : []));
  const peekCoverage = () => callerCoverage([...supported.keys()].map((key) => known.get(key)?.state));
  // "Look in all files": the files whose symbols are not known yet, read and parsed as a file on screen is, a few at a
  // time; the callers list fills in as they land.
  const lookAll = () => {
    const waiting = [...supported].filter(([key]) => known.get(key)?.state === 'loading').map(([, source]) => source);
    let next = 0;
    const run = async () => {
      while (next < waiting.length) await loadTreeSymbols(waiting[next++], codeSettings, noiseFilter, LOOK_ALL_WAIT_MS);
    };
    for (let lane = 0; lane < LOOK_ALL_LANES; lane++) void run();
  };
  const peekGo = (item: { key: string; id: string }) => {
    closePeek(false);
    if (item.id === FILE_STOP) {
      current.current.onSelect(item.key);
      return;
    }
    const symbols = known.get(item.key);
    const ready = symbols?.state === 'ready' ? symbols : undefined;
    const target = item.id === TOP_LEVEL_ID ? ready?.top : ready && treeOrder(ready.nodes).find((one) => one.id === item.id);
    const symbol = target && rowDestination(target);
    if (!symbol) return;
    setHeld({ key: item.key, id: item.id });
    setTreeCursor(item.key, item.id);
    setReviewTarget({ key: item.key, id: item.id });
    onGoToSymbol(item.key, symbol);
  };
  const peekTick = (item: { key: string; id: string }) => {
    const source = supported.get(item.key);
    if (item.id === FILE_STOP) void onSetViewed?.([item.key], true);
    else if (source) {
      const symbols = known.get(item.key);
      const node = symbols?.state === 'ready' ? treeOrder(symbols.nodes).find((one) => one.id === item.id) : undefined;
      const ids = item.id === TOP_LEVEL_ID ? [TOP_LEVEL_ID] : node ? reviewIds(node) : [];
      if (ids.length) void markReviewSymbols(source.fileKey, ids, true);
    }
    closePeek();
  };
  const peeking = peek?.stack.at(-1);
  const peekShown = peeking && peekView(peeking);
  return (
    <div className="file-tree-selection-workspace" ref={workspaceRef} onPointerLeave={leaveSoon}>
      {peek && peeking && peekShown && (
        <SymbolPeek
          view={peekShown}
          anchor={peek.anchor}
          focus={peek.focus}
          callers={findCallers(peeking, peekFiles())}
          coverage={peekCoverage()}
          onLookAll={lookAll}
          canBack={peek.stack.length > 1}
          onBack={() => setPeek((open) => open && { ...open, stack: open.stack.slice(0, -1) })}
          onPeek={(caller) => setPeek((open) => open && { ...open, stack: [...open.stack, { key: caller.key, id: caller.id }] })}
          onGo={(caller) => peekGo(caller ? { key: caller.key, id: caller.id } : peeking)}
          onTick={() => peekTick(peeking)}
          onClose={() => closePeek()}
          onPointerEnter={() => clearTimeout(closeTimer.current)}
          onPointerLeave={leaveSoon}
          theme={peekTheme ?? 'pierre-dark'}
          appearance={peekAppearance}
        />
      )}
      {/* A multiple selection floats over the tree's foot, so selecting moves no row; the range tip is in the menu. */}
      {selectedFiles.length > 1 && (
        <div className="file-tree-selection-status">
          <span role="status">{selectedFiles.length} files selected</span>
          <button type="button" onClick={() => { selectOnly(); model.getFocusedItem()?.focus(); }} aria-label="Clear file selection">Clear</button>
        </div>
      )}
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
                label={row.type === 'top' ? topLevelName(row.top) : isBody(row.node) ? row.node.definition.crumb : `${definitionNoun(row.node.definition)} ${row.node.definition.name}`}
                what={row.type === 'top' ? (row.top.imports ? 'imports' : 'top-level changes') : undefined}
                count={ids.length}
                viewed={ids.filter((id) => symbolOn(row.key, source.fileKey, id)).length}
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
        // Whether a resting pointer peeks, as the hover handler below reads it; the browser suite checks it.
        data-peek-on-hover={peekOnHover ? 'true' : 'false'}
        onClickCapture={(event) => {
          readerChose.current = true;
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
        // The row under the pointer, read on every move: pointerover comes once per element entered, and Pierre's rows,
        // drawn and recycled as the list scrolls, can change under a pointer that sends no new over event. A peek opens once
        // the pointer has rested on one symbol row for HOVER_PEEK_MS.
        onPointerLeave={() => {
          clearTimeout(hoverTimer.current);
          hoverPath.current = undefined;
        }}
        onPointerMove={(event) => {
          if (event.pointerType !== 'mouse') return;
          const path = rowPath(event.nativeEvent);
          if (path === hoverPath.current) return;
          hoverPath.current = path ?? undefined;
          const row = rowAt(path);
          if (row && row.type !== 'folder') onPreview?.(row.key);
          // A hover peek, unless turned off: after HOVER_PEEK_MS on a symbol row; another row's hover moves it there.
          clearTimeout(hoverTimer.current);
          const item = row?.type === 'symbol' || row?.type === 'top' ? peekItemOf(row) : undefined;
          const element = rowElement(event.nativeEvent);
          if (peek && !peek.focus && peek.path !== path) leaveSoon();
          if (peekOnHover && item && path && element && (!peek || !peek.focus) && peek?.path !== path)
            hoverTimer.current = setTimeout(() => openPeek(item, path, element, false), HOVER_PEEK_MS);
        }}
        onFocusCapture={() => {
          const row = rowAt(model.getFocusedPath());
          if (row && row.type !== 'folder') onPreview?.(row.key);
        }}
        onKeyUp={(event) => {
          if (TREE_MOVES.has(event.key)) readerChose.current = true;
          const row = rowAt(model.getFocusedPath());
          if (row && row.type !== 'folder') onPreview?.(row.key);
          // A symbol row moved to with the keys is where `n` starts from, as one chosen is.
          if ((row?.type === 'symbol' || row?.type === 'top') && TREE_MOVES.has(event.key)) {
            const id = row.type === 'top' ? TOP_LEVEL_ID : row.node.id;
            setTreeCursor(row.key, id);
            // Moving to a row with the keys is choosing it: a review item becomes the target, a container ends it.
            setReviewTarget(row.type === 'top' || reviewed(row.node) ? { key: row.key, id } : undefined);
          }
        }}
        onKeyDownCapture={(event) => {
          if (event.nativeEvent.composedPath().some((node) => node instanceof Element && node.closest('[data-file-tree-context-menu-root]'))) return;
          // Space peeks at the row's item (Space in the diff keeps scrolling: this is the tree's own key).
          if (event.key === ' ' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
            const path = rowPath(event.nativeEvent) ?? model.getFocusedPath();
            const item = peekItemOf(rowAt(path));
            const element = rowElement(event.nativeEvent);
            if (item && path && element) {
              event.preventDefault();
              event.stopPropagation();
              openPeek(item, path, element, true);
              return;
            }
          }
          if (event.key === 'Escape' && model.getSelectedPaths().length > 1) {
            event.preventDefault();
            event.stopPropagation();
            selectOnly();
            return;
          }
          // The row the key came from, else Pierre's focused one: after V moves on, Pierre's focus is on the next row,
          // and a key pressed on another focused row must act on that row.
          const path = rowPath(event.nativeEvent) ?? model.getFocusedPath();
          const row = rowAt(path);
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            if (path && !model.getSelectedPaths().includes(path)) selectOnly(path);
          }
          // The arrow keys open and close a file as its chevron does; the reader's choice then stays.
          if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && row?.type === 'file' && auto.current === row.key) auto.current = undefined;
          // V marks the symbol Viewed, as its tick in the outline does.
          // Shift+V takes back the last V: Changes' own key (PrChangesView), not the row's.
          // V acts on the item under review when there is one: the row the reader clicked or arrowed to, or the one V or n
          // went to. The keyboard can trail the light by a frame or land on a folder when Unviewed only drops a finished
          // file's rows, and V on whatever row holds it would tick, or untick, the wrong thing. With no item under review
          // (the reader arrowed to a container), V acts on the row: a container ticks everything under it.
          // The row is the item under review itself when it is that symbol, top level or file stop: then V acts on the row
          // as always, ticking or taking back its tick.
          const under = peekReviewTarget();
          const isUnder =
            !!under &&
            !!row &&
            ((row.type === 'symbol' && row.key === under.key && row.node.id === under.id) ||
              (row.type === 'top' && row.key === under.key && under.id === TOP_LEVEL_ID) ||
              (row.type === 'file' && row.key === under.key && under.id === FILE_STOP));
          if ((event.key === 'v' || event.key === 'V') && !event.shiftKey && !event.defaultPrevented && !event.metaKey && !event.ctrlKey && !event.altKey && onReviewCurrent && ((under && !isUnder) || !row || row.type === 'folder' || row.type === 'note')) {
            event.preventDefault();
            event.stopPropagation();
            onReviewCurrent();
            return;
          }
          if ((event.key === 'v' || event.key === 'V') && !event.shiftKey && !event.defaultPrevented && !event.metaKey && !event.ctrlKey && !event.altKey && row && row.type !== 'folder' && row.type !== 'note') {
            event.preventDefault();
            event.stopPropagation();
            // V on a file row marks the file, as its header's Viewed checkbox does, whatever it is (JSON, an image, a
            // file with symbols); on a symbol row, the symbol, as its tick in the outline does. With Changes' V, it
            // then moves on to the next unviewed item.
            if (row.type === 'file') {
              const entry = entryOf(row.key);
              if (!entry) return;
              if (onReviewKey) onReviewKey({ key: row.key, ids: [], viewed: !entry.viewed, file: true });
              else void onSetViewed?.([row.key], !entry.viewed);
            } else if (onReviewKey) {
              const source = supported.get(row.key);
              const ids = symbolIds(row);
              if (source && ids.length)
                onReviewKey({ key: row.key, ids, viewed: ids.some((id) => !symbolOn(row.key, source.fileKey, id)), file: false });
            } else markSymbols(row);
            return;
          }
          // Enter on the item under review (its row lit, its target held) comments on it: Enter to go, Enter again to
          // comment. On any other row it goes there, as always. A file row is the item when it is the lit file stop (no
          // symbols, or symbols that could not be listed).
          const item = row?.type === 'symbol' && reviewed(row.node) ? { key: row.key, id: row.node.id } : row?.type === 'top' ? { key: row.key, id: TOP_LEVEL_ID } : row?.type === 'file' ? { key: row.key, id: FILE_STOP } : undefined;
          // The keyboard trailing the light (no click or arrow since V or n): Enter is for the item under review.
          const trailing = !readerChose.current && target && !(item && target.key === item.key && target.id === item.id);
          if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && trailing && onCommentKey?.(target)) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && item && target?.key === item.key && target.id === item.id && onCommentKey?.(item)) {
            event.preventDefault();
            event.stopPropagation();
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
