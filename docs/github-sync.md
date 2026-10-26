# GitHub synchronization

Gnosis keeps a local queue and checks for changes while its window is visible. Routine checks use the header status indicator.
Initial discovery and manual refreshes also appear in Activity. The header indicator shows the last completed check, failures, and retry times.

## Discovery

The workbench checks discovery every two minutes. Personal searches cover authored PRs, assigned PRs, and review requests.
These searches remain complete so removed assignments and review requests leave the queue promptly. Daily search boundaries preserve reusable HTTP validators.
The exact inactivity setting still applies locally before detail requests.

Repository discovery stores a compact index in `workbench.sqlite`. After the first pass, it requests PRs in update order, including closed PRs.
The update window overlaps the previous start time by two minutes. Pagination stops after reaching older updates.
A full repository reconciliation runs every thirty minutes. Explicit refreshes and changed discovery settings also cause full reconciliation.

Unchanged discovery timestamps and branch revisions preserve saved PR details. New PRs and changed PRs receive detail requests.
Known closed updates bypass reuse. Bookmarks and retained parents without current discovery evidence receive periodic detail checks.
Missing parent searches have a thirty-minute cache.

Completed batches update the visible queue before discovery finishes. Unseen members remain until reconciliation completes, which preserves stack context during partial updates.
Checkpoints preserve completed pages and details across rate limits and restarts. Credential changes invalidate checkpoint reuse.

## Request scheduling

Each credential has one serial network scheduler with three priorities:

| Priority | Work |
| --- | --- |
| Interactive | Opening PR details, Changes, Commits, files, comments, images, profiles, explicit searches and refreshes, and submitting feedback |
| Foreground | AI context requests and automatic status checks for the selected PR |
| Background | Preloading, discovery, and status checks for other visible queue rows |

Interactive work always gets the next available slot before either lower tier. Without interactive work, background requests receive a turn after eight foreground requests.
An active network request completes before the next request starts. Priority never increases network concurrency.

If the UI opens something already being prepared, it promotes the shared operation instead of waiting behind background work.
Queued requests and later requests in that operation inherit the promotion. File downloads still occur once per side.
Promoted requests can use the allowance reserved for interaction. They cannot bypass primary exhaustion, secondary limits, or server retry deadlines.
Fresh HTTP cache hits bypass this scheduler and remain available during network delays and backoff.

The scheduler reserves API allowance for interaction. Background requests pause near exhaustion and spread out as the remaining allowance decreases.
Primary limits apply separately to REST, search, and GraphQL. Secondary limits pause all network work for the credential.
Server retry deadlines and exponential backoff still apply. Writes are never replayed automatically.

The HTTP response cache permits 2,000 entries and 32 MB. Each response has a 1 MB limit and a seven-day retention limit.
Prepared changes, commits, files, and review diffs also use a separate SQLite table. Memory eviction does not delete these prepared downloads.
The total downloaded-content budget defaults to 512 MB. **Settings → Integrations → GitHub cache → Disk cache size** offers 128 MB through 4 GB.
The HTTP cache uses 32 MB of that budget. Prepared downloads use the remainder, with 30-day retention and a 24 MB entry limit.
Size changes take effect immediately. The cache removes the oldest prepared downloads first. SQLite indexes and temporary journal files add disk overhead.
SQLite reads, writes, parsing, and retention run in a backend worker. The renderer keeps a smaller working set.
The cache stores response data and validators, without authentication headers or credentials.
PR comment and review routes invalidate the affected PR and repository listings. Unrelated PR details remain fresh.
Unscoped writes, including GraphQL mutations without a known PR, conservatively invalidate freshness across the account.

## Status checks

| Data | Cadence while visible |
| --- | --- |
| Selected PR or stack: CI, review decision, mergeability | 30 seconds |
| Selected PR or stack: complete status details | 2 minutes |
| Visible queue rows: compact status | 2 minutes |
| Queue discovery | 2 minutes |
| Full repository reconciliation | 30 minutes |

