# Reduce noise eval

This folder holds the eval set for the explanation setting "Reduce noise" (`lib/explanation-noise.ts`). Each fixture is a small synthetic PR: a title, a description, and files with their old and new text. Every hunk of the diff has a hand label.

The fixtures reproduce the shapes of hunks found in merged PRs of oddur/gnosis and the private backtrack repository. No code is copied from those PRs. The identifiers are invented, and each case names the PR pattern it comes from.

## Labels

- `essential`: a reviewer must see this hunk explained. An essential hunk is cut **never** at Conservative. At Aggressive it is cut never when it changes behavior. A hunk marked `"behavior": false` (a test or docs text) is reported if it is cut at Aggressive, but it does not fail the run.
- `noise`: the explanation leaves this hunk out at both levels. Changes still shows it.
- `aggressive-only`: the explanation keeps this hunk at Conservative and leaves it out at Aggressive. Examples are a small related helper edit, and an import of a package the file did not import before (a new dependency).

## Files

- `cases/<id>.json`: one fixture. `files[].before` and `files[].after` are the file's lines; `null` means that the file is added or deleted. `files[].hunks` has one label per hunk, in order. The runner makes the diff with 3 lines of context, as GitHub does. It stops if the number of labels is not the same as the number of hunks.
- `recorded/<level>/<id>.json`: the planner's answer for a fixture at Conservative or Aggressive, with the provider and model that gave it, written by `--live`. Each answer is written together with its manifest entry.
- `recorded/manifest.json`: one entry for each fixture. An entry has the provider, the model ID, the effort and a hash of the fixture. For each level, it also has the prompt hash, the options, and an evidence hash. The evidence hash covers the planner context, the evidence and the set of hunks the rules cut. `--live --only <id>` replaces only that fixture's entry.
- Replay fails when a recording is stale. A recording is stale when its fixture, the prompt or the planner's input changed after the recording, when the manifest has no entry for it, or when its provider or model differs from its entry. Replay also fails when there are recordings but no manifest, when an entry has no recording, and when the manifest mixes providers or models.

## Running

```bash
npm run explanation-noise-eval                    # replay: free and reproducible, also a unit test
npm run explanation-noise-eval -- --live          # prints the planner calls and their estimated cost, then stops
npm run explanation-noise-eval -- --live --yes    # calls the real planner and records its answers
```

Replay runs layer 1 (the rules) on every fixture at both levels. Then it applies the recorded planner answers (layer 2) with the same routing as generation (`applyNoise`). If no answers are recorded, it reports layer 2 as "not recorded, run --live". `--live` takes `--provider claude|codex`, `--model <id>`, `--effort <level>` and `--only <fixture id>`. Each live run costs money, so run it only when the user approves the cost.

Scoring for each level and layer:

- **noise recall**: the share of hunks that should be cut and were cut.
- **essential precision**: the share of cuts that were correct.
- **wrong cuts**: each one with its fixture, its hunk, the layer that cut it, and the reason. A cut essential hunk is a failure, and the runner exits with 1.

The planner can cut only a hunk whose whole source was in its evidence. If the rules and the planner together would cut every hunk, nothing is cut.

## Cases

### comment-only

Remove stale lock files before opening the store. Opening the store removes a lock file left by a crashed process.

Source pattern: backtrack #6 and #16: safety comments added above unchanged code, beside the real fix.

| Hunk | File | Label | Why |
| --- | --- | --- | --- |
| hunk-0 | `src/store.rs` | noise | Comment-only: explains unchanged code. |
| hunk-1 | `src/store.rs` | essential | Removes the stale lock. |

### config-value

Allow five upload attempts. Uploads retry up to five times.

Source pattern: gnosis #411 and backtrack #2: a config value changed; a comment in the same YAML reworded.

| Hunk | File | Label | Why |
| --- | --- | --- | --- |
| hunk-0 | `config/upload.yaml` | noise | Comment reworded only. |
| hunk-1 | `config/upload.yaml` | essential | Config value change. |

### dependency-bump

Update the HTTP client. Bumps undici to 7 for the keep-alive fix.

Source pattern: gnosis #403 and backtrack #2, #5: a version bump in a manifest (essential) and the lockfile lines that follow it.

| Hunk | File | Label | Why |
| --- | --- | --- | --- |
| hunk-0 | `package.json` | essential | Dependency version bump. |
| hunk-1 | `package-lock.json` | noise | Lockfile churn that follows the manifest bump. |

### doc-comment-reword

Rename "rebasing" to "moving" in stack status. Stack members that need a rebase now say they need to move.

Source pattern: gnosis #466: JSDoc reworded to match a renamed concept; the code beside it unchanged.

| Hunk | File | Label | Why |
| --- | --- | --- | --- |
| hunk-0 | `src/stack/status.ts` | noise | Doc comment reworded only. |
| hunk-1 | `src/stack/status.ts` | essential | The visible label changes. |

