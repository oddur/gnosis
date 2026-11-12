# Window resize benchmark

Resizing the window on a large, code-heavy Explanation took p50 66 ms and p90 155–168 ms per step. Every step now does its work within one frame: about 9 ms of main-thread work at p50 and 12 ms at p90, against 16.7 ms per frame at 60 Hz. This page records how to measure it and how each change on `perf/smooth-resize` moved the numbers.

## Run it

Start your own instance with a copy of a profile. Never measure a profile that another app is using.

```bash
cp -Rc <profile> /tmp/gnosis-perf-resize
tail -f /dev/null | npm start -- -- --user-data-dir=/tmp/gnosis-perf-resize --remote-debugging-port=9344 \
  --disable-backgrounding-occluded-windows --disable-renderer-backgrounding
node scripts/measure-resize.mjs --port 9344 --reload --runs 3 --review <review id> \
  --from 2162 --height 945 --scroll section:10,section:9 --settle 6000 --label after
node scripts/measure-resize.mjs --port 9344 --reload --runs 3 --pr <PR URL> --view changes \
  --from 2162 --height 945 --scroll px:3000 --settle 8000 --label changes
```

The two Chromium switches keep a window that is behind other windows visible to the renderer. Without them an occluded window reports `visibilityState: hidden`, animation frames stop and the sweep never finishes.

`scripts/measure-resize.mjs`:

- opens a saved review (`--review`) or a PR page (`--pr`) through the renderer's command navigation, and with `--view` selects the Summary or Changes tab;
- visits each `--scroll` place in order. A section visit first scrolls to the section's top so its lazy code mounts, then 4,000 px into it (`--into`). `section:10,section:9` mounts both large sections, as the user's page had them, and `section:10,section:9,top` measures at the top with both still mounted. `px:<n>` scrolls the largest scroll container;
- collects garbage before the sweep, so the major GC that follows a reload does not land inside it;
- emulates the window with `Emulation.setDeviceMetricsOverride`, from 2162 px down 600 px and back in 40 px steps (`--from`, `--delta`, `--step`), at height 945. Each step waits two animation frames;
- reads `Performance.getMetrics` after every step for layout and style-recalc counts and main-thread work, and prints the median of `--runs` runs. `--reload` reloads the renderer before each run, so every run starts from the same mount state. `--profile` adds the top self-time functions, `--steps` prints every step, `--count-renders` reports the app's render counters, and `--json` prints one object;
- always clears the emulation in `finally`.

### Reading the numbers

The step time waits two animation frames after each emulated resize, so it has a floor of one to two frame intervals: about 17–33 ms at 60 Hz. A step that reads 33 ms has finished its work within a frame; 50 ms or more means it dropped at least one frame. Work is the main thread's busy time per step (`TaskDuration`), the number to hold against the 16.7 ms frame budget. Totals are over the whole 32-step sweep.

The app stays live while it is measured: it syncs with GitHub and runs timers. About one run in five had a single step with 450–530 ms of unrelated script, and render counting showed no app render during clean sweeps. Medians of three runs keep such a run out of p50 and p90, and rows were measured again when two runs were hit.

## The pages

**Explanation.** klanggames/seed#34971, "chore: spike seed-api wallet layout", saved review `db736c2a-3b7c-4f7a-83a0-abf4363d4f46`. It has 10 sections. With sections 9 and 10 mounted, the page had about 19,900 light-DOM elements, 1,300 SVGs and 239 Pierre diff hosts. Section 9 was 57,533 px tall, mostly Markdown previews, and section 10 was 46,212 px of diffs. The other saved review for this PR, `711c7ba3-20a6-41f3-9b0f-0dc3e0ba5ac1`, is a shorter explanation with 6 small sections and about 2,800 elements. It does not reproduce the problem, so the tables use `db736c2a`.

**Changes.** klanggames/seed#35701, "feat: add Harvest & Hearth content and food/farming balance tools": 710 files and about 60,000 changed lines, 3,000 px into the stream.

**PR summary.** klanggames/seed#36074, whose description is 52 KB, 2,000 px into the page.

