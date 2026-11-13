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

Each credential has one shared network scheduler with three priorities:

| Priority | Work |
| --- | --- |
| Interactive | Opening PR details, Changes, Commits, files, comments, images, profiles, explicit searches and refreshes, file questions, task admission/retry, and submitting feedback |
| Foreground | AI context requests, automatic status checks for the selected PR, hover and focus prefetch, and navigation predictions |
| Background | Preloading, discovery, optional file history, automatic briefings, and status checks for other visible queue rows |

Up to six requests run at the same time for each credential. Foreground and background work together use at most four of these slots, and background work uses at most two. Two slots are therefore always kept for interactive work. Interactive work gets the next free slot, then foreground work. Background work starts only when no higher tier has a queued request.
Writes run alone. A write waits for running requests to finish, and no other request starts until the write completes. Requests are not spaced apart. A burst of more than 60 requests is slowed to ten requests per second, which stays below GitHub's per-minute secondary limit.

If the UI opens something already being prepared, it promotes the shared operation instead of waiting behind background work.
Queued requests and later requests in that operation inherit the promotion. File downloads still occur once per side.
Promoted requests can use the allowance reserved for interaction. They cannot bypass primary exhaustion, secondary limits, or server retry deadlines.
Fresh HTTP cache hits bypass this scheduler and remain available during network delays and backoff.

PR status and review discussions open from the last saved copy when one exists for the same head revision and is less than 24 hours old. Gnosis then refreshes it at foreground priority, outside the automatic budget, and replaces it in place. Saved copies never report mergeability, and merge readiness older than two minutes is shown as out of date. Writes, explicit refreshes and "Update changes" always read GitHub first. If the refresh fails or GitHub is rate limited, the saved copy stays with its last-checked time and an error.

Queue rows show their saved status in the first frame after launch. The first queue snapshot a window reads also carries the saved status for up to 300 PRs in the queue and the starred list, each for its current head revision. A PR whose head changed since the save shows no status until GitHub answers. Saved status older than two minutes is marked as out of date with its last-checked time, and visible rows then refresh it. Later snapshots do not carry saved status, and it never changes the queue's revisions.

Opening a PR without a saved status for the queue's head reads its status at interactive priority. That read starts the checks and activity signals for the queue's head at the same time as the PR details. If GitHub reports another head, Gnosis discards those results and reads them again for the reported head, so a result never describes the wrong revision. The Checks view also makes one interactive read for PRs that have nothing to show yet. It shares the status read's checks query.

Changes and Commits also start from the queue's revision. Changes lists the files and reads the merge base together. Commits lists the commits. One PR read afterwards confirms the revision. If the revision moved, Gnosis discards both results and loads again from the confirmed revision. **Update changes** starts from the newest queued revision in the same way.

The workflow graph reads the run's workflow file and every reusable workflow that the run pins to a commit in one GraphQL query. One query reads up to 32 files, and a run reads up to 50. A file the query cannot return, or a file larger than 256 KB, uses one REST request, as before.

Gnosis also fills these saved copies ahead of time. For the first 100 PRs in priority order it saves status and review summaries, 25 PRs per GraphQL query. For the first 40 it also saves check summaries and review discussions, 5 PRs per query. This work runs at background priority and uses only the GraphQL automatic budget. It stops when that budget is half spent, when the window is hidden, after five minutes without input, and during any GitHub backoff. A saved copy is refreshed when the PR's revision or update time changes, when its activity signal changes, or after six hours.

Resting the pointer or keyboard focus on a queue row for 150 ms moves that PR to the front of preparation. If its saved copies are missing or out of date, Gnosis reads them at foreground priority, outside the automatic budget. At most one such read runs at a time, and at most three start in quick succession, then one every five seconds. These reads never use the two interactive slots.

### Navigation predictions

