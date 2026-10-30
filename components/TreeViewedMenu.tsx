import { useEffect, useRef, useId } from 'react';
import { Menu } from '@base-ui/react/menu';
import type { ContextMenuItem, ContextMenuOpenContext } from '@pierre/trees';
import type { ChangeTreeEntry } from './ChangesFileTree';
import { treeViewedFiles, selectedTreeFiles } from '../lib/tree-viewed-files';
import { setEntryMenuOpen } from '../lib/entry-menu-state';
import { toast } from './ui/toast';

/** Pierre owns the row target; the shared Base UI menu owns keyboard and popup behavior. */
export function TreeViewedMenu({
  item,
  context,
  entries,
  matchingPaths,
  selectedPaths = [],
  onSetViewed,
}: {
  item: ContextMenuItem;
  context: ContextMenuOpenContext;
  entries: ChangeTreeEntry[];
  matchingPaths?: ReadonlySet<string>;
  selectedPaths?: readonly string[];
  onSetViewed: (paths: string[], viewed: boolean) => Promise<boolean>;
}) {
  const descriptionId = useId();
  const id = useRef(Symbol('tree-viewed-menu'));
  useEffect(() => {
    const current = id.current;
    setEntryMenuOpen(current, true);
    return () => setEntryMenuOpen(current, false);
  }, []);
  const multiple = selectedPaths.length > 1 && selectedPaths.includes(item.path);
  const files = multiple ? selectedTreeFiles(entries, selectedPaths, matchingPaths) : treeViewedFiles(entries, item, matchingPaths);
  const noun = multiple ? 'selected files' : item.kind === 'directory' ? 'folder' : 'file';
  const run = (viewed: boolean) => {
    const keys = files.filter((file) => file.viewed !== viewed).map((file) => file.key);
    // Restore tree focus before Unviewed only removes the affected folder.
    context.close();
    void onSetViewed(keys, viewed).catch((error: unknown) => {
      toast.add({
        type: 'error',
        title: 'Could not update Viewed files',
        description: error instanceof Error ? error.message : String(error),
      });
    });
  };
  return (
    <Menu.Root
      open
      onOpenChange={(open) => {
        if (!open) context.close();
      }}
    >
      <Menu.Portal>
        <Menu.Positioner
          className="entry-menu-positioner"
          anchor={{ getBoundingClientRect: () => context.anchorRect }}
          side="bottom"
          align="start"
          collisionPadding={12}
        >
          <Menu.Popup
            className="entry-menu"
            aria-label={multiple ? `Actions for ${files.length} selected files` : `Actions for ${item.path}`}
            aria-describedby={descriptionId}
            data-file-tree-context-menu-root="true"
            finalFocus={() => {
              context.restoreFocus();
              return false;
            }}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <div id={descriptionId} className="px-2 py-1 text-xs text-muted-foreground">
              {multiple ? `${files.length} selected files match your filters` : `${files.length} ${files.length === 1 ? 'file matches' : 'files match'} your filters`}
            </div>
            <Menu.Item
              className="entry-menu-item"
              disabled={!files.some((file) => !file.viewed)}
              onClick={() => run(true)}
            >
              Mark {noun} as viewed
            </Menu.Item>
            <Menu.Item
              className="entry-menu-item"
              disabled={!files.some((file) => file.viewed)}
              onClick={() => run(false)}
            >
              Mark {noun} as unviewed
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
