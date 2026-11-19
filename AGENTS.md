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

## Diff presentation

- Diff presentation is shared: Changes (PrFileInspection/ChangesDiff) and Explanation slides (SlideView/ReviewDiff) must render diffs through the same components; any change to diff presentation must land in both, and both must be checked in screenshots and tests.
- The shared pieces are `components/ChangesDiff.tsx`, `components/DiffFileHeader.tsx`, `components/useDiffFileModel.tsx` and `lib/diff-gaps.ts`. Topic-only features (inline explanations, review-check pins, the topic's hunk subset) ride on top through props and annotations. `--explanation-parity` checks that both surfaces render the same hunk headers and palette.
