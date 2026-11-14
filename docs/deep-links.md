# Gnosis links (`gnosis://`)

A `gnosis://` link opens Gnosis at one place. Terminals, editors, scripts, Raycast or Alfred, and the browser extension (#310) can use it. A link can only navigate. It never writes to GitHub, starts a model, runs git, or reads a local path.

The grammar lives in `lib/deep-link.ts`, and the design is oddur/gnosis#309.

## What opens in this version

Phase 1 opens pull requests:

| Link | Opens |
| --- | --- |
| `gnosis://pr/<owner>/<repo>/<number>` | The PR summary. |
| `gnosis://pr/<owner>/<repo>/<number>/<tab>` | The PR on a tab: `summary`, `changes`, `commits`, `checks`, `feedback`, `explanation` or `notes`. |
| `gnosis://open?url=<GitHub page URL>` | The PR the page shows, on the matching tab. For example, `/pull/160/checks` opens Checks, and a `#discussion_r…` fragment opens Feedback. Encode the URL once with `encodeURIComponent`. |

Gnosis parses the other routes, but in this version it says "This link is not supported yet":

- `stack/…`;
- `conflicts/…`;
- `queue`;
- `review/<id>`;
- `settings[/<section>]`;
- `activity`;
- commit and compare pages.

When it can, it offers **Open on GitHub**. A link to a file, line, comment, commit, check or slide opens the right tab, with a note that it cannot jump further yet.

Examples:

```
gnosis://pr/oddur/gnosis/160/checks
gnosis://open?url=https%3A%2F%2Fgithub.com%2Foddur%2Fgnosis%2Fpull%2F160%2Ffiles
```

## Copying a link

- **Copy Gnosis link** in a PR's actions menu copies the link to that PR.
- **Copy Gnosis links** in the actions for a selection copies one link per line.
- **Copy Gnosis link to this view** in the command palette copies the link to the place the active tab shows.

Chat apps often do not make custom schemes clickable. Paste a link where it is run, for example in a terminal: `open 'gnosis://pr/oddur/gnosis/160'` on macOS.

## Rules

- **Strict syntax.** A link is refused if it has any of these:
  - more than 4096 characters;
  - more than 16 parameters;
  - a repeated parameter;
  - a known parameter with a bad value;
  - a control or bidi character;
  - an unknown route.

  Gnosis ignores unknown parameters, so newer links still open in older versions. A link with `v=2` or higher says it needs a newer version of Gnosis.
- **github.com only.** A `url=` must use `https` and the exact host `github.com`, with no user name and no port.
- **Lenient lookups.** If a file, thread or slide does not exist, Gnosis opens the PR or tab and says what was missing.
- **Errors never echo the link.** The main log records one line per link with the source, the route word and a result code, for example `[link] source=os route=pr result=accepted`. It never records the URL or its parameters.
- **Rate limit.** Gnosis accepts 5 links from outside at once, then one more every 2 seconds. It drops the rest and shows one "Ignored N links" message.
- **Signed out, muted, not found.** A PR link waits for you to connect GitHub. It opens if you connect within 10 minutes. A link to a muted PR offers **Show muted PRs**, and it never unmutes the PR. If GitHub cannot find the PR, or you do not have access, Gnosis offers **Open on GitHub**.
- **Links inside Gnosis.** A `gnosis://` link in a PR description or a comment opens in the app, under the same rules. It never goes through the OS.

## Registration and profiles

| Build | Scheme | Registration |
| --- | --- | --- |
| Packaged macOS | `gnosis` | `CFBundleURLTypes`, from `packagerConfig.protocols`. Gnosis also claims the scheme on each launch. |
| Packaged Windows | `gnosis` | `HKCU\Software\Classes\gnosis`, written on each launch, so it follows the current `app-<version>` folder. The Squirrel install and uninstall hooks are a follow-up. Until they ship, uninstalling leaves the key behind. |
| Linux | — | Not registered yet (Phase 2b). To register it by hand, run `xdg-mime default gnosis.desktop x-scheme-handler/gnosis`. |
| Development (`npm start`) | `gnosis-dev` | Never registered by default. |

Gnosis keeps one instance per profile, that is, per `userData` directory:

- **Packaged builds** always take this single-instance lock. A second launch on the same profile focuses the first window, passes its link to it, and exits.
- **Two profiles** each have their own lock. Instances started with different `--user-data-dir` values run side by side.
- **The OS starts Gnosis without `--user-data-dir`.** So links from the OS always open in the default profile.

In development:

- A link on the command line always works: `npm start -- -- "gnosis-dev://pr/oddur/gnosis/160"`.
- `GNOSIS_DEV_PROTOCOL=1` registers `gnosis-dev` with the OS and takes the lock. On macOS, this binds the shared `Electron.app`, so it works only while the dev app runs.
- `GNOSIS_SINGLE_INSTANCE=1` takes the lock without registering. The Electron smoke test uses it.
