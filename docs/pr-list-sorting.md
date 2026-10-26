# PR list sorting

Use the sort control beside Filters in the Review queue. It also applies to built-in lists and saved views. Saved reviews have a separate sort setting.

**Priority** keeps the current attention groups. Other sorts order the whole list and hide those group headings. **Starred first** is a separate setting, enabled by default.

| Sort | Default order | Stack value |
| --- | --- | --- |
| Last updated | Newest first | Latest member update |
| Date opened | Newest first | Earliest member creation |
| Change size | Smallest first | Total added and removed lines |
| Unread first | Unread before read | Any member is unread |
| Review status | Changes requested, awaiting review, approved, draft, merged, closed | First member status in this order |
| Author, Repository, Title | A–Z | Root PR |
| Date generated | Newest first | Saved explanation date; Saved reviews only |

Dates, size, and text sorts can be reversed. Missing values stay last in either direction. Stacks remain one entry, with members in dependency order.

The queue remembers its sort across restarts. Saved views store the sort and filters together. Clear filters keeps the current sort. Restore saved filters restores the saved view's filters and sort.

Sorting uses local data. Review status uses cached signals for the current PR revision; it does not request a GitHub refresh. Normal visible-row status checks still run.

Previous and next navigation follow the displayed order. Live updates preserve the visible selected row or the top visible row. An open entry menu holds the current order until it closes.

Automatic briefings follow this order among eligible PRs. A running briefing finishes before the next starts. Preloading keeps its selected, visible, and unread priority groups, then uses list order within each group.