## Results

Measured on 2026-11-12 on Apple Silicon, macOS, with an Electron dev build. Each row is the median of three reloaded runs of 32 steps. Step numbers follow the design; Step 3 (virtualization) was not needed. "Baseline (work)" re-measured the base code later with the current harness, to add the work columns.

### Explanation, scrolled into section 9

| Step            | Step p50 |    p90 |    max | Work p50 |      p90 |      max | Layout |  Style | Script | Layouts | Style recalcs |  SVGs |
| --------------- | -------: | -----: | -----: | -------: | -------: | -------: | -----: | -----: | -----: | ------: | ------------: | ----: |
| Baseline        |    72 ms | 143 ms | 283 ms |        – |        – |        – | 671 ms | 434 ms |  92 ms |     160 |           190 | 1,299 |
| Baseline (work) |    68 ms | 148 ms | 276 ms |  59.8 ms | 155.5 ms | 274.9 ms | 668 ms | 417 ms | 109 ms |     160 |           190 | 1,278 |
| 1               |    66 ms | 113 ms | 183 ms |        – |        – |        – | 596 ms | 193 ms |  34 ms |     118 |           144 | 1,287 |
| 2               |    33 ms |  33 ms |  34 ms |   9.0 ms |  11.7 ms |  17.4 ms |  18 ms | 134 ms |   2 ms |      68 |            68 | 1,178 |
| 4               |    33 ms |  33 ms |  34 ms |   9.0 ms |  11.8 ms |  15.9 ms |  17 ms | 132 ms |   2 ms |      68 |            68 |   308 |
| 5               |    33 ms |  33 ms |  39 ms |   8.9 ms |  11.8 ms |  17.0 ms |  17 ms | 138 ms |   2 ms |      68 |            69 |   308 |
| 6               |    32 ms |  33 ms |  33 ms |   9.0 ms |  12.1 ms |  15.1 ms |  18 ms | 129 ms |   2 ms |      68 |            68 |   292 |

### Explanation, at the top with sections 9 and 10 mounted

| Step            | Step p50 |    p90 |    max | Work p50 |      p90 |      max | Layout |  Style | Script | Layouts | Style recalcs |  SVGs |
| --------------- | -------: | -----: | -----: | -------: | -------: | -------: | -----: | -----: | -----: | ------: | ------------: | ----: |
| Baseline        |    76 ms | 141 ms | 233 ms |        – |        – |        – | 654 ms | 422 ms | 142 ms |     168 |           196 | 1,298 |
| Baseline (work) |    77 ms | 134 ms | 262 ms |  81.9 ms | 127.0 ms | 249.1 ms | 666 ms | 416 ms | 113 ms |     168 |           197 | 1,298 |
| 1               |    60 ms | 114 ms | 545 ms |        – |        – |        – | 597 ms | 194 ms |  10 ms |     118 |           122 | 1,287 |
| 2               |    33 ms |  33 ms |  35 ms |   9.2 ms |  10.5 ms |  17.3 ms |  15 ms | 153 ms |   2 ms |      62 |            62 | 1,199 |
| 4               |    33 ms |  33 ms |  35 ms |   9.1 ms |  10.3 ms |  25.2 ms |  14 ms | 142 ms |   2 ms |      62 |            62 |   308 |
| 5               |    33 ms |  33 ms |  43 ms |   9.2 ms |  10.5 ms |  20.4 ms |  14 ms | 147 ms |   2 ms |      62 |            62 |   309 |
| 6               |    33 ms |  33 ms |  34 ms |   8.6 ms |   9.8 ms |  12.7 ms |  14 ms | 128 ms |   2 ms |      62 |            62 |   309 |

### Changes and PR summary

