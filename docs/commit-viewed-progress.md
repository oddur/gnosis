# Commit review progress

The Commits list uses the same blue dot as unread PRs. A bold title and dot mean the commit has unviewed files. A normal-weight title without a dot means all files are viewed. Opening a commit alone does not mark it viewed.

The indicator follows the existing file Viewed checkboxes. Unmarking a file restores the indicator. The dot has a reserved space, so the title does not shift. Tooltips and screen-reader text also identify the state.

Completion is saved in the existing Viewed store in SQLite. Its key includes the PR URL, commit SHA, and comparison parent. New commits on the PR do not clear completed historical commits. Rewritten commits have new SHAs and start unviewed.

A row reports the commit's default-parent comparison. Other merge-parent comparisons have separate progress. Viewing a range does not mark each commit as complete: the range can hide changes between its endpoints. Full-PR Viewed progress remains separate.

The list uses saved completion and any comparisons already in memory. It does not fetch comparisons from GitHub to calculate indicators. Existing file marks are recognized when their comparison is available.

Changing the selected commit keeps the history list at its saved scroll position. Keyboard focus stays on the focused commit when the comparison workspace is replaced. The diff and file list retain their own per-comparison state.

## Folder actions

Right-click a folder in the Changes or Commits file tree, or press Shift+F10 on the focused folder. Choose **Mark folder as viewed** or **Mark folder as unviewed**. The menu shows the number of matching files.

The action includes nested files, even when their folders are collapsed. It respects file-type, extension, filename-search, and Unviewed only filters. Hidden files and files outside the loaded inventory are not marked. File rows offer the same actions for one file.

Folder updates use one saved progress patch. Changes progress remains shared with explanations for the same revision. Commit comparisons and combined stack changes keep their existing separate progress scopes.
