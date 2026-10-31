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
| Interactive | Opening PR details, Changes, Commits, files, comments, images, profiles, explicit searches and refreshes, file questions, task admission/retry, and submitting feedback |
| Foreground | AI context requests and automatic status checks for the selected PR |
| Background | Preloading, discovery, optional file history, automatic briefings, and status checks for other visible queue rows |

Interactive work always gets the next available slot. Foreground work runs next. Background work runs only when neither higher tier has a queued request. Large requested tasks no longer yield a slot to optional work after eight requests.
An active network request completes before the next request starts. Priority never increases network concurrency.

If the UI opens something already being prepared, it promotes the shared operation instead of waiting behind background work.
Queued requests and later requests in that operation inherit the promotion. File downloads still occur once per side.
Promoted requests can use the allowance reserved for interaction. They cannot bypass primary exhaustion, secondary limits, or server retry deadlines.
Fresh HTTP cache hits bypass this scheduler and remain available during network delays and backoff.

Explanation preparation reports completed files, including both required sides, as “Loading files: N/M”. Cached contents use the same progress path. A rate-limited file read retains its completed work, shows the retry time in Activity, and resumes after the deadline. Cancellation remains available while waiting.

Optional file age and churn start only after the explanation inputs are ready, at background priority. They do not delay delivery: the review includes available history or its known file inventory, and cancels unfinished history requests. These requests also stop on generation failure or cancellation.

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

Screens now subscribe to a shared Electron coordinator. It batches visible-row status reads, prioritizes the open PR, and slows unchanged resources. Backend cache updates reach the renderer through IPC. Queue discovery still runs every two minutes.

See [Reactive GitHub sync](reactive-github-sync.md) for the current cadences, account isolation, resume behavior, and local push updates. Checks remain attached to their source revision, and GitHub backoff can extend all network intervals.

## Preparing PR revisions

When a PR base or head SHA changes, discovery schedules that revision for preparation. Priorities follow user activity:

1. The selected PR or stack.
2. PRs visible in the queue viewport.
3. Unread PRs, including those outside the current filtered view.
4. Other PRs in the current filtered view.
5. The remaining discovered queue.

Read-state changes update these priorities without repeating completed preparation. Stack members use their individual unread states.
The selected [list sort](pr-list-sorting.md) sets the order within these priority groups for PRs in the current view.

Within each priority group, file and commit lists come first. Preparation then downloads the newest commit, changed files, review diff, and older commits.
Every individual commit and its files are eligible. Custom commit ranges, alternate merge parents, and LFS downloads remain on demand.
One preparation operation runs at a time. The scheduler checks priorities between operations, so a new selection moves ahead of unfinished work.
The current operation finishes before priorities change. Completed operations do not repeat after a pause or a priority change.
Background requests respect the shared GitHub allowance, reserved interactive capacity, and backoff. Failed operations retry with increasing delays.
Unsupported previews do not block other files. Preparation continues during navigation and while the window is hidden. It never starts AI generation.

Activity shows one **Preparing PRs for instant opening** entry below user-requested tasks. It shows the current PR, preparation stage, progress, and prepared/pending counts.
When GitHub limits stop preparation, the entry shows a pause and keeps its progress visible. Failed operations retry automatically.
The entry disappears after preparation finishes. It does not create a completion toast. Activity reads this local status without additional GitHub requests.

A local restore pass loads saved inventories before network work starts. Changes and Commits use prepared data immediately when available.
An open diff keeps its displayed revision until the reviewer selects **Update changes**. Preparation of a newer revision does not replace displayed code.
Metadata and CI updates do not repeat content downloads for unchanged base and head SHAs.
Guided reviews check the current revision, then reuse its prepared file list, comparison base, full diff, and file contents.
Generation checks the revision again before saving. Fork files retain their source repository. Renamed files retain both paths.

The renderer retains up to 32 MB and 128 files. Eviction favors active PRs, visible PRs, unread PRs, and the current view.
When the selected PR leaves memory, preparation restores it from SQLite. Account changes clear renderer data and discard late responses.
Preparation can finish the eligible queue within the available API allowance and disk budget. A smaller budget can evict earlier downloads.
Cold data, new revisions, expired or evicted downloads, and unsupported previews can still require loading or a fallback.

## Local clones

**Settings → Integrations → Local clones** registers a clone on this computer. Its GitHub remotes decide which repositories it serves. Shallow clones are rejected because they cannot compute a merge base. A clone that later becomes shallow falls back to GitHub until its history is complete.
A blobless clone (`git clone --filter=blob:none --no-checkout <url>`) also works. It is small, and Git downloads file contents as needed.

With a clone registered, these reads come from Git instead of the API:

| Source | Data |
| --- | --- |
| Clone | Changed files and patches, review diffs, merge bases, commit lists, commit and range comparisons, combined stack changes, stack ancestry, file contents, images, and file history |
| GitHub | Discovery, PR details and descriptions, comments, reviews, checks, profiles, LFS downloads, and every write |

Changes and Commits for a queued PR use the revision and details from the last queue update, without waiting for a GitHub request. This also lets the clone keep preparing PRs while the API is paused. **Update changes** and other explicit refreshes still ask GitHub first, and the next queue update picks up newer commits.

Gnosis checks for a commit before reading it. A missing commit starts `git fetch <remote> <sha>`, and readers that arrive during a fetch share the next batch.
This adds Git objects only. It leaves refs, `FETCH_HEAD`, branches, and the working tree alone, and Git can prune these objects later. Fetches use the clone's own Git credentials.

Clone reads skip the request scheduler and use at most eight Git processes per clone. They also have no 3,000-file or 300-file limit.
Any clone failure falls back to GitHub: a moved folder, a failed fetch, or a commit list whose length differs from the PR's. A commit that fails to fetch is not retried for five minutes. An interactive read waits thirty seconds for a fetch, then uses GitHub while the fetch finishes.

Commit lists from a clone show a GitHub username only when the author email is a GitHub noreply address. They never show the **Verified** badge, because signature verdicts come from GitHub.

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