### docs-header-imports

Document the retry option. The guide explains the new `retries` option, shown per language in tabs.

Source pattern: Docs pages that add MDX component imports at the top before using them (user request: "adding imports at the top of docs").

| Hunk | File | Label | Why |
| --- | --- | --- | --- |
| hunk-0 | `docs/guide/requests.mdx` | noise | Component imports in the MDX header. |
| hunk-1 | `docs/guide/requests.mdx` | essential (no behavior change) | The new documentation the PR is about. |

### drive-by-edits

Cap the export batch size. Exports write at most 500 rows per batch.

Source pattern: gnosis #411 and backtrack #12: a local renamed, a stray console.log removed and a README typo fixed in files the PR is not about.

| Hunk | File | Label | Why |
| --- | --- | --- | --- |
| hunk-0 | `src/export/batch.ts` | essential | The batch size: a config value. |
| hunk-1 | `src/ui/avatar.ts` | noise | Unrelated local rename. |
| hunk-2 | `src/ui/menu.ts` | noise | Stray debug line removed. |
| hunk-3 | `README.md` | noise | Typo fix in an unrelated file. |

### formatting-only

Skip archived projects in the sync. The sync no longer visits archived projects.

Source pattern: gnosis #463: a call Prettier split over three lines, with its quotes normalized.

| Hunk | File | Label | Why |
| --- | --- | --- | --- |
| hunk-0 | `src/sync/report.ts` | noise | Prettier re-wrap and quote style only. |
| hunk-1 | `src/sync/run.ts` | essential | Skips archived projects. |

### go-imports

Normalize and sign webhook payloads. Webhook payloads are trimmed and signed with HMAC.

Source pattern: Import-block additions in Go: a standard-library package (noise) and a module the file never imported (a new dependency).

| Hunk | File | Label | Why |
| --- | --- | --- | --- |
| hunk-0 | `webhook/payload.go` | noise | Standard-library import added. |
| hunk-1 | `webhook/payload.go` | essential | Trims event names. |
| hunk-2 | `webhook/sign.go` | aggressive-only | Import of a module the file did not import: a new dependency. |
| hunk-3 | `webhook/sign.go` | essential | Signs with HMAC. |

### import-existing-module

Add jitter to retry backoff. Retries now add random jitter so clients that failed together do not retry together.

Source pattern: gnosis #472, #439, #411: `import { a } from "./x"` widened to `{ a, b }`, b used further down.

| Hunk | File | Label | Why |
| --- | --- | --- | --- |
| hunk-0 | `src/queue/retry.ts` | noise | Import widened for jitter, which the next hunk uses. |
| hunk-1 | `src/queue/retry.ts` | essential | Backoff adds jitter: the behavior change. |

### import-new-package

Limit concurrent uploads. Uploads run at most four at a time, using p-limit.

Source pattern: backtrack #8, #22 and gnosis #403: a new dependency in the manifest, its import, and its use.

| Hunk | File | Label | Why |
| --- | --- | --- | --- |
| hunk-0 | `package.json` | essential | New runtime dependency. |
| hunk-1 | `src/upload.ts` | aggressive-only | Import of a package the file did not import before: a new dependency. Kept at Conservative. |
| hunk-2 | `src/upload.ts` | essential | Concurrency limit: the behavior change. |

### import-to-dynamic

Load the zip library only when exporting. Startup no longer loads the zip library.

Source pattern: gnosis #443: a top-level import deleted and the module loaded with await import() inside a branch.

| Hunk | File | Label | Why |
| --- | --- | --- | --- |
| hunk-0 | `src/export.ts` | noise | Top-level import deleted; the next hunk carries the change. |
| hunk-1 | `src/export.ts` | essential | Lazy load: changes when the module runs. |

### lockfile-churn

Use time-ordered IDs. New records get UUIDv7 IDs, which sort by creation time.

Source pattern: backtrack #20 and #12: Cargo.toml feature v4 to v7, Cargo.lock dedupe churn, and the call sites.

| Hunk | File | Label | Why |
| --- | --- | --- | --- |
| hunk-0 | `Cargo.toml` | essential | Dependency feature change. |
| hunk-1 | `Cargo.lock` | noise | Lockfile churn following the manifest. |
| hunk-2 | `Cargo.lock` | noise | Lockfile churn following the manifest. |
| hunk-3 | `src/record.rs` | essential | IDs become time-ordered. |

### mixed-hunks

Key snapshots by project. Snapshots are keyed by project, not by a bare UUID.

Source pattern: backtrack #19 (rustfmt wrap plus a type change) and gnosis #463, #377 (a brace removal or class collapse beside a condition).

| Hunk | File | Label | Why |
| --- | --- | --- | --- |
| hunk-0 | `src/snapshots.rs` | essential | rustfmt wrap mixed with a type and boundary change. |
| hunk-1 | `src/flush.ts` | essential | Braces removed and a condition added in one hunk. |