| Page                      | Step p50 |   p90 |   max | Work p50 |     p90 |      max | Layout | Style | Script | Layouts | Style recalcs | SVGs |
| ------------------------- | -------: | ----: | ----: | -------: | ------: | -------: | -----: | ----: | -----: | ------: | ------------: | ---: |
| Changes, before Step 7    |    33 ms | 46 ms | 60 ms |   7.5 ms | 52.6 ms | 106.4 ms | 125 ms | 26 ms | 123 ms |      64 |            66 |  234 |
| Changes, Step 7           |    33 ms | 33 ms | 34 ms |   7.5 ms | 11.1 ms |  23.3 ms |  71 ms | 24 ms |   7 ms |      64 |            64 |  234 |
| PR summary, before Step 7 |    32 ms | 33 ms | 34 ms |   3.5 ms |  5.0 ms |   8.4 ms |  17 ms | 13 ms |   3 ms |      60 |            60 |  204 |
| PR summary, Step 7        |    33 ms | 33 ms | 33 ms |   3.4 ms |  5.2 ms |   7.0 ms |  17 ms | 14 ms |   3 ms |      60 |            60 |  203 |

"Before Step 7" already includes Step 1's change to the Changes header observer. Turning off the Changes virtualizer's `useFlushSync` measured the same as leaving it on (work p90 11.4–11.9 ms against 11.1 ms), so it stays on.

## What changed

1. **One layout pass for sticky columns.** Each section had its own ResizeObserver that read `offsetHeight` after the previous section wrote, and wrote `--column-top`, an inherited custom property that restyled the whole column. One controller in `lib/explanation-column-layout.ts` now records sizes from observer entries and writes `style.top` once per frame, only where the value changes. Other observers take sizes from their entries instead of reading layout. Style time halved and script fell from 92 to 34 ms, but layout time barely moved: it was real layout of 20,000 elements, not forced reads.
2. **`content-visibility: auto`.** Sections, file groups, Pierre diff hosts and Markdown preview blocks outside the viewport skip style, layout and paint. Visible ranges over 300 lines render as 200-line slices. Estimated heights hold each chunk's place, and the reading position saves an anchor so that estimates cannot move it. This brought layout from about 600 ms to 18 ms per sweep and every step under one frame.
3. **No virtualization.** After Step 2 no step needed it.
4. **Mask icons.** Repeated control and badge glyphs are CSS masks instead of SVG subtrees: 1,178 SVGs became 308 and the page lost about 2,300 elements. Resize work did not change, as expected after Step 2.
5. **Settled diagram fitting.** Diagrams keep their size while the window is dragged and fit again 120 ms after the resize settles. The measured pages have no diagram in view, so their numbers did not change.
6. **CSS audit.** The sticky file header's z-index drops from 20 to 5. `.pr-summary-content` keeps size containment, which `100cqh` needs. No measurable change.
7. **Other views.** On Changes, the virtualizer re-measured rows on every step and re-rendered each mounted file, which gave Pierre new options and made it rewrite every mounted diff. Rows are now memoized. The PR summary was already within budget; its Markdown blocks get `content-visibility` too.

Profiling the browser check also found that crossing the 1000 px media query re-rendered every Explanation section and its diffs, about 450 ms in one step. Only the side-by-side layout listens to it now.

## Browser check

`node scripts/test-workbench.mjs --resize` (`tests/resize-performance-browser.ts`, part of `npm run test:workbench`) builds a synthetic Explanation: 10 topics, two with 150 files each, a 3,000-line added file and about 330 entity badges. It sweeps 32 steps through `webContents.debugger` from an emulated 1680 px, which stays clear of the 1000 px and 850 px breakpoints, and asserts:

- at most 3 layouts and 4 style recalcs per step;
- fewer than 4,000 rendered elements outside skipped subtrees;
- main-thread work p90 under 50 ms, and step p90 under 100 ms. Under Xvfb's software rasterizer a frame takes longer than 16 ms to present, so the two-frame step time sits near 50 ms there whatever the main thread does;
- no Explanation section renders when the window crosses 1000 px;
- the tall narrative is pinned by its bottom, and the tallest column has no inline offset;
- find-in-page reaches a skipped topic and a line inside a skipped slice of the large file;
- a deep link to line 2600 of the large file lands on that line;
- the reading position survives leaving the tab;
- icon buttons draw masks, keep their names and take focus.
