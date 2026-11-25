# Continuous integration

The Checks workflow uses different browser coverage for pull requests and pushes to `main`.

| Check                                       | PR: Linux         | PR: macOS / Windows                         | Every push to `main`: all platforms |
| ------------------------------------------- | ----------------- | ------------------------------------------- | ----------------------------------- |
| TypeScript and unit tests                   | Full              | Full (Windows unit tests in 2 shards)       | Full                                |
| Startup bundle                              | Yes               | No                                          | Linux only                          |
| Electron integration smoke                  | Yes               | Yes                                         | Yes                                 |
| Explainer, workbench, and D2 browser suites | Full, in 6 shards | Full (4 / 5 shards) unless only docs change | Full                                |
| Unsigned app and installers                 | Yes               | Yes                                         | Yes                                 |

A new commit on a PR cancels that PR's obsolete Checks run. Each push to `main` gets a unique concurrency group: a later push does not cancel or replace an earlier full run. There are no path filters on the workflow.

## Native browser suites on pull requests

The `Native suites needed` job decides whether a run gets the full macOS and Windows browser suites (`Browser (macos-latest n/4)` and `Browser (windows-latest n/5)`). They run on every push to `main`, and on every pull request unless each file it changes is on a short list known not to affect them:

- `docs/`, `site/` and `.github/ISSUE_TEMPLATE/`
- Markdown files, except under `tests/`, `src/`, `lib/`, `components/`, `scripts/`, `resources/` and `extensions/` (there Markdown can be test data, as in `tests/fixtures/conflicts`)
- license files: `LICENSE`, `COPYING`, `NOTICE`, with or without an extension

**Draft pull requests run the Linux suites only.** Iterating on a PR, with review fixes and updates from `main`, pushes again and again, and each push cancels the run before it. On 2026-11-25, 57% of runner time went to runs that were later cancelled. Marking the PR ready for review starts a full run with the macOS and Windows suites (the `ready_for_review` trigger), so they still run once before a merge. The `native-ci` label runs them on a draft too.

Any other path runs them, so a new kind of file is covered without a change here. If the job cannot read the PR's labels or files, or fails, the suites run too. To run them on a docs-only PR, add the `native-ci` label and re-run all jobs: the job reads the labels when it runs, not from the event.

On docs-only PRs the native jobs show as skipped, and Check runs the browser smoke suite. `main` has no required status checks (the `protect-main` ruleset requires a pull request, and blocks deletion and force pushes), so a skipped job does not block a merge. If a native job becomes required, a skipped job counts as passed.

The PR's own CI runs these suites, so you don't need to run them locally. These runs take over the machine. If you choose to run them on your own Mac or Windows machine:

```sh
npm run test:native-local -- --list --shard 1/4   # the suites of Browser (macos-latest 1/4)
npm run test:native-local -- --shard 1/4          # run them, natively
```

It uses the CI shards for this platform, opens the test windows no larger than the runner's work area on macOS (1024x677, `GNOSIS_TEST_WORK_AREA`), keeps timing budgets report-only as on CI, and ends with a summary of every suite. The windows take focus. A suite that also fails on an untouched `main` checkout here is a host difference: say so in the PR.

## Smoke coverage

`npm run test:electron-smoke` starts Electron with a temporary profile and the production preload. It checks context isolation, real IPC calls, SQLite worker persistence across reopening, and native navigation events sent through the preload. The IPC handlers are test adapters; this does not launch an installed application or contact GitHub.

`npm run check:startup-bundle` builds the renderer and fails if the entry chunk, or a chunk it imports, contains `@pierre/diffs`, `@pierre/words`, `shiki`, `react-markdown` or `@xyflow`. These load with the screens that use them. It also fails if the review page loads `@xyflow`, and prints the size of each lazy screen. See [Startup](startup.md).

`npm run test:browser-smoke` runs the explainer sandbox tests, review navigation tests, and command palette tests. These cover playback, isolation, mouse navigation, keyboard navigation, and search in Electron. PR checks on macOS also run the native swipe navigation case. The full suites include that case on `main`.

The existing `Check (ubuntu-latest)`, `Check (macos-latest)`, and `Check (windows-latest)` names remain stable for branch protection. Separate `Package (...)` jobs report installer-build failures without waiting for the browser suites.

## Browser shards

On Linux, six `Browser (shard n/6)` jobs run the full explainer, workbench and D2 browser suites in parallel. Run one after another, the suites take about 30 minutes. A shard takes about a sixth of that, and a failed shard can rerun alone.

`scripts/run-browser-suites.mjs` reads the suite list from the `test:explainer`, `test:workbench` and `test:diagrams` scripts in `package.json`, so a new suite needs no other change. It balances shards by the measured durations in `scripts/browser-suite-durations.json`. A suite without a measurement gets the median duration. Each shard runs all of its suites after a failure and lists every failed suite at the end.

The macOS and Windows jobs balance with their own measurements, `scripts/browser-suite-durations-macos.json` and `scripts/browser-suite-durations-windows.json` (`--weights`). A suite's share of the time differs a lot between the platforms. These files were seeded with the median of each suite's `✔ name (Ns)` lines in the native job logs of five `main` runs on 2026-11-23 and 2026-11-24.

