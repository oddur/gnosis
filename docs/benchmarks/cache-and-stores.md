# GitHub cache and store benchmark

Two kinds of main-process work used to copy or rewrite more than they needed:

- **GitHub cache hits (#258).** The cache cloned every value it returned, and the Octokit hook cloned it again. A 304 cloned the saved response three times.
- **User stores (#259).** Muting, starring or saving a view rewrote a whole JSON file on the main thread. With 649 muted PRs, that was 2.6 MB per mute.

Cached values are now frozen and shared, and each Octokit caller gets one copy. Mutes, stars, saved views and unread progress are saved by the app data worker, and a change sends only the rows it touches.

## Run it

```bash
npm run benchmark:cache-stores
```

The script makes no network requests. It also runs on commits before #258 and #259, and detects which store API it runs against.

It measures:

- **Changes:** the main-thread time of one mute, unmute, star, `stars.update` and "mark as unread". This is the call plus the microtask that hands the change to the worker. The profile has 649 muted PRs with 4 KB descriptions, 200 stars and 649 unread-progress entries.
- **Cache:** `get` on a 1 MB entry, and `getPrepared` on a 23 MB prepared entry whose write is still queued (wall time).
- **Octokit:** a 3,000-file `pulls.listFiles` read through `paginate`, as 30 pages of 100 files, 7.5 MB in total. It times a read from memory, a forced read that downloads every page (200), and a read after expiry that GitHub confirms with an ETag (304).
- **Startup:** `appData.open`, then the first muted index, with and without the muted PRs. This is the work behind the `data-open` mark, outside Electron.

## Results

Measured on 2026-11-12, Apple M5 Max, macOS arm64, Node 25.9.0. Medians, with p95 in brackets, from the first of three runs. The other runs were within about 20%.

| | Before (`e19d82c`) | After |
| --- | ---: | ---: |
| Mute one PR | 3.98 ms (7.96) | 0.35 ms (0.55) |
| Unmute one PR | 3.78 ms (4.96) | 0.32 ms (0.54) |
| Star one PR | 3.48 ms (4.38) | 0.15 ms (0.22) |
| `stars.update`, one changed PR | 4.23 ms (4.69) | 0.13 ms (0.19) |
| Mark one PR unread | 0.64 ms (0.82) | 0.06 ms (0.14) |
| `get`, 1 MB entry | 1.04 ms (1.10) | 0.00 ms (0.01) |
| `getPrepared`, 23 MB write queued | 138 ms (152) | 19 ms (23) |
| Octokit memory hit, 30 pages | 7.35 ms (11.0) | 3.18 ms (5.98) |
| Octokit 200, 30 pages | 34.7 ms (35.6) | 22.0 ms (24.8) |
| Octokit 304, 30 pages | 27.4 ms (29.8) | 11.7 ms (13.9) |
| `appData.open`, no muted PRs | 48.8 ms (50.1) | 46.1 ms (47.9) |
| `appData.open`, 649 muted PRs | 46.6 ms (47.0) | 51.6 ms (56.5) |
| First muted index, 649 muted PRs | 4.07 ms (5.16) | 1.12 ms (1.18) |

Before, opening app data did not read the muted file; the first muted index parsed it instead. After, `appData.open` returns the muted rows, so it takes up to about 5 ms longer with 649 muted PRs, and the first index takes about 3 ms less. The first launch after the upgrade also imports the old files once: about 117 ms with 649 muted PRs, against 55 ms without them.

The `getPrepared` time is now spent parsing the queued 23 MB payload on the main thread. Before, the read waited for the worker to write the payload, then read it back.

## What changed

- `get`, `values` and `getPrepared` return the cached value itself, deeply frozen. A saved record is parsed once, on its first read.
- `set` serializes once and keeps the text until the first read. The Octokit hook hands its response to the cache with `owned`, which freezes it in place instead of copying it.
- The Octokit hook still copies once per caller, because pagination deletes keys from `data` in place.
- `getPrepared` answers from a queued or unsettled write instead of waiting for it.
- Mutes and stars are saved as one row per PR. A change patches only its rows, in the same transaction as other saved work.
