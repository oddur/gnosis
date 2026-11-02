# gnosis.to

Gnosis's marketing site uses Astro and Tailwind. Its opening uses a three-PR sample to explain why a missing `await` releases a concurrency slot too early. The example is curated sample data; it makes no GitHub or AI requests.

## Develop and verify

```sh
cd site
npm ci
npm run dev
npm run build
npm run test:browser
```

The browser check also requires the root repository's dependencies (`npm ci` at the repository root) for Electron. It serves the production build on a temporary loopback port, uses an isolated browser profile, and closes afterward. It checks PR selection, playback, keyboard input, clipboard success/failure, reduced motion, no-JavaScript content, narrow layouts, and axe WCAG A/AA rules. Captures go to `../.impeccable/review/site/`.

`npm run preview` serves the production build. `npm run format` formats the site source and browser checks.

## Content and design

- `src/components/StackDemo.astro` and `src/lib/demo.ts` define the sample stack and five comparison frames. `src/components/AwaitComparison.astro` shows the Before/After lanes. `src/scripts/stack-demo.ts` handles playback. Preserve command identity, coordinates, and the difference between active workers and slot ownership. PRs #120 and #122 provide static foundation/test context; #121 holds the interactive diff.
- `src/components/FeatureTour.astro` contains the six-workflow product tour. `src/scripts/feature-tour.ts` adds keyboard-accessible tabs; without scripts, each feature is a linked section. Keep the selected panel at a stable desktop height and show full screenshots without cropping.
- `src/lib/releases.ts` fetches releases once during the build. The changelog and download links use the same result. Set `GITHUB_TOKEN` for authenticated builds. If GitHub is unavailable, the site links to releases instead.
- Fonts are served locally as WOFF2 subsets. The English page loads only Latin and common UI symbols; extended characters load on demand. Source, verification, and regeneration instructions are in `fonts/README.md`. Onest’s license is in `public/fonts/`.
- `DESIGN.md` and `.impeccable/design.json` describe the website system. The root design documents describe the desktop app.
- App screenshots use synthetic test fixtures, not private repositories. Their `.webp.json` sidecars record source and conversion details. The screenshots were captured at commit `7d81c79` with `tests/workbench-browser.ts` (`queue-light` and `review-light`), then resized to 1600 and 960 pixels with WebP quality 86. Regenerate with `GNOSIS_SCREENSHOT_DIR=<directory> node scripts/test-workbench.mjs` at the repository root.

## Deployment

`.github/workflows/site.yml` builds and deploys to GitHub Pages when `site/**` changes on `main`, when a release is published, or on manual dispatch. `public/CNAME` preserves `gnosis.to`. The build fetches release notes; visitors do not call the GitHub API.

The feature tour adds captures from `--stack-hierarchy`, `--changes`, `--markdown-review`, and `--checks`, and `--conflict-resolution` runs of `scripts/test-workbench.mjs`. Chat uses `chat-reading-light` from the default run. Each asset sidecar identifies its exact source capture. Browser checks cover every feature panel, keyboard selection, deep links, no-JavaScript fallbacks, responsive layout, and accessibility.

The browser check also executes both JavaScript variants with deferred worker promises and a one-slot semaphore. It verifies that missing `await` permits two active workers while both versions return the same results. It checks every comparison step, reverse navigation, replay, cancellation, text counts, peak concurrency, and reduced motion.

## Performance measurements

After building, run `GNOSIS_PERF_OUTPUT=/tmp/gnosis-site-performance.json npm run test:performance`. The runner uses cold caches, gzip text responses, three desktop runs, and three mobile-viewport runs with 1.6 Mbps down / 750 Kbps up / 150 ms latency / 4× CPU slowdown. It records startup paint/layout observations, actual pointer-interaction timing, and requested resources before and after scrolling to the feature tour. Analytics requests are blocked. These are local lab measurements, not field Core Web Vitals or measurements on a physical phone. See `../docs/audits/website-performance-2026-11-02.md` for the comparison.
