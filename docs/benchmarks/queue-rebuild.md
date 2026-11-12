# Queue rebuild benchmark

A queue rebuild (`view()` in `src/workbench-service.ts`) runs in the main process for every queue snapshot and every `workbench-changed` push. On a large profile it took about 47 ms and sent a 4.9 MB snapshot. It now takes about 9 ms and sends 2.1 MB.

## Run it

```bash
npm run benchmark:queue                    # main's cached saved reviews and preferences
npm run benchmark:queue -- --uncached      # read both files on every call
GNOSIS_PERF_TRACE=1 npm run benchmark:queue
```

The script generates a local profile with no GitHub access:

- 400 single-PR queue subjects;
- 649 muted PRs with 4 KB descriptions, 2.9 MB on disk, close to the 2.6 MB profile measured in #252;
- 512 saved reviews with subject snapshots, a 3.5 MB index.

It builds the queue once, then times 30 more rebuilds. It also times filtering the saved reviews by mutes, which the tray did on each rebuild.

## Results

Measured on 2026-11-12, Apple M5 Max, macOS arm64, Node 25.9.0. Three runs each.

| | Before (`83a4564`) | After |
| --- | ---: | ---: |
| `view()` median | 45–47 ms | 8.7–8.8 ms |
| `view()` p90 | 48–51 ms | 10–12 ms |
| Snapshot size | 4.90 MB | 2.14 MB |
| Filter saved reviews by mutes | 1,461 ms | 0.1 ms |

"Before" is the same script at `83a4564`, with the saved-review index and preferences read from disk on every call, as `src/main.ts` did then. That commit had no trace, so the script's own timer measured it. With `--uncached`, the current code takes about 21 ms: the muted index and history lookup account for most of the gain, and the file caches for the rest.

The traced first rebuild takes about 40 ms. It parses the muted file and records the read baseline once. Later rebuilds print lines such as:

```text
[perf] view 9.3ms items=400 muted=649 history=512
```

## What changed

- The muted list is one frozen index per account. Checking a URL no longer clones 2.6 MB, and snapshots carry summary rows instead of full descriptions.
- Saved reviews are indexed by subject and URL once per history or mute change, instead of scanned once per subject.
- `preferences.json` and the saved-review index stay parsed until their size or modification time changes.
- Revisions of frozen inputs, such as the muted rows and the saved reviews, are hashed once.
- Read progress copies only the entries a change touches.

The remaining time is mostly briefing keys (one SHA-256 per subject) and item revisions. These were not measured separately.
