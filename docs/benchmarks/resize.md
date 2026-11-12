# Window resize benchmark

Resizing the window on a large, code-heavy Explanation took p50 66 ms and p90 155–168 ms per step. This page records how to measure it and how each change on `perf/smooth-resize` moved the numbers.

## Run it

Start your own instance with a copy of a profile. Never measure a profile that another app is using.

```bash
cp -Rc <profile> /tmp/gnosis-perf-resize
tail -f /dev/null | npm start -- -- --user-data-dir=/tmp/gnosis-perf-resize --remote-debugging-port=9344 \
  --disable-backgrounding-occluded-windows --disable-renderer-backgrounding
node scripts/measure-resize.mjs --port 9344 --reload --runs 3 --review <review id> \
  --from 2162 --height 945 --scroll section:10,section:9 --label after
```

The two Chromium switches keep a window that is behind other windows visible to the renderer. Without them an occluded window reports `visibilityState: hidden`, animation frames stop and the sweep never finishes.

`scripts/measure-resize.mjs`:

- opens the saved review through the renderer's command navigation, and with `--view` selects Changes or Summary;
- visits each `--scroll` place in order. A section visit first scrolls to the section's top so its lazy code mounts, then 4,000 px into it (`--into`). `section:10,section:9` mounts both large sections, as the user's page had them, and `section:10,section:9,top` measures at the top with both still mounted;
- emulates the window with `Emulation.setDeviceMetricsOverride`, from 2162 px down 600 px and back in 40 px steps (`--from`, `--delta`, `--step`), at height 945. Each step waits two animation frames;
- reads `Performance.getMetrics` after every step for layout and style-recalc counts, and prints the median of `--runs` runs. `--reload` reloads the renderer before each run, so every run starts from the same mount state. `--profile` adds the top self-time functions, and `--json` prints one object;
- always clears the emulation in `finally`.

## The page

The Explanation for klanggames/seed#34971, "chore: spike seed-api wallet layout", saved review `db736c2a-3b7c-4f7a-83a0-abf4363d4f46`. It has 10 sections. With sections 9 and 10 mounted, the page has about 19,900 light-DOM elements, 1,300 SVGs and 239 Pierre diff hosts. Section 9 is 57,533 px tall and section 10 is 46,212 px.

The other saved review for this PR, `711c7ba3-20a6-41f3-9b0f-0dc3e0ba5ac1`, is a shorter explanation with 6 small sections and about 2,800 elements. It does not reproduce the problem, so the table uses `db736c2a`.

## Results

Measured on 2026-11-12, Apple Silicon, macOS, Electron dev build. Each cell is the median of three reloaded runs of 32 steps. Times are per step; totals are over the whole sweep.

### Scrolled into section 9

| Step     |   p50 |    p90 |    max | Layout |  Style | Script | Layouts | Style recalcs |
| -------- | ----: | -----: | -----: | -----: | -----: | -----: | ------: | ------------: |
| Baseline | 72 ms | 143 ms | 283 ms | 671 ms | 434 ms |  92 ms |     160 |           190 |

### At the top, sections 9 and 10 mounted

| Step     |   p50 |    p90 |    max | Layout |  Style | Script | Layouts | Style recalcs |
| -------- | ----: | -----: | -----: | -----: | -----: | -----: | ------: | ------------: |
| Baseline | 76 ms | 141 ms | 233 ms | 654 ms | 422 ms | 142 ms |     168 |           196 |