Opening a PR prepares the tabs you are likely to open next. `lib/navigation-graph.ts` lists them with a weight: Changes, Checks when checks fail or run, and Feedback when the PR has open threads or needs your response. For each one above 0.2, Gnosis reads the changed-file list, the commit list, the first three files in tree order (or the file you last viewed), review threads, failing check details, and the newest workflow run and its graph. Saved copies that are still current send nothing.

These reads run at foreground priority and never use the two interactive slots. They are not paced. They have their own budget: by default 6% of each allowance per local hour (300 REST requests and 300 GraphQL points on a standard token), separate from the automatic 20%. Settings can change the share to 3%, 10% or 15%; it scales with the token's real limit. They stop when the remaining allowance is at twice the background reserve (1,000 of 5,000 REST requests), during any backoff, when the window is hidden, offline, or after five minutes without input. Predictions never search, write, download LFS objects, generate with AI, or mark anything read. Past 75% of the predicted budget, or on battery, they use one amount less (see below), never less than Light.

If you open a tab while its prediction is still loading, your request joins the prediction instead of sending a second request. The rest of that work runs as yours, at interactive priority. ### Preloading settings

Settings › Integrations › Preloading has four controls. Main and every window apply changes at once.

- **Preload likely next pages** (on by default) turns navigation predictions and all hover and focus intent off, queue rows included.
- **Amount** chooses how much an opened PR warms. Light: the file list and commit list, one file body, and threads; no workflow graph and no check details. Normal: three file bodies, the workflow graph of the preferred run, and failing check details (up to five). Eager: six file bodies, the graph, failing check details, the logs of up to three failing jobs in the preferred run (the same 2 MB reader as Checks › Job log, kept in memory so the log opens at once), and the graphs of up to two other stack PRs with failing checks.
- **Prepare the top of the queue** (on by default) controls the queue preparation described above and the queue's inspection worker. When it is off, only the open PR is prepared in the background.
- **Hourly GitHub budget** is the predicted share above. Settings shows this hour's spend next to it.

`GNOSIS_PREDICT=off` forces "Preload likely next pages" off for benchmarks, whatever the setting says.

Explanation preparation reports completed files, including both required sides, as “Loading files: N/M”. Cached contents use the same progress path. A rate-limited file read retains its completed work, shows the retry time in Activity, and resumes after the deadline. Cancellation remains available while waiting.

Optional file age and churn start only after the explanation inputs are ready, at background priority. They do not delay delivery: the review includes available history or its known file inventory, and cancels unfinished history requests. These requests also stop on generation failure or cancellation.

Automatic work has its own budget: 20% of the reported allowance per credential and API resource. For a standard REST token, that is 1,000 automatic requests per local hour. Search uses a one-minute window. The counters survive restarts and sign-out. Automatic requests are paced across the window, with a separate pause near GitHub's exhaustion threshold.

This budget includes preloads, discovery, tray status, automatic briefings, and routine refreshes of visible PRs and checks. Urgent automatic reads retain foreground scheduling priority but still count against the budget. Manual refreshes, writes, user-requested explanations, and bounded follow-ups after a write can use the reserved capacity. All work still obeys GitHub's actual limits.

GraphQL sync queries report their point cost. Other GraphQL reads use the observed same-window quota decrease when available, or one point until cost is known. A query already in flight can cross the local budget; later automatic queries pause. Budget counters are saved at most once per second, off the request path, and when the app quits. Rate-limit deadlines are saved immediately.
Primary limits apply separately to REST, search, and GraphQL. Secondary limits pause all network work for the credential. Requests already in flight finish and are not retried. Failures from one throttling event count once toward the escalating delay.
Server retry deadlines and exponential backoff still apply. Writes are never replayed automatically.

