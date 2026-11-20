# Continuous integration

The Checks workflow uses different browser coverage for pull requests and pushes to `main`.

| Check                                       | PR: Linux         | PR: macOS / Windows | Every push to `main`: all platforms |
| ------------------------------------------- | ----------------- | ------------------- | ----------------------------------- |
| TypeScript and unit tests                   | Full              | Full                | Full                                |
| Startup bundle                              | Yes               | No                  | Linux only                          |
| Electron integration smoke                  | Yes               | Yes                 | Yes                                 |
| Explainer, workbench, and D2 browser suites | Full, in 6 shards | Targeted smoke      | Full                                |
| Unsigned app and installers                 | Yes               | Yes                 | Yes                                 |

A new commit on a PR cancels that PR's obsolete Checks run. Each push to `main` gets a unique concurrency group: a later push does not cancel or replace an earlier full run. There are no path filters on the workflow.

## Smoke coverage

`npm run test:electron-smoke` starts Electron with a temporary profile and the production preload. It checks context isolation, real IPC calls, SQLite worker persistence across reopening, and native navigation events sent through the preload. The IPC handlers are test adapters; this does not launch an installed application or contact GitHub.

`npm run check:startup-bundle` builds the renderer and fails if the entry chunk, or a chunk it imports, contains `@pierre/diffs`, `shiki`, `react-markdown` or `@xyflow`. These load with the screens that use them. It also fails if the review page loads `@xyflow`, and prints the size of each lazy screen. See [Startup](startup.md).

`npm run test:browser-smoke` runs the explainer sandbox tests, review navigation tests, and command palette tests. These cover playback, isolation, mouse navigation, keyboard navigation, and search in Electron. PR checks on macOS also run the native swipe navigation case. The full suites include that case on `main`.

The existing `Check (ubuntu-latest)`, `Check (macos-latest)`, and `Check (windows-latest)` names remain stable for branch protection. Separate `Package (...)` jobs report installer-build failures without waiting for the browser suites.

## Browser shards

On Linux, six `Browser (shard n/6)` jobs run the full explainer, workbench and D2 browser suites in parallel. Run one after another, the suites take about 30 minutes. A shard takes about a sixth of that, and a failed shard can rerun alone.

`scripts/run-browser-suites.mjs` reads the suite list from the `test:explainer`, `test:workbench` and `test:diagrams` scripts in `package.json`, so a new suite needs no other change. It balances shards by the measured durations in `scripts/browser-suite-durations.json`. A suite without a measurement gets the median duration. Each shard runs all of its suites after a failure and lists every failed suite at the end.

`Check (ubuntu-latest)` runs `--verify 6`, which fails if a suite is missing from the shards or appears in more than one. Each shard uploads its measured durations as an artifact. Copy them into `scripts/browser-suite-durations.json` when shards drift out of balance.

```sh
node scripts/run-browser-suites.mjs --list --shard 2/6    # suites in one shard, with weights
npm run test:browser:docker -- node scripts/run-browser-suites.mjs --shard 2/6
```

## Performance tests

Performance tests run locally only. CI does not enforce timing or memory budgets. Shared runners are too noisy for them: the checks kept failing on runner load, not on regressions.

When `CI` is set (GitHub Actions sets `CI=true`):

- The perf-only browser suites, `--interaction-perf` and `--comment-typing`, do not run. They are listed only in `test:perf:browser`, so `scripts/run-browser-suites.mjs` leaves them out of the CI suite list and its shards.
- Other checks with a budget still run all their functional assertions. Their timing and memory assertions go through `assertPerf` and `withinPerf` in `tests/perf-budget.ts`. These log `[perf] <name>: <value> (budget <budget>)` and do not fail. On GitHub Actions, a value over its budget also shows as a warning annotation.

Run `npm run test:perf` on your own machine before a release, and after you change rendering, scrolling, sync, diff or queue code. Put the `[perf]` lines in the PR description.

```sh
npm run test:perf                  # unit timing tests on this machine, then the timed browser suites in Docker
npm run test:perf -- --unit        # only the unit timing tests
npm run test:perf -- --browser     # only the timed browser suites, in Docker
GNOSIS_PERF_STRICT=1 npm run test:perf
npm run test:browser:docker -- --diff-gaps            # one timed suite in Docker, budgets enforced
CI=true npm run test:browser:docker -- --diff-gaps    # the same, report-only, as on CI
```

`test:perf` covers:

- The unit tests in `npm test` that import `tests/perf-budget.ts`: main-process blocking during sync and discovery (`main-sync-blocking`), regrouping 4,000 PRs (`group-subjects`), `.gitattributes` matching (`file-kinds`), parse time of 3,000-line files (`syntax-scope`) and the Overview model of 1,000 PRs (`overview`). They run on the host.
- The browser suites in `test:perf:browser`: the perf-only suites above, and the CI suites with budgets (`--renderer-heap`, `--diff-gaps`, `--syntax-scope`, `--breadcrumb-nav`, `--feedback-inline`, `--instant-views`). On a dev machine they run in Docker, through `npm run test:browser:docker`. Set `GNOSIS_BROWSER_ON_HOST=1` to run them natively; they open windows. The budgets were calibrated in Docker.

`tests/browser-suite-registration.test.ts` fails if a browser suite that imports `tests/perf-budget.ts` is not in `test:perf:browser`.

| Variable                   | Effect                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GNOSIS_PERF`              | `1` enforces timing assertions, also with `CI` set. `0` makes them report-only. Without it, they are enforced unless `CI` is set. `test:perf` sets `1`. |
| `GNOSIS_PERF_STRICT`       | `1` enforces the budgets as written, with no scale factor.                                                                                              |
| `GNOSIS_PERF_BUDGET_SCALE` | The scale factor for budgets when not strict. The default is 1.6, which leaves room for a busy laptop or for Docker on a Mac.                           |

The Docker container does not set `CI`, so budgets are enforced there unless you pass `CI` or `GNOSIS_PERF=0`. `npm run test:browser:docker` passes these variables and `CI` into the container. Memory budgets (`--renderer-heap`) are in MB and are not scaled.

## Downloadable builds

Every run builds with `npm run make` and uploads `gnosis-unsigned-<OS>-<architecture>-<commit>` artifacts for seven days. Artifacts contain the platform's normal distributables: macOS ZIP/DMG, Windows Squirrel installer files, or Linux DEB/RPM. Linux packaging uses Ubuntu 24.04, matching the release workflow's RPM requirement.

These preview builds are unsigned and do not use signing, notarization, publishing, or GitHub OAuth secrets. OS security prompts can differ from released builds; GitHub's device login remains available. The workflow does not publish a release or update the Homebrew tap. Signing and publishing stay in the Release workflow.

## Releases

A pushed tag starts the Release workflow. `vX.Y.Z` publishes a stable release and `vX.Y.Z-beta.N` publishes a GitHub prerelease for the Pre-release update channel. See [Releasing](releasing.md).

## Local checks

```sh
npx tsc --noEmit
npm test
npm run check:startup-bundle
npm run test:electron-smoke
npm run test:browser-smoke
```

For full browser coverage, run `npm run test:explainer`, `npm run test:workbench`, and `npm run test:diagrams`. For timing and memory budgets, run `npm run test:perf` (see [Performance tests](#performance-tests)). On headless Linux, prefix each Electron test command with `xvfb-run -a` after configuring the Electron sandbox, as the workflow does.
