import { useEffect, useMemo, useRef } from 'react';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { prepareFileTreeInput, type GitStatusEntry } from '@pierre/trees';
export interface ChangeTreeEntry {
  key: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  viewed: boolean;
  additions: number;
  deletions: number;
}
export function ChangesFileTree({
  entries,
  selected,
  query,
  onSelect,
}: {
  entries: ChangeTreeEntry[];
  selected: string;
  query: string;
  onSelect: (path: string) => void;
}) {
  const current = useRef({ entries, onSelect });
  current.current = { entries, onSelect };
  const prepared = useMemo(
    () =>
      prepareFileTreeInput(
        entries.map((e) => e.key),
        { flattenEmptyDirectories: true }
      ),
    [entries]
  );
  const { model } = useFileTree({
    preparedInput: prepared,
    initialExpansion: 'open',
    search: false,
    fileTreeSearchMode: 'hide-non-matches',
    renderRowDecoration: ({ item }) => {
      const entry = current.current.entries.find((e) => e.key === item.path);
      return entry
        ? {
            text: entry.viewed ? 'Viewed' : `+${entry.additions} −${entry.deletions}`,
            title: entry.viewed ? 'Viewed' : `${entry.additions} additions, ${entry.deletions} deletions`,
          }
        : null;
    },
  });
  useEffect(() => {
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
  useEffect(() => {
    model.getItem(selected)?.select();
  }, [model, selected, prepared]);
  const activate = () => {
    const item = model.getFocusedItem();
    if (item && !item.isDirectory()) current.current.onSelect(item.getPath());
  };
  return (
    <FileTree
      model={model}
      className="changes-file-tree"
      aria-label="Changed files"
      onClick={activate}
      onKeyDownCapture={(event) => {
        if (event.key === 'Enter' && model.getFocusedItem()?.isDirectory() === false) {
          event.preventDefault();
          event.stopPropagation();
          activate();
        }
      }}
    />
  );
}