The HTTP response cache permits 2,000 entries and 32 MB. Each response has a 1 MB limit and a seven-day retention limit.
Contents and Git blob/tree responses pinned to a full SHA can remain fresh for 24 hours. Branch names, PR metadata, checks, explicit refreshes, and no-cache responses keep their existing validation rules.
Prepared changes, commits, files, and review diffs also use a separate SQLite table. Memory eviction does not delete these prepared downloads.
The total downloaded-content budget defaults to 512 MB. **Settings → Integrations → GitHub cache → Disk cache size** offers 128 MB through 4 GB.
The HTTP cache uses 32 MB of that budget. Prepared downloads use the remainder, with 30-day retention and a 24 MB entry limit.
Size changes take effect immediately. The cache removes the oldest prepared downloads first. At launch, the limit applies 30 seconds after startup, because the first check reads every prepared download. SQLite indexes and temporary journal files add disk overhead.
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

Within each priority group, file and commit lists come first, then current changed files, the newest commit, and the review diff. Older commit history runs after these stages have completed for all ready PRs, so one long history cannot consume the budget before other PRs are usable.
Every individual commit and its files are eligible. Custom commit ranges, alternate merge parents, and LFS downloads remain on demand.
One preparation operation runs at a time. The scheduler checks priorities between operations, so a new selection moves ahead of unfinished work.
The current operation finishes before priorities change. Completed operations do not repeat after a pause or a priority change.
Background requests respect the shared GitHub allowance, reserved interactive capacity, and backoff. Failed operations retry with increasing delays.
Unsupported previews do not block other files. Preparation continues during navigation. It pauses between operations while the window is hidden or offline, then resumes when the window becomes visible or connectivity returns. It never starts AI generation.

Activity shows one **Preparing PRs for instant opening** entry below user-requested tasks. It shows the current PR, preparation stage, progress, and prepared/pending counts.
When GitHub limits stop preparation, the entry shows a pause and keeps its progress visible. Failed operations retry automatically.
The entry disappears after preparation finishes. It does not create a completion toast. Activity reads this local status without additional GitHub requests.

A local restore pass loads saved inventories before network work starts. Changes and Commits use prepared data immediately when available.
An open diff keeps its displayed revision until the reviewer selects **Update changes**. Preparation of a newer revision does not replace displayed code.
Metadata and CI updates do not repeat content downloads for unchanged base and head SHAs.
Source bytes also have a shared SQLite cache keyed by credential, repository, full commit SHA, and path. A new head reuses unchanged base-file bytes; PR, commit, and stack comparisons share matching source. Concurrent reads share one download. This cache uses the existing disk budget and is removed by Clear cache. LFS downloads remain explicit.
Guided reviews check the current revision, then reuse its prepared file list, comparison base, full diff, and file contents.
Generation checks the revision again before saving. Fork files retain their source repository. Renamed files retain both paths.

The renderer retains up to 32 MB and 128 files. Eviction favors active PRs, visible PRs, unread PRs, and the current view.
When the selected PR leaves memory, preparation restores it from SQLite. Account changes clear renderer data and discard late responses.
Preparation can finish the eligible queue within the available API allowance and disk budget. A smaller budget can evict earlier downloads.
Cold data, new revisions, expired or evicted downloads, and unsupported previews can still require loading or a fallback.

## Local clones

Open a repository under **Settings → Repositories**. Then select **Local clone → Choose folder…**.
The folder must have a GitHub remote that matches the selected repository. Gnosis connects it only to that repository, even if other remotes exist.

**Change folder…** replaces that repository's clone. **Disconnect** removes its connection and keeps the folder.
Clone changes apply immediately, without **Save settings**, and affect only this computer. Bulk repository settings do not include clone controls.
Existing connections remain in `local-clones.json`.

Gnosis rejects shallow clones because they cannot compute a merge base. A clone that later becomes shallow falls back to GitHub until its history is complete.
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

Deletion runs on startup before requests begin, so old in-flight responses cannot restore cleared entries. On that launch the window opens after the deletion.
It removes the persistent GitHub response cache, discovery state, file and commit inventories, and the browser HTTP cache.
Restarting also removes in-memory profiles, comments, statuses, images, comparisons, and prepared files.

Saved reviews, briefings, bookmarks, muted PRs, saved views, grouping choices, preferences, and sign-in remain.
Daily briefing usage and GitHub cooldowns remain. The queue fetches fresh data under the existing API limits.