### move

Validate tokens before refreshing. Refresh rejects malformed tokens before calling the server.

Source pattern: gnosis #463: a definition moved without change (a delete and an add), beside the real change.

| Hunk | File | Label | Why |
| --- | --- | --- | --- |
| hunk-0 | `src/auth/tokens.ts` | noise | maskToken deleted here (moved without change). |
| hunk-1 | `src/auth/tokens.ts` | essential | Rejects malformed tokens (and maskToken arrives in the same hunk). |

### public-api-export

Export the retry policy. Library users can build their own retry policy.

Source pattern: backtrack #14 (`pub use` re-export) and gnosis #463 (`export { X } from`): one-line hunks that widen the public API.

| Hunk | File | Label | Why |
| --- | --- | --- | --- |
| hunk-0 | `src/index.ts` | essential | Public API export. |
| hunk-1 | `crates/core/src/lib.rs` | essential | Public re-export. |

### python-imports

Time out slow health checks. Health checks give up after two seconds.

Source pattern: Python `from x import (a, b)` widened (noise) and a third-party module imported for the first time (a new dependency).

| Hunk | File | Label | Why |
| --- | --- | --- | --- |
| hunk-0 | `service/health.py` | noise | Import list widened. |
| hunk-1 | `service/health.py` | essential | Adds the cache check. |
| hunk-2 | `service/probe.py` | aggressive-only | First import of a third-party package: a new dependency. |
| hunk-3 | `service/probe.py` | essential | Probes with a two-second timeout. |

### related-helper-edits

Ask before quitting with Ctrl+C. Ctrl+C asks for confirmation before the app quits.

Source pattern: backtrack #13: the key handler change, a struct field and its initializer threaded through.

| Hunk | File | Label | Why |
| --- | --- | --- | --- |
| hunk-0 | `src/app.rs` | aggressive-only | Field threaded through for the main change. |
| hunk-1 | `src/app.rs` | aggressive-only | Initializer for the new field. |
| hunk-2 | `src/app.rs` | essential | Ctrl+C asks first. |
| hunk-3 | `src/status.rs` | essential | The prompt the user sees. |

### removed-guard

Fix the race when counting files. Counting no longer checks existence first; a missing directory is handled by the read.

Source pattern: backtrack #6 and #12: an early-return guard and a drop() removed. They read like dead code but change behavior.

| Hunk | File | Label | Why |
| --- | --- | --- | --- |
| hunk-0 | `src/count.rs` | essential | Guard removed and NotFound handled in the read (one hunk). |
| hunk-1 | `src/main.rs` | essential | Removing the drop skips the telemetry flush. |

### repeated-test-data

Rename the default model. The default model is now model-6-2.

Source pattern: gnosis #411: the same literal updated in many unrelated test files after a rename.

| Hunk | File | Label | Why |
| --- | --- | --- | --- |
| hunk-0 | `src/models.ts` | essential | Default model: a config value. |
| hunk-1 | `tests/chat.test.ts` | aggressive-only | Test data follows the rename. |
| hunk-2 | `tests/summary.test.ts` | aggressive-only | Test data follows the rename. |

### sql-schema

Cache folder IDs on links. Links store their folder so the folder view needs no join.

Source pattern: backtrack #22 and #16: a SQL migration, an inline SQL change, a proto field; plus a comment-only edit in an older migration.

| Hunk | File | Label | Why |
| --- | --- | --- | --- |
| hunk-0 | `migrations/0007_link_folder.sql` | essential | Schema migration. |
| hunk-1 | `migrations/0003_links.sql` | noise | Comment-only edit in an old migration. |
| hunk-2 | `src/links.rs` | essential | Inline SQL changes what is written. |
| hunk-3 | `proto/links.proto` | essential | Wire schema field. |

### tests-pin-behavior

Trim names before joining paths. Path segments are trimmed, so " a " and "a" join the same.

Source pattern: gnosis #469, #466: a test that pins the new behavior, and one file appended to the giant package.json "test" line.

| Hunk | File | Label | Why |
| --- | --- | --- | --- |
| hunk-0 | `src/paths.ts` | essential | The behavior change. |
| hunk-1 | `tests/paths.test.ts` | essential (no behavior change) | Pins the new behavior; does not change product behavior. |
| hunk-2 | `package.json` | noise | Test file registered in the runner list. |

### whitespace-only

Read the cache size from the environment. The cache size can be set with CACHE_MB.

Source pattern: gnosis #463 and backtrack #19: blank lines and trailing spaces cleaned up in a file the PR also touches elsewhere.

| Hunk | File | Label | Why |
| --- | --- | --- | --- |
| hunk-0 | `src/cache/config.ts` | noise | A blank line and trailing spaces removed. |
| hunk-1 | `src/cache/config.ts` | essential | Reads CACHE_MB with a fallback. |

