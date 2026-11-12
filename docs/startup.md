# Startup

Gnosis opens its window before saved data and the GitHub cache have loaded. The queue paints from the saved snapshot while the rest of the app loads in the background.

## Order in main

1. Read preferences, apply CLI path overrides and configure local clones.
2. If a GitHub cache clear is pending, open saved data and delete the cache first. This keeps the rule that deletion finishes before any GitHub request starts. It is the only case where the window waits.
3. Open the window. Its background colour matches the theme, so it does not flash white.
4. Load two things in parallel:
   - **Saved data:** the app data store, then GitHub logins, budgets and cooldowns, then the saved login for the stored token. This is the `data` phase. The app data store also holds muted PRs, starred PRs, saved views and unread progress. On the first launch after an upgrade, it imports their old JSON files once and renames each to `*.json.migrated`.
   - **The GitHub cache:** the SQLite worker validates saved responses and sends them as strings. Main parses each one the first time it is read, then freezes it and shares it with every reader.
5. When both finish (the `all` phase), start the tray, updates, proactive polling and analytics.
6. Three seconds later, build the command-search index: main sends only the feeds that changed since the last launch.
7. Five seconds later, mark generations that a crash interrupted as failed and copy missing summaries into the review index.
8. Thirty seconds later, apply the GitHub cache's disk limit, then run storage maintenance: drop the old search tables once, convert each database to incremental auto-vacuum once, and return free pages. Each step runs in a worker, never on the main thread.

## IPC handlers wait for the stores

`gateHandlers` in `src/startup.ts` wraps `ipcMain.handle` once, before any handler registers. Every handler waits for `all` by default, so a new handler is safe without extra work. Two lists in `src/main.ts` change that:

- `ungated` handlers run at once. They read only preferences, config or update state.
- `dataOnly` handlers wait for saved data but not the cache: review state, file progress, file filters, onboarding and auth state.

Add a handler to a list only if it reads nothing that loads later. The `pr-open-preload`, `pr-open-intent` and `github-sync-watch` listeners use `afterStartup`, which runs early messages in order once startup finishes. The GitHub sync tick also waits.

## Renderer

The renderer waits only for review state before its first render. Preferences are read once and applied when they arrive. The saved queue is requested at the same time as review state, so the first queue render has its rows.

The review page, the PR summary, settings, Markdown and the conflict editor load on first use. After the queue paints, the others load one at a time while the window is idle. A screen that can show a diff must load through `lazyScreen` in `lib/lazy-screen.ts`. It configures the diff highlighter before the screen resolves, because Pierre allows one highlighter backend per thread. `npm run check:startup-bundle` fails if diffs, shiki, Markdown or xyflow reach the startup bundle.

## Measuring

Set `GNOSIS_PERF_TRACE` to log startup marks:

```sh
tail -f /dev/null | GNOSIS_PERF_TRACE=exit npm start -- -- --user-data-dir=/path/to/profile-copy 2>&1 | grep '\[perf\]'
```

Electron Forge needs stdin kept open. Main logs each mark in milliseconds since the main process started. Renderer marks convert to the same clock. Once the queue has painted, main prints a summary. With `GNOSIS_PERF_TRACE=exit` it then quits, so you can time launches in a loop. Use a copy of a profile, never your own.

| Mark | Meaning |
| --- | --- |
| `create-window` | The window was created. |
| `data-ready`, `all-ready` | Saved data, then the GitHub cache too, finished loading. |
| `cache-open.worker` | Time the cache worker spent opening the database and reading rows. |
| `first-render` | The app rendered for the first time. |
| `snapshot-ipc` | The first saved queue snapshot arrived. |
| `queue-painted` | The first frame that shows queue rows or the empty state. |
| `search-apply` | One batch of search-index changes: feeds, documents, evictions and worker time. |
| `storage` | One maintenance step: the store, its file size, free pages and whether it converted. |

Each palette search also prints `[perf] command-search <ms>ms main=<ms> first=<bool> hits=<n>`. `main` is the main-thread time, and `first` marks a search that waited for the first index build.

Without the variable nothing is logged, and the renderer has no `perfMark`.
