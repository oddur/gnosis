# Agent instructions

## Running tests

**Agents run browser and performance tests in CI, not on the developer's machine.** These runs, in Docker or on the host, take over the machine: it can't be used while they run.

- **Locally, run only fast checks:**
  - `npx tsc --noEmit`;
  - `npm run lint` on the files you changed;
  - the unit test files you changed or that cover your change, for example `npx tsx --test tests/foo.test.ts`.

  Run each at most once per change. Don't run the whole `npm test` in a loop.
- **Don't run these locally,** unless the user asks for that run:
  - browser suites (`test:workbench`, `test:explainer`, `test:diagrams`, `test:browser-smoke`, `test:electron-smoke`, `node scripts/test-workbench.mjs --<check>`), in Docker (`npm run test:browser:docker`) or on the host;
  - `npm run test:native-local`;
  - `npm run test:perf`;
  - the conflict lab or resolver audit;
  - any repeated or looped run.
- **Open PRs as drafts, and mark them ready (`gh pr ready <n>`) only after review fixes are in.** A draft skips the macOS and Windows browser suites. Marking it ready starts a run with them. Merge only after that run's macOS and Windows browser jobs have passed: `main` has no required checks, so nothing else stops an early merge.
- **Push once per round:** batch the fixes from one review into a single push, and don't update a PR from `main` while its CI is running. Each push cancels the run in progress, and its runner time is lost.
- **Push the branch and let the PR's CI run them.** CI runs the Linux browser shards on every PR, and the macOS and Windows shards on any ready (non-draft) PR that changes more than docs ([list](docs/continuous-integration.md#native-browser-suites-on-pull-requests)). To reproduce a flaky failure, rerun the job or add diagnostics. Don't loop it locally.
- **Read failures from the job logs:** `gh api repos/oddur/gnosis/actions/jobs/<id>/logs` (`gh run view --log-failed` can come back empty).
- Never set `GNOSIS_BROWSER_ON_HOST=1`.

The commands below stay available for a developer who chooses to run a suite locally:

```bash
npm run test:browser:docker -- --review-evidence        # one workbench check, in Docker
npm run test:native-local -- --shard 1/4                # the suites of Browser (macos-latest 1/4), natively
```

**Browser checks wait for the screen to settle.** After an action, a check waits for a settled signal or for a condition the page reports, then reads layout or the DOM. Never read after a fixed sleep or a number of animation frames: a slow CI runner needs more of both, and the check fails at random. Wait on `waitSettled(contents, key)` from `tests/workbench-ready.ts` for a part that registers with `lib/test-settled.ts` (a virtualized list registers with `useVirtualizerSettled`), and add a key there when a check needs one. After `win.setSize`, wait until `innerWidth` shows the new size. Assert ordering on the order itself, such as the order the worker started its jobs in, never on milliseconds; report the milliseconds with `assertPerf`.

## Performance budgets

- CI does not enforce timing budgets. When `CI` is set, every suite still runs its functional assertions, and timing assertions only log their value against the budget as `[perf]` lines.
- After you change rendering, scrolling, sync, diff or queue code, copy the `[perf]` lines for the suites you touched from the PR's CI job logs into the PR description, and say which budgets went over. Don't run `npm run test:perf` locally unless the user asks.
- Use `assertPerf` or `withinPerf` from `tests/perf-budget.ts` for any new timing budget, never a plain `assert`. `npm run test:perf` finds the tests that use it by itself. A check that guards behaviour (order, a leak, a timeout) must not depend on the machine's speed: use mocked timers, or check order instead of milliseconds.
- See [Performance tests](docs/continuous-integration.md#performance-tests).

## Diff presentation

- Diff presentation is shared: Changes (PrFileInspection/ChangesDiff) and Explanation slides (SlideView/ReviewDiff) must render diffs through the same components; any change to diff presentation must land in both, and both must be checked in screenshots and tests.
- The shared pieces are `components/ChangesDiff.tsx`, `components/DiffFileHeader.tsx`, `components/useDiffFileModel.tsx` and `lib/diff-gaps.ts`. Topic-only features (inline explanations, review-check pins, the topic's hunk subset) ride on top through props and annotations. `--explanation-parity` checks that both surfaces render the same hunk headers and palette, and that the Conflicts view (`components/ConflictDiff.tsx`) does too.