Status requests use GraphQL batches of up to 25 PRs. Selected PR results also update the queue cache.
Checks remain attached to their source revision. A result for a different head SHA cannot mark the displayed revision successful.
GitHub latency and backoff can extend these intervals. Cached data remains visible with its last check time.

Hidden windows stop recurring discovery and selected PR status requests. Existing background jobs can finish.
Diffs and file contents retain their separate revision-based caches.

## Preparing PR revisions

When a PR base or head SHA changes, discovery schedules that revision for preparation. Priorities follow user activity:

1. The selected PR or stack.
2. PRs visible in the queue viewport.
3. Other PRs in the current filtered view.
4. The remaining discovered queue.

Within each priority group, file and commit lists come first. Preparation then downloads the newest commit, changed files, review diff, and older commits.
Every individual commit and its files are eligible. Custom commit ranges, alternate merge parents, and LFS downloads remain on demand.
One preparation operation runs at a time. The scheduler checks priorities between operations, so a new selection moves ahead of unfinished work.
The current operation finishes before priorities change. Completed operations do not repeat after a pause or a priority change.
Background requests respect the shared GitHub allowance, reserved interactive capacity, and backoff. Failed operations retry with increasing delays.
Unsupported previews do not block other files. Preparation continues during navigation and while the window is hidden. It never starts AI generation.

A local restore pass loads saved inventories before network work starts. Changes and Commits use prepared data immediately when available.
An open diff keeps its displayed revision until the reviewer selects **Update changes**. Preparation of a newer revision does not replace displayed code.
Metadata and CI updates do not repeat content downloads for unchanged base and head SHAs.
Guided reviews check the current revision, then reuse its prepared file list, comparison base, full diff, and file contents.
Generation checks the revision again before saving. Fork files retain their source repository. Renamed files retain both paths.

The renderer retains up to 32 MB and 128 files. Eviction favors active PRs, visible PRs, and the current view.
When the selected PR leaves memory, preparation restores it from SQLite. Account changes clear renderer data and discard late responses.
Preparation can finish the eligible queue within the available API allowance and disk budget. A smaller budget can evict earlier downloads.
Cold data, new revisions, expired or evicted downloads, and unsupported previews can still require loading or a fallback.

## Clearing downloaded data

Use **Settings → Integrations → GitHub cache → Clear cache & restart** to remove downloaded GitHub data.
The action restarts Gnosis. Save unfinished text first. Active AI tasks must finish before the action can proceed.

Deletion runs on startup before requests begin, so old in-flight responses cannot restore cleared entries.
It removes the persistent GitHub response cache, discovery state, file and commit inventories, and the browser HTTP cache.
Restarting also removes in-memory profiles, comments, statuses, images, comparisons, and prepared files.

Saved reviews, briefings, bookmarks, muted PRs, saved views, grouping choices, preferences, and sign-in remain.
Daily briefing usage and GitHub cooldowns remain. The queue fetches fresh data under the existing API limits.

## Evidence

A service test uses 415 unchanged PRs. After sixteen minutes, it makes zero detail requests and one repository-list request.
A single changed PR makes one detail request. A closure leaves the queue, and periodic full reconciliation still reads every repository page.
Other tests cover progressive results, checkpoint recovery, credential changes, foreground priority, cache invalidation, and independent API allowances.
The Electron tests cover the header indicator, retry information, keyboard tooltips, stable controls, and compact layouts.
Preload tests verify tab opening without loading screens, file reuse, and updates that preserve the open diff.
Service tests verify exact-revision reuse during generation, account isolation, and revisions that change during preparation.

## Follow-up

GitHub App webhooks and a server relay can supply push updates. That requires repository installation permissions and server infrastructure.
This change provides polling and local caching only. Polling remains necessary for repositories without webhook access and for recovery after missed events.
