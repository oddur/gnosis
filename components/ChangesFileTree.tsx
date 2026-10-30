import { TreeViewedMenu } from './TreeViewedMenu';
import { DIFF_STAT_COLORS } from './DiffStats';
import { useEffect, useMemo, useRef } from 'react';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { prepareFileTreeInput, type GitStatusEntry } from '@pierre/trees';
// Lucide MessageSquare (ISC), used inside Pierre's shadow-DOM text decoration.
const commentIcon = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/></svg>')}")`;
const decorationCSS = `
  [data-item-section="content"] { flex: 1 1 auto; }
  [data-item-section="decoration"] { flex: 0 0 auto; }
  [data-item-section="decoration"] > span { display: inline-flex; align-items: center; gap: 4px; }
`;
const commentDecorationCSS = `
  [data-item-section="decoration"] > span > span:last-child { display: inline-flex; align-items: center; gap: 4px; margin-inline-start: 4px; font-variant-numeric: tabular-nums; }
  [data-item-section="decoration"] > span > span:last-child::before { content: ""; width: 12px; height: 12px; flex-shrink: 0; background: currentColor; mask: ${commentIcon} center / contain no-repeat; }
`;
export interface ChangeTreeEntry {
  key: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  viewed: boolean;
  additions: number;
  deletions: number;
  commentCount?: number;
  commentError?: boolean;
}
export function ChangesFileTree({
  entries,
  selected,
  query,
  onSelect,
  onPreview,
  onSetViewed,
  showComments = true,
  revealSelected = false,
}: {
  showComments?: boolean;
  revealSelected?: boolean;
  entries: ChangeTreeEntry[];
  selected: string;
  query: string;
  onSelect: (path: string) => void;
  onPreview?: (path: string) => void;
  onSetViewed?: (paths: string[], viewed: boolean) => Promise<boolean>;
}) {
  const current = useRef({ entries, onSelect });
  current.current = { entries, onSelect };
  // Decorations change as comments and Viewed progress arrive. Only prepare the
  // path structure when paths change, not when metadata or selection changes.
  const paths = JSON.stringify(entries.map((e) => e.key));
  const prepared = useMemo(
    () => prepareFileTreeInput(JSON.parse(paths) as string[], { flattenEmptyDirectories: true }),
    [paths]
  );
  const { model } = useFileTree({
    preparedInput: prepared,
    initialExpansion: 'open',
    composition: { contextMenu: { triggerMode: 'right-click' } },
    search: false,
    unsafeCSS: decorationCSS + (showComments ? commentDecorationCSS : ''),
    fileTreeSearchMode: 'hide-non-matches',
    renderRowDecoration: ({ item }) => {
      const entry = current.current.entries.find((e) => e.key === item.path);
      if (!entry) return null;
      const changes = entry.viewed ? 'Viewed' : `+${entry.additions} −${entry.deletions}`;
      const count = entry.commentCount;
      const comments =
        count === undefined
          ? entry.commentError
            ? 'Comments unavailable'
            : 'Loading comments…'
          : `${count} GitHub ${count === 1 ? 'comment' : 'comments'}, including replies and resolved threads`;
      return {
        text: showComments ? `${changes} · ${count ?? '—'}` : changes,
        parts: [
          ...(entry.viewed
            ? [{ text: 'Viewed' }]
            : [
                { text: `+${entry.additions}`, color: DIFF_STAT_COLORS.added },
                { text: `−${entry.deletions}`, color: DIFF_STAT_COLORS.removed },
              ]),
          ...(showComments
            ? [
                {
                  text: count === undefined ? '—' : String(count),
                  color: count ? 'var(--foreground)' : undefined,
                },
              ]
            : []),
        ],
        title: `${entry.viewed ? 'Viewed' : `${entry.additions} additions, ${entry.deletions} deletions`}${showComments ? `. ${comments}` : ''}`,
      };
    },
  });
  useEffect(() => {
    // Resetting with the prepared input also refreshes Pierre's row decorations.
    model.resetPaths({ preparedInput: prepared });
    model.setGitStatus(
      entries.map((e) => ({
        path: e.key,
        status: ({ added: 'added', modified: 'modified', deleted: 'deleted', renamed: 'renamed' } as const)[e.status],
      })) as GitStatusEntry[]
    );
  }, [model, prepared, entries]);
  useEffect(() => {
    model.setSearch(query || null);
  }, [model, query]);
  const revealed = useRef<{ model: typeof model; path: string } | null>(null);
  useEffect(() => {
    const item = model.getItem(selected);
    item?.select();
    if (!item || !revealSelected) {
      revealed.current = null;
      return;
    }
    // An inventory or decoration update must not undo manual tree scrolling.
    // Reveal only a new selection (or the first time that selection is available).
    if (revealed.current?.model !== model || revealed.current.path !== selected) {
      model.scrollToPath(selected, { focus: false, offset: 'nearest' });
      revealed.current = { model, path: selected };
    }
  }, [model, selected, prepared, revealSelected]);
  const activate = () => {
    const item = model.getFocusedItem();
    if (item && !item.isDirectory()) current.current.onSelect(item.getPath());
  };
  return (
    <FileTree
      model={model}
      renderContextMenu={onSetViewed ? (item, context) => (
        <TreeViewedMenu
          item={item}
          context={context}
          entries={entries}
          matchingPaths={query.trim() ? new Set(model.getSearchMatchingPaths()) : undefined}
          onSetViewed={onSetViewed}
        />
      ) : undefined}
      className="changes-file-tree"
      aria-label="Changed files"
      onClick={activate}
      onPointerOver={(event) => {
        const row = event.nativeEvent
          .composedPath()
          .find((node) => node instanceof Element && node.hasAttribute('data-item-path'));
        if (row instanceof Element) {
          const path = row.getAttribute('data-item-path');
          if (path) onPreview?.(path);
        }
      }}
      onFocusCapture={() => {
        const item = model.getFocusedItem();
        if (item && !item.isDirectory()) onPreview?.(item.getPath());
      }}
      onKeyUp={() => {
        const item = model.getFocusedItem();
        if (item && !item.isDirectory()) onPreview?.(item.getPath());
      }}
      onKeyDownCapture={(event) => {
        if (event.target instanceof Element && event.target.closest('[data-file-tree-context-menu-root]')) return;
        if (event.key === 'Enter' && model.getFocusedItem()?.isDirectory() === false) {
          event.preventDefault();
          event.stopPropagation();
          activate();
        }
      }}
    />
  );
}
