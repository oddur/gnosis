# Conflict lab

Realistic merge conflicts for testing conflict resolution (#444): the preparation pipeline (rerere, Mergiraf and the
tree-sitter checks) and the buckets it sorts each conflict into (Merged, Check, Decide).

- Hand-written cases cover each language, structure, semantic trap, file kind, failure path, stack and base move.
- `real-*` cases are conflicts from open-source merge commits, with the human's committed resolution.
- `gen-*` cases are a small sample of the generated matrix (see [MATRIX.md](MATRIX.md)).

These files are merge inputs and must stay byte-exact, so ESLint, Prettier, the pre-commit whitespace hooks and
`tsc` skip this directory.

## A case

```
<case>/
  case.json
  base/<path>      the common ancestor
  ours/<path>      the PR side
  theirs/<path>    the base branch (main)
  resolved/<path>  optional: a known-correct resolution
```

A file missing from a side was deleted on that side. A line `@@PAD <n> <seed>@@` expands to n lines of filler code in
the file's language, so the large-file case does not commit thousands of lines.

`case.json`:

| Field | Meaning |
| --- | --- |
| `description`, `language`, `category` | What the case is. |
| `expected` | Per conflicted file, the bucket of each conflict block in Git's order, or one value for all of them: `merged`, `check`, `decide`, `clean` (Git merges it with no conflict), `any-but-merged` (Merged would be unsafe), `auto` (Merged or clean), or `any`. |
| `source` | Real cases: the repository, its licence, and the merge commit with its parents. |
| `mergiraf` | `hang`, `timeout`, `fail`, `missing` or `garbage`: replace the Mergiraf binary, to test failure paths. |
| `languagesOff` | Languages turned off in Settings, so the checks cannot parse them. |
| `stack` | `["pr1", "pr2", "pr3"]`: a stack. Each `prN/` tree is a PR on top of the previous one, and `resolved/prN/` resolves it. `steps` holds the expectations per PR. |
| `theirs2/`, `resolved2/` | A base move: main moves to `theirs2` while the conflict is open. `steps` has `before-move` and `after-move`. |
| `rerere` | The conflict is resolved and published once, then comes back in a second PR. `steps` has `first` and `second`. |
| `acceptable` | More known-correct resolutions, by path. |

## Run the harness

```
npm run prepare:mergiraf          # once
npm run conflict-lab               # every case; prints the report
npm run conflict-lab -- --only real-  --out /tmp/report.md --json /tmp/results.json
npm run conflict-lab -- --matrix   # the generated matrix; writes /tmp/conflict-lab-report.md
npm run conflict-lab -- --matrix --variants 6 --seed 2 --only add-import
```

Each case runs in a private bare repository that stands in for GitHub, through the real conflict service
(`src/conflict-resolution-service.ts`), then `verifyProposals` and `blockBuckets` (`lib/conflict-verify.ts`) with the
real grammars. Nothing touches the network. The exit code is 1 when a case Merged something it should not, or failed to
run.

The report shows, per conflict block, the expected and actual bucket, why a block was not Merged (Mergiraf left it
conflicted, Mergiraf's whole-file result was rejected, or a check failed), and how each Merged result compares with the
known-correct resolution: `exact` (equal once whitespace is normalised), `blocks-match` (each Merged block appears in
the resolution; the human also edited elsewhere), `reordered`, `cosmetic` (same code, broken layout), or `differs`
(counted as a wrong Merged). It ends with the confusion matrix and the wrong-Merged list.

The "with fixes" column runs the extra checks proposed for #444 (`scripts/conflict-lab-fixes.mjs`) on top of #444's
own, to show what they would catch and what they would cost.

## Seed the scratch repository

`scripts/seed-conflict-lab.mjs` builds the cases into a GitHub repository as real conflicting PRs. All case files live
under `cases/<name>/`. One commit on top of the repository's first commit adds every base, and main gets one commit
per case with main's side. Each case gets a branch `case/<name>` from the base commit, and a PR into main. Stacks get
`case/<name>-pr1..3`, each PR targeting the one below. Rerere cases get a second `case/<name>-again` PR. The cases
that replace the Mergiraf binary run only offline, so they are skipped.

The seeder is idempotent. It reuses fixed commit dates, so a rerun builds the same SHAs. It force-resets main and the
`case/*` branches, deletes stale `case/*` branches, and closes their PRs. It needs `gh auth status` to show an account
that can push to the repository.

```
node scripts/seed-conflict-lab.mjs --repo oddur/gnosis-conflict-lab --dry-run              # plan only; no network
node scripts/seed-conflict-lab.mjs --repo oddur/gnosis-conflict-lab --remote /tmp/lab.git  # a local bare repo; no PRs
node scripts/seed-conflict-lab.mjs --repo oddur/gnosis-conflict-lab --sample 24            # seed, with 24 matrix cases
```

Options: `--only <text>` seeds only cases whose name contains the text. `--sample N` adds N generated matrix cases,
spread across patterns and languages. `--patterns a,b` adds every language of those patterns. `--move-base <case>`
pushes a base-move case's second main commit. Run it while that PR's conflict workspace is open.

## Test end to end in Gnosis

1. Build and start a local Gnosis: `npm start`. Its Mergiraf comes from `npm run prepare:mergiraf`. Sign in with an
   account that can push to the scratch repository.
2. Make sure Gnosis lists the `[lab]` PRs of `oddur/gnosis-conflict-lab` (watch the repository in Settings if it does not). They show as conflicting.
3. Open a PR and choose Resolve conflicts. Compare the summary ("N of M conflicts are merged and checked") and each
   block's bucket with the PR body's expected buckets. They should match `npm run conflict-lab -- --only <case>`.
4. For a Merged block, read the proposal. For a Check block, read the note that says which check failed.
5. Publish one, to check that the merge commit on the PR is right. Reseed afterwards to reset the branch.
6. Special cases:
   - `language-off-python`: turn Python off in Settings > Appearance > Code intelligence first.
   - `base-moves-during-resolution`: open it, then run `--move-base base-moves-during-resolution` and preview.
   - `rerere-*`: publish the first PR, then open the `-again` PR.
   - `stack-*`: resolve `-pr1`, then `-pr2`, then `-pr3`.

Local unsigned builds cannot reach AI APIs, so "Ask an agent" fails there. That is expected. Structural merge and the
checks do not need the network.
