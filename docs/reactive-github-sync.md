# GitHub sync without webhooks

Gnosis keeps GitHub reads in Electron. Screens subscribe to the data they need. A shared coordinator schedules each PR and resource once, even when several screens use it. SQLite and the existing GitHub client remain the source of cached data and API backoff.

```text
Visible rows / open PR / open discussion
  → subscriptions owned by the window
  → backend scheduler: active PRs before visible rows
  → authenticated, conditional GitHub reads
  → shared caches and queue metadata
  → IPC updates to the subscribed screens
```

## Scheduling

| Resource | Active cadence | After unchanged responses |
| --- | --- | --- |
| Status signals, batched up to 25 PRs | 25 seconds | Up to 100 seconds |
| PR metadata | 30 seconds | Up to 120 seconds |
| Detailed checks | 30 seconds | Up to 120 seconds |
| Inline discussions | 60 seconds | Up to 240 seconds |
| Queue discovery | Two minutes | Uses existing incremental listings and cached metadata |

Running checks retain the short cadence. Visible queue rows use the shared status batch at most once per two minutes. Offscreen rows do not schedule status reads. Navigation retains recent task freshness for five minutes, so reopening a PR does not restart its polling clock.

These are scheduling intervals, not delivery guarantees. GitHub backoff, request duration, and higher-priority work can delay a refresh. REST and GraphQL budget pauses remain separate. Failed reads back off and keep the last data. A successful retry clears the screen's error, even when the data is unchanged.

Sync pauses while offline, suspended, or without a visible app window. Resume, reconnect, and focus request catch-up work. A short focus debounce prevents repeated application switching from producing request bursts. Manual refresh remains available through the existing interactive request path.

## Local updates

Queue and history changes notify the renderer. The renderer reads the new local snapshot; the notification does not start discovery. Activity changes also push updates. A one-minute local activity sweep only expires old tasks. Preload progress has a separate local subscription.

Metadata updates reach the existing inspection preload queue through the queue snapshot. Its revision keys keep unchanged content cached. New heads and base revisions become new preload targets. An open diff or saved explanation stays on its displayed revision and shows that newer changes are available.

A head mismatch in a batched status response requests metadata for that PR. It never associates checks from a new head with the old head. Late summary reads also cannot replace a newer status snapshot for the same revision.

Review submissions, comments, PR actions, and check reruns invalidate the affected status or discussion data. Review activity can prompt an earlier discussion refresh; changed check counts can prompt an earlier detailed-check refresh. These updates do not require a queue-wide refresh.

Subscriptions are scoped to a window and credential. Closing a window removes its subscriptions. Account changes discard old in-flight results and re-register visible subscriptions. IPC validates the resource type, URLs, revisions, and batch size.

## Validation

Unit tests cover request sharing, priorities, adaptive cadence, resource-specific backoff, account changes, in-flight invalidation, rapid navigation, retry recovery, and batch draining. The native-path browser fixture verifies local queue updates without discovery, Activity push updates, live check results, and a stable diff after a revision notification.

Without webhooks, remote changes still need a GitHub read before Gnosis can know about them. This design reduces duplicate work and removes the extra wait between a completed backend refresh and its display.
