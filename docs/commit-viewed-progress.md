# Commit review progress

The Commits list uses the same blue dot as unread PRs. A bold title and dot mean the commit has unviewed files. A normal-weight title without a dot means all files are viewed. Opening a commit alone does not mark it viewed.

The indicator follows the existing file Viewed checkboxes. Unmarking a file restores the indicator. The dot has a reserved space, so the title does not shift. Tooltips and screen-reader text also identify the state.

Completion is saved in the existing Viewed store in SQLite. Its key includes the PR URL, commit SHA, and comparison parent. New commits on the PR do not clear completed historical commits. Rewritten commits have new SHAs and start unviewed.

A row reports the commit's default-parent comparison. Other merge-parent comparisons have separate progress. Viewing a range does not mark each commit as complete: the range can hide changes between its endpoints. Full-PR Viewed progress remains separate.

The list uses saved completion and any comparisons already in memory. It does not fetch comparisons from GitHub to calculate indicators. Existing file marks are recognized when their comparison is available.

Changing the selected commit keeps the history list at its saved scroll position. Keyboard focus stays on the focused commit when the comparison workspace is replaced. The diff and file list retain their own per-comparison state.
