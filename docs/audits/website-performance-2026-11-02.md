# Website performance pass — 2026-11-02

The initial font download was the main avoidable cost. Replace the preloaded TrueType file with WOFF2 subsets. Keep the page design, interactions, image loading, and feature content unchanged.

## Results

Three cold-cache runs per profile, before and after. Values below are medians unless stated otherwise. Byte counts are compressed response bodies, not HTTP headers.

| Measure | Before | After |
| --- | ---: | ---: |
| Initial font download | 108,245 B (gzip TTF) | 39,464 B (WOFF2) |
| Initial mobile transfer | 125,630 B | 57,447 B |
| Initial desktop transfer | 238,310 B | 170,127 B |
| Mobile font request duration | 736.5 ms | 390.1 ms |
| Mobile first contentful paint | 544 ms | 536 ms |
| Mobile largest contentful paint | 544 ms | 536 ms |
| Mobile startup layout-shift sum | 0.0376 | 0.0376 |
| Desktop largest contentful paint | 56 ms | 52 ms |
| Largest sampled mobile interaction duration | 32 ms | 32 ms |
| Largest sampled desktop interaction duration | 40 ms | 40 ms |

Initial mobile transfer fell **54%**. The critical font response is **64% smaller**, and its duration fell **47%** on the simulated connection. Paint and interaction changes are too small to claim a meaningful speed improvement. Layout stability was unchanged.

The uncompressed original TTF was 193,056 bytes. The comparison above uses its measured gzip size, since comparing uncompressed TTF with WOFF2 would overstate the network saving.

## What changed

- Preload a 39,464-byte variable WOFF2 subset for Latin and common UI symbols.
- Load extended Latin and Cyrillic from a separate 52,664-byte WOFF2 file only when needed.
- Preserve all 780 Unicode mappings, original horizontal metrics, and the 100–900 weight axis. Keep the original font and its license for regeneration.
- Add a repeatable performance runner and font generation checks.

The existing behavior was already appropriate elsewhere: the initial mobile viewport requested no product screenshots; scrolling to the feature tour fetched the queue, guided-review, and selected stack images. Hidden feature images stayed unloaded. Interaction timing did not identify a JavaScript bottleneck. No additional animation, rendering, or image pipeline changes were justified by this measurement.

## Method and limits

`npm run build --prefix site`, then:

```sh
GNOSIS_PERF_OUTPUT=/tmp/gnosis-site-performance.json npm run test:performance --prefix site
```

The runner serves the production build locally with gzip text responses. It uses Chromium 146.0.7680.188 in Electron on macOS, cold caches, and three runs each at 1280×800 and 390×844. The mobile profile applies 1.6 Mbps download, 750 Kbps upload, 150 ms latency, and 4× CPU slowdown. It observes the page for 3.5 seconds after load, sends real pointer input through all four Next steps, then scrolls to the feature tour. Analytics requests are blocked.

These are local lab observations, not field Core Web Vitals, a Lighthouse score, or a physical-phone benchmark. The reported layout-shift sum covers startup. Sampled Event Timing durations are quantized; values below 16 ms are not reported. The mobile viewport's device scale comes from the host Electron window. Network connection setup and the production CDN are not measured.

Raw results: [before](website-performance-2026-11-02/before.json), [after](website-performance-2026-11-02/after.json). Baseline source: `cd58f39`.

## Verification

- Astro check and production build passed.
- Browser interactions, keyboard behavior, no-JavaScript content, reduced motion, and 320–1440 px layout checks passed.
- axe WCAG A/AA checks passed.
- Browser resource checks verify the English page does not fetch the extended subset, then verify that requesting `Český Привет` loads it.
- The generated fonts retain every original Unicode mapping and horizontal metric; the generator also verifies the variable weight axis.
- The 2880×1800 hero capture is pixel-identical before and after (5,184,000 pixels). Mobile page dimensions remain identical; pixel differences are confined to embedded product screenshot regions, not the site's text or layout.
