# Agent instructions

## Running tests

- Unit tests and type checks run on the host: `npm test`, `npx tsc --noEmit`, `npm run lint`.
- **Browser checks always run in Docker.** `test:explainer`, `test:workbench`, `test:diagrams`, `test:browser-smoke`, `test:electron-smoke` and any `node scripts/test-workbench.mjs --<check>` open real Electron windows that take focus away from the developer. On a dev machine these scripts refuse to start and print the Docker command to use instead.

```bash
npm run test:browser:docker -- --review-evidence        # one workbench check
npm run test:browser:docker -- npm run test:explainer   # any npm script or command
npm run test:browser:docker                             # full suite, as on Linux CI
```

- Run only the checks that cover your change. The full suite takes about 15 minutes.
- Never set `GNOSIS_BROWSER_ON_HOST=1` unless the user asks for a check on the host, such as the macOS-only `--navigation-swipe` check.
- If Docker isn't running, tell the user. Don't fall back to running the checks on the host.

**Browser checks wait for the screen to settle.** After an action, a check waits for a settled signal or for a condition the page reports, then reads layout or the DOM. Never read after a fixed sleep or a number of animation frames: a slow CI runner needs more of both, and the check fails at random. Wait on `waitSettled(contents, key)` from `tests/workbench-ready.ts` for a part that registers with `lib/test-settled.ts` (a virtualized list registers with `useVirtualizerSettled`), and add a key there when a check needs one. After `win.setSize`, wait until `innerWidth` shows the new size. Assert ordering on the order itself, such as the order the worker started its jobs in, never on milliseconds; report the milliseconds with `assertPerf`.

## Performance tests run locally only

- CI does not enforce timing budgets. When `CI` is set, every suite still runs its functional assertions, and timing assertions only log their value against the budget.
- After you change rendering, scrolling, sync, diff or queue code, run `npm run test:perf` on your own machine. Put its `[perf]` results in the PR description, and say which budgets went over.
- Use `assertPerf` or `withinPerf` from `tests/perf-budget.ts` for any new timing budget, never a plain `assert`. `npm run test:perf` finds the tests that use it by itself. A check that guards behaviour (order, a leak, a timeout) must not depend on the machine's speed: use mocked timers, or check order instead of milliseconds.
- See [Performance tests](docs/continuous-integration.md#performance-tests).

## Diff presentation

- Diff presentation is shared: Changes (PrFileInspection/ChangesDiff) and Explanation slides (SlideView/ReviewDiff) must render diffs through the same components; any change to diff presentation must land in both, and both must be checked in screenshots and tests.
- The shared pieces are `components/ChangesDiff.tsx`, `components/DiffFileHeader.tsx`, `components/useDiffFileModel.tsx` and `lib/diff-gaps.ts`. Topic-only features (inline explanations, review-check pins, the topic's hunk subset) ride on top through props and annotations. `--explanation-parity` checks that both surfaces render the same hunk headers and palette.
