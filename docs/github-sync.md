# GitHub synchronization

Gnosis keeps a local queue and checks for changes while its window is visible. Routine checks use the header status indicator.
Initial discovery and manual refreshes also appear in Activity. The header indicator shows the last completed check, failures, and retry times.

## Discovery

The workbench checks discovery every two minutes. Personal searches cover authored PRs, assigned PRs, and review requests.
These searches remain complete so removed assignments and review requests leave the queue promptly. Daily search boundaries preserve reusable HTTP validators.
The exact inactivity setting still applies locally before detail requests.

Repository discovery stores a compact index in `workbench.json`. After the first pass, it requests PRs in update order, including closed PRs.
The update window overlaps the previous start time by two minutes. Pagination stops after reaching older updates.
A full repository reconciliation runs every thirty minutes. Explicit refreshes and changed discovery settings also cause full reconciliation.

Unchanged discovery timestamps and branch revisions preserve saved PR details. New PRs and changed PRs receive detail requests.
Known closed updates bypass reuse. Bookmarks and retained parents without current discovery evidence receive periodic detail checks.
Missing parent searches have a thirty-minute cache.

Completed batches update the visible queue before discovery finishes. Unseen members remain until reconciliation completes, which preserves stack context during partial updates.
Checkpoints preserve completed pages and details across rate limits and restarts. Credential changes invalidate checkpoint reuse.

## Request scheduling

Each credential has one serial network scheduler. Foreground requests precede queued background requests.
After eight foreground requests, waiting background work receives a turn. An active network request completes before the next request starts.
Fresh HTTP cache hits bypass this scheduler and remain available during network delays and backoff.

The scheduler reserves API allowance for interaction. Background requests pause near exhaustion and spread out as the remaining allowance decreases.
Primary limits apply separately to REST, search, and GraphQL. Secondary limits pause all network work for the credential.
Server retry deadlines and exponential backoff still apply. Writes are never replayed automatically.

The persistent HTTP cache permits 2,000 entries and 32 MB. Each entry has a 1 MB limit and a seven-day retention limit.
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

## Evidence

A service test uses 415 unchanged PRs. After sixteen minutes, it makes zero detail requests and one repository-list request.
A single changed PR makes one detail request. A closure leaves the queue, and periodic full reconciliation still reads every repository page.
Other tests cover progressive results, checkpoint recovery, credential changes, foreground priority, cache invalidation, and independent API allowances.
The Electron test covers the header indicator, retry information, keyboard tooltips, stable controls, and compact layouts.

## Follow-up

GitHub App webhooks and a server relay can supply push updates. That requires repository installation permissions and server infrastructure.
This change provides polling and local caching only. Polling remains necessary for repositories without webhook access and for recovery after missed events.