## Command search

Command search reads a SQLite index in the saved-work worker (`workbench.sqlite`). It never sends a request.

**What it indexes.** Each document holds bounded metadata only: a title of at most 300 characters, a 600-character snippet with collapsed whitespace, and a 300-character preview. It stores no diff hunks, patches or full descriptions.
- **PRs and stacks:** title, `repo #n`, authors, labels, and base and head branches, then the start of the description.
- **Files:** the path and the start of the file summary.
- **Comments, topics, insights, briefings and explainers:** a snippet.

Searching for text inside a diff therefore finds nothing. Paths and summaries still match.

**Feeds.** Documents are grouped into feeds, and main sends a feed only when the hash of its documents changes:

| Feed | Source |
| --- | --- |
| `queue:<subject id>`, `queue:meta` | The queue, after each `workbench-changed`, debounced 1 s. Pinned: never evicted. |
| `http:<cache id>` | A cached `/pulls/n`, `/files` or `/comments` response, from the GitHub cache's change hook. |
| `threads:<PR URL>` | Cached review threads: once at the first build, then from the change hook. |
| `review:<id>` | A saved review. The worker stats the file and rebuilds it only when it changed. |

Main sends changes after 500 ms without new events, or after 2 s at most, in messages of up to 500 documents. The first build runs 3 s after startup; a search that comes earlier waits for it. Responses cached before an upgrade are not read back; they return to search when GitHub data refreshes.

**Cap.** Each account keeps at most 6,000 documents. Above that, the oldest unpinned documents are removed. A removed feed keeps its hash, so main does not send it again while it is unchanged.

**Query time.** Mutes, Dependabot rules and queue precedence apply when you search, so they never need a rebuild. A cached PR or saved review is hidden when the queue holds the same URL, and its other results join the queue entry's group. Results store a subject ID; main replaces it with the current queue entry for the returned page only.

## Disk space

Both SQLite stores use incremental auto-vacuum and limit the WAL to 16 MB after each checkpoint. New files start in that mode.
An existing file converts once, with one `VACUUM` in its worker. The conversion runs only when free disk space is at least twice the live data plus 256 MB. The GitHub cache also waits until the computer has been idle for 60 seconds. If space is short or the step fails, Gnosis logs a warning and tries again on the next launch. A crash during `VACUUM` leaves the original file.
After that, each maintenance step returns at most 8 MB of free pages, and runs while more than 4 MB stays free. Maintenance starts after the 30-second cache trim, repeats every 10 minutes and runs after the cache size changes. It never runs at startup or while a cache clear is applied.

**Settings → Integrations** shows the size on disk of the GitHub cache and of saved work and search, each including its WAL file.

Clearing the cache also empties the search index. The next launch rebuilds it from the queue and saved reviews.

## Evidence

A service test uses 415 unchanged PRs. After sixteen minutes, it makes zero detail requests and one repository-list request.
A single changed PR makes one detail request. A closure leaves the queue, and periodic full reconciliation still reads every repository page.
Other tests cover progressive results, checkpoint recovery, credential changes, foreground priority, cache invalidation, and independent API allowances.
The Electron tests cover the header indicator, retry information, keyboard tooltips, stable controls, and compact layouts.
Preload tests verify tab opening without loading screens, file reuse, and updates that preserve the open diff.
Service tests verify exact-revision reuse during generation, account isolation, and revisions that change during preparation.

A deterministic transport simulation previously spent 1,000 REST preload requests in 800,199 ms (about 13 minutes). It now spreads those requests across about an hour and pauses further automatic reads until the local window resets. Interactive requests and cached reads remain available. Other regressions cover restart accounting, GraphQL cost, unchanged file-side reuse, and current changes before history. The browser fixture verifies prepared Changes and Commits open without loading flashes.

## Follow-up

GitHub App webhooks and a server relay can supply push updates. That requires repository installation permissions and server infrastructure.
This change provides polling and local caching only. Polling remains necessary for repositories without webhook access and for recovery after missed events.