`Check (ubuntu-latest)` runs `--verify` for the Linux, macOS and Windows shards, which fails if a suite is missing from the shards or appears in more than one. Each Linux and native shard uploads its measured durations as an artifact (`browser-suite-durations-<n>`, `browser-suite-durations-<platform>-<n>`). Copy them into the matching file when shards drift out of balance. If you change the number of native shards, change `NATIVE_SHARDS` in `scripts/run-browser-suites.mjs` too; `tests/unit-shards.test.ts` checks that they match.

## Windows unit tests

On Windows, `npm test` runs in two `Unit tests (windows-latest n/2)` jobs instead of in `Check (windows-latest)`. Spawning git is several times slower there, and the conflict-resolution tests, which run twice (full history and shallow), took about 16 minutes in one file. `scripts/run-unit-tests.mjs --shard i/n` gives each job a share of the files. A file that takes `test` from `tests/support/test-part.ts` runs in every job, in a separate `tsx --test` process that alone gets `GNOSIS_TEST_PART`, and each job runs every n-th of its tests. Every other file runs in a process without that variable, so it always runs in full. In a split file, `test.only`, `it`, `describe` and `suite` throw: they would register outside the part count. Use it for any other unit test file that grows that long.

```sh
node scripts/run-browser-suites.mjs --list --shard 2/6    # suites in one shard, with weights
npm run test:browser:docker -- node scripts/run-browser-suites.mjs --shard 2/6
```

## Performance tests

Performance tests run locally only. CI does not enforce timing budgets. Shared runners are too noisy for them: the checks kept failing on runner load, not on regressions.

When `CI` is set (GitHub Actions sets `CI=true`), every browser suite and unit test still runs, with all its functional assertions. Only the timing budgets change: they go through `assertPerf` and `withinPerf` in `tests/perf-budget.ts`, which log `[perf] <name>: <value> (budget <budget>)` and do not fail. On GitHub Actions, a value over its budget also shows as a warning annotation. A measurement that is not a number fails in every mode.

Some checks that use time stay enforced on CI, because they check behaviour, not speed:

- Scheduling (`--syntax-scope`): the file in view, and the file the reader jumps to, wait less than 400 ms for the syntax worker, where waiting behind prefetch takes seconds; and parsing runs in the worker, not on the page.
- Heap growth after a forced garbage collection (`--renderer-heap`): that is about leaks, not load.
- Instant views (`--instant-views`): a prepared PR or the saved queue shows well before the fixture's slow network or slow start would answer.
- Timeouts with wide margins: an interactive read stops waiting for a 1 s fetch (`local-clone`), and a status read waits for a stuck preload for about 250 ms (`pr-status`). Quit flushing (`quit-flush`) uses mocked timers.

After you change rendering, scrolling, sync, diff or queue code, put the `[perf]` lines from the PR's CI job logs in the PR description. CI logs every budget but doesn't enforce them. `npm run test:perf` enforces them locally and takes over the machine while it runs, so run it only when you choose to, for example before a release.

```sh
npm run test:perf                  # unit timing tests on this machine, then the timed browser suites in Docker
npm run test:perf -- --unit        # only the unit timing tests
npm run test:perf -- --browser     # only the timed browser suites, in Docker
GNOSIS_PERF_STRICT=1 npm run test:perf
npm run test:browser:docker -- --diff-gaps            # one timed suite in Docker, budgets enforced
CI=true npm run test:browser:docker -- --diff-gaps    # the same, report-only, as on CI
```

`test:perf` finds its tests from the files that use `tests/perf-budget.ts` (an import, a re-export, or a local helper that does):

- The unit tests in `npm test` that use it, such as main-process blocking during sync and discovery (`main-sync-blocking`) and regrouping 4,000 PRs (`group-subjects`). They run on the host, one file at a time.
- The CI browser suites that use it: `npm run test:perf:browser` runs them, and `node scripts/run-browser-suites.mjs --list --perf` lists them. They include `--interaction-perf`, `--comment-typing`, `--diff-gaps`, `--syntax-scope` and `--breadcrumb-nav`. On a dev machine they run in Docker, through `npm run test:browser:docker`. Set `GNOSIS_BROWSER_ON_HOST=1` to run them natively; they open windows. The budgets were calibrated in Docker.

| Variable                   | Effect                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GNOSIS_PERF`              | `1` enforces timing assertions, also with `CI` set. `0` makes them report-only. Without it, they are enforced unless `CI` is set. `test:perf` sets `1`. |
| `GNOSIS_PERF_STRICT`       | `1` enforces the budgets as written, with no scale factor.                                                                                              |
| `GNOSIS_PERF_BUDGET_SCALE` | The scale factor for budgets when not strict: a number above 0. The default is 1.6, which leaves room for a busy laptop or for Docker on a Mac.         |

`CI=0` and `CI=false` count as not set. The Docker container does not set `CI`, so budgets are enforced there unless you pass `CI` or `GNOSIS_PERF=0`. `npm run test:browser:docker` passes these variables, `CI`, and the suites' own tuning variables (`GNOSIS_INTERACTION_CPU_SLOWDOWN`, `GNOSIS_TYPING_CPU_SLOWDOWN`, `GNOSIS_LONG_TASK_BUDGET`, `GNOSIS_INTERACTION_ONLY`, `GNOSIS_INTERACTION_PROFILE`) into the container.

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
