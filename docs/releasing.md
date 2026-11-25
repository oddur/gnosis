# Releasing

A release starts when someone pushes a version tag. The Release workflow (`.github/workflows/release.yml`) builds macOS, Windows and Linux from that tag, signs and notarizes the macOS build, and publishes the files to a GitHub release. The version comes from the tag only. The committed `package.json` version stays `0.1.2`, and the workflow writes the tag's version into `package.json` before it builds.

Old commit messages have `+semver:` labels. Nothing reads them. The person who cuts a release chooses the version.

## Two kinds of tag

| Kind        | Tag                | Example          | GitHub release        | Who gets it                                  |
| ----------- | ------------------ | ---------------- | --------------------- | -------------------------------------------- |
| Stable      | `vX.Y.Z`           | `v0.42.0`        | Normal, marked latest | Everyone                                     |
| Pre-release | `vX.Y.Z-beta.N`    | `v0.42.0-beta.1` | Prerelease            | Only users on the **Pre-release** channel    |

- `X.Y.Z` in a pre-release tag is the stable version that the build leads to. `0.42.0-beta.1` comes before `0.42.0`.
- `N` starts at 1 and goes up by 1 for each new pre-release of the same version. It must be from 1 to 999, without leading zeros.
- Versions compare by semver precedence: `0.42.0-beta.2 < 0.42.0-beta.10 < 0.42.0 < 0.42.1-beta.1`.
- The workflow rejects every other tag. `v0.42.0-rc.1`, `v0.42.0-beta`, `v0.42.0-beta.01` and `v0.42.0-beta.1000` fail at **Validate release tag**.

`lib/version.ts` holds the same two patterns as the workflow. `tests/version.test.ts` fails if they differ.

## Cut a stable release

1. Make sure that the Checks run for the `main` commit is green. The Release workflow checks this too (see below).
2. Run `npm run test:perf` locally on a quiet machine, and note any budget over its limit. CI only reports timing budgets; see [Performance tests](continuous-integration.md#performance-tests).
3. Tag the commit and push the tag:

   ```sh
   git tag v0.42.0 <commit>
   git push origin v0.42.0
   ```

4. Write the release notes on the GitHub release. They cover everything since the previous stable release, not since the last pre-release.

The workflow also updates the Homebrew tap (`oddur/homebrew-gnosis`).

## Cut a pre-release from main

1. Make sure that the Checks run for the `main` commit is green. The Release workflow cancels Checks runs that are still in progress, because macOS runners are limited. The workflow's first job, **Commit passed Checks**, enforces this: it stops the release unless the tagged commit has a passing Checks run on `main`. The release itself runs no tests. If the commit's run was cancelled (a newer merge, or an earlier release freeing macOS runners, cancels it), re-run that run with `gh run rerun <id> --failed` and release once it passes. Use **skip_checks** on a manual run of the Release workflow only for a failure known to be a flaky test, and say why in the release notes.
2. Run `npm run test:perf` locally on a quiet machine, and note any budget over its limit.
3. Find the next number. List the pre-release tags for the version:

   ```sh
   git fetch --tags
   git tag --list 'v0.42.0-beta.*' --sort=-v:refname | head -1
   ```

   If there are none, use `beta.1`. If not, add 1 to the highest number.
4. Tag the `main` commit and push the tag:

   ```sh
   git tag v0.42.0-beta.1 origin/main
   git push origin v0.42.0-beta.1
   ```

5. When the workflow is done, check the release:
   - It is marked **Pre-release** on GitHub.
   - It has `Gnosis-darwin-arm64-update.json` next to the macOS ZIP.
   - It has `RELEASES` and `gnosis-0.42.0-beta1-full.nupkg` for Windows.
6. Write short notes: what changed since the previous pre-release, and what to test. GitHub's **Generate release notes** button, from the previous tag, is a good start. If the build changes saved data so that the current stable release cannot read it, say so in the notes.

The Homebrew tap is not updated for a pre-release.

## How the workflow keeps the two kinds apart

- **Validate release tag** sets `RELEASE_KIND` to `stable` or `prerelease` from the tag.
- `forge.config.ts` publishes a version with a prerelease part as a GitHub prerelease. It fails before anything is published if `GNOSIS_RELEASE_KIND` (set from `RELEASE_KIND`) disagrees with the version in `package.json`.
- **Check the release's prerelease flag** runs after each platform publishes. If the GitHub release's prerelease flag does not match the tag, the job fails. If a pre-release tag's release is not flagged, the step flags it first, so update.electronjs.org stops offering it to stable users.
- **Upload the macOS update manifest** runs for pre-releases only.
- **Update Homebrew tap** runs for stable releases only.

## How the app picks an update

Settings › Updates has an **Update channel** setting: Stable (the default) or Pre-release. `lib/updater.ts` and `src/update-checks.ts` have the details.

- **Stable** works as it always has. On macOS and Windows, Squirrel reads `https://update.electronjs.org/oddur/gnosis/<platform>-<arch>/<version>`. That service skips GitHub prereleases and drafts, and returns "no update" unless its newest stable release is newer than the running version. On Linux, the app reads GitHub's latest release, which is never a prerelease, and shows a download link.
- **Pre-release** lists the newest 30 GitHub releases and takes the highest version, of either kind. If that version is newer than the running version:
  - if it is a stable release, Squirrel reads update.electronjs.org, as on Stable;
  - on macOS, Squirrel reads the release's `Gnosis-darwin-<arch>-update.json`, which names the ZIP;
  - on Windows, Squirrel reads the release's download folder, `https://github.com/oddur/gnosis/releases/download/<tag>`, which holds `RELEASES` and the `.nupkg`;
  - on Linux, the banner links to the release.
- **Pre-release to Stable** never goes back to an older version. update.electronjs.org returns "no update" until a stable release is newer than the installed pre-release, and Squirrel.Windows does not install a package that is older than the installed one. Settings says so. An update that has already downloaded still installs when Gnosis quits.

## Windows version numbers

Squirrel.Windows uses NuGet versions, which cannot have dots in the prerelease part. electron-winstaller changes `0.42.0-beta.10` to `0.42.0-beta10`. Squirrel.Windows 2.0.1, which electron-winstaller 5 includes, compares `betaN` suffixes by their number, so `beta9 < beta10 < 0.42.0`. Squirrel.Windows also reports this NuGet version when an update has downloaded; the app changes it back to `0.42.0-beta.10` (`normalizeReleaseVersion` in `lib/version.ts`). `tests/version.test.ts` checks the order with electron-winstaller's own conversion.
