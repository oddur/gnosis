# Resolve simple PR conflicts in Gnosis

Research date: October 31, 2026. Scope: feasibility and a proposed first version. No implementation or remote writes.

## Recommendation

Yes. Pierre supplies useful conflict controls and a source editor. Gnosis still needs a Git merge backend and a safe commit workflow. Start with competing text changes in one PR, with explicit branch labels and a final diff before publication. This matches the limited conflict class that GitHub supports in its browser editor. [GitHub conflict editor][github-conflicts]

The operation merges the PR's actual base branch into its head branch. It updates the PR branch and leaves PR approval and final merging separate. GitHub's conflict editor follows the same model. [GitHub conflict editor][github-conflicts]

## What the installed Pierre package supplies

The inspected dependency is `@pierre/diffs` **1.6.1**. Its React and vanilla APIs expose `UnresolvedFile`. Conflict actions are `current`, `incoming`, and `both`. The component consumes complete file contents with Git conflict markers. It does not discover merge conflicts from a PR patch. [Installed package](../node_modules/@pierre/diffs/package.json) [Published types][pierre-types] [Official documentation][pierre-docs]

`UnresolvedFile` is experimental, and its React wrapper manages resolution state internally. The `file` prop initializes that state. Replacing the input requires a remount. **`UnresolvedFile` cannot enter edit mode.** Manual changes require a separate editable `File` or `FileDiff`, with `EditProvider` and `Editor`. [Official documentation][pierre-docs] [React conflict types][pierre-react] [Editor exports][pierre-editor]

There is a material integration detail in 1.6.1: the React wrapper owns `onMergeConflictAction` and does not expose the vanilla resolution callbacks. The vanilla component exposes `onMergeConflictResolve(file, payload)` and `onMergeConflictAction(payload, instance)`. Its `resolveConflict(...)` method returns the updated file and conflict state. A small React wrapper around the vanilla component is a possible way to retain drafts reliably. [React implementation][pierre-hook] [Vanilla types][pierre-vanilla]

The current online documentation also describes `resolveMergeConflict`. That helper is absent from the installed package's public exports. Its exported `resolveConflict` helper operates on diff metadata and has a different signature. Implementation must use the installed API, or deliberately upgrade and check compatibility. [Official documentation][pierre-docs] [Published exports][pierre-exports]

## Why the GitHub merge endpoints are insufficient

| Endpoint | What it provides | Missing capability |
| --- | --- | --- |
| `PUT /pulls/{number}/update-branch` | Merges the latest base into the PR branch. `expected_head_sha` rejects a changed head. | No request field for resolved file contents. [API][github-update] |
| `POST /merges` | Merges a branch or commit into another branch. | Returns `409` for merge conflicts. [API][github-merge] |
| Git blobs, trees, commits, and refs | Can publish a tree and a merge commit with two parents. | Gnosis must compute the merge result and resolve conflicts first. [Trees][github-trees] [Commits][github-commits] [Refs][github-refs] |

These public APIs do not provide a conflict-resolution session equivalent to GitHub's browser editor. Git Data APIs can publish a computed result, but do not remove the merge-engine requirement.

## Proposed backend and publication flow

An isolated Git repository or object cache is sufficient. A checkout is optional: `git merge-tree --write-tree <head-sha> <base-sha>` performs Git's merge without changing a working tree or index. It handles three-way content merges, renames, directory conflicts, and multiple merge bases. A temporary worktree with a real merge is another option. [Git merge-tree][git-merge-tree]

The proposed flow is:

1. Record the PR's head repository, head ref, head SHA, base repository, base ref, and base SHA.
2. Fetch those objects and enough history to find the merge bases in isolated storage.
3. Run `merge-tree --write-tree -z`, retaining the result tree, conflict stages, conflict types, and exit status.
4. Show supported text conflicts through Pierre, with labels such as “PR branch” and “Base branch.”
5. Retain complete resolved contents and preserve the merge result's other files and file modes.
6. Show the final changes relative to the original PR head, including clean changes from the base branch.
7. Recheck the PR identity, head, and base before publication. If either SHA changed, regenerate the merge session.
8. Create a merge commit with parents `[original head SHA, recorded base SHA]`, then update only the head ref.

This sequence is a proposed design. Git documents the tree result, conflict records, and two-parent commit construction. GitHub also accepts multiple parents through its commit API. [Git merge-tree][git-merge-tree] [GitHub commits][github-commits]

For a local Git publisher, an explicit lease supplies a head compare-and-swap: `--force-with-lease=refs/heads/<branch>:<recorded-head-sha>`. The application must also require the new commit to descend from that recorded head. This preserves history while rejecting a changed remote head. A REST ref update with `force: false` protects against overwriting divergent work, but has no expected-old-SHA field. It is not an exact concurrency check. [Git push][git-push] [GitHub refs][github-refs]

The base ref cannot be locked by the head update. A later base change can make the PR outdated or conflicted again. The resulting commit still records the exact base SHA that the user resolved. This follows from the separate refs and fixed commit parents. [GitHub refs][github-refs] [GitHub commits][github-commits]

## First-version limits

- **Supported:** regular text files with competing line changes. Resolution means choosing either side, combining both, or editing the final text.
- **Deferred:** binary files, symlinks, submodules, rename/delete, modify/delete, mode changes, directory conflicts, and unsupported encodings. Conflict markers cannot represent every Git conflict. Git's conflict records and exit status must determine eligibility. [Git merge-tree][git-merge-tree]
- **Forks:** reading the PR does not establish permission to update its head repository. Maintainer edits depend on the fork's permissions and the credential used. Branch rules can also reject publication. [Fork permissions][github-forks] [Update-branch permissions][github-update] [GitHub conflict editor][github-conflicts]
- **Stacks:** resolve one member against its actual PR base. A combined review diff is not a commit target. A merge commit does not rebase or restack descendants. This is a proposed scope boundary, based on the operation's two-parent merge model. [Git merge-tree][git-merge-tree]

Before implementation, a small integration check must establish reliable draft extraction, reset behavior, undo, newline preservation, and final diff fidelity in Pierre 1.6.1. Backend checks must cover stale heads, base changes, unsupported conflicts, and publication failure. This research inspected documentation and package code. It did not test an end-to-end resolution.

## Mergiraf integration

**Yes: a bundled Mergiraf executable is a practical optional resolver.** It complements Git's repository merge and Pierre's review interface. It does not replace branch discovery, rename handling, commit construction, or publication checks. Mergiraf merges three versions of an individual file using syntax-aware heuristics. [Library overview][mergiraf-lib]

The CLI accepts three standalone files: `mergiraf merge BASE LEFT RIGHT --path-name src/example.ts`. It writes the result to stdout unless an output path or Git-driver mode is selected. Gnosis can materialize three Git blobs in temporary files, with no checkout. The original path selects the language. Explicit revision labels and a timeout are available. Exit code `1` means unresolved conflicts remain. [CLI source][mergiraf-cli]

The Rust function `line_merge_and_structured_resolution` also accepts three strings. Repository lookup, attempt caching, and debug output can be omitted through optional arguments. However, upstream explicitly states that its library API is not stable. No supported JavaScript or WebAssembly interface appears in the inspected manifest and library documentation. The merge implementation uses native threads. A native child process is the shortest supported route for Electron. [Merge source][mergiraf-merge] [Library overview][mergiraf-lib] [Manifest][mergiraf-cargo]

Version 0.20.0 publishes macOS binaries for Apple Silicon and Intel, Linux binaries for ARM64 and x86-64, and a Windows x86-64 binary. Linux downloads include GNU and musl variants. Supported languages include JavaScript/JSX, TypeScript/TSX, Rust, Python, Go, Java, C/C++, and many others. Supported formats include JSON, YAML, TOML, HTML, XML, and HCL. Language support does not guarantee correct resolution. The project documents heuristic limitations and retains markers for conflicts it cannot resolve. [Release assets][mergiraf-release] [Languages][mergiraf-languages] [Usage][mergiraf-usage]

### License boundary

Mergiraf is **GPL-3.0-only**. Gnosis currently uses the MIT license. These licenses permit integration, but the distribution model determines the obligations. [Manifest][mergiraf-cargo] [Mergiraf license][mergiraf-license] [Gnosis license](../LICENSE)

- **Separate executable:** GPLv3 permits distribution alongside independent programs without applying the GPL to those programs. The FSF describes ordinary command-line and file communication as normally connecting separate programs. Keeping Mergiraf independent supports retaining Gnosis's MIT licensing. Process separation alone is not conclusive if the programs form one combined work. [GPLv3 §5][gpl-license] [FSF aggregation guidance][gpl-aggregation]
- **Bundling obligations:** include Mergiraf's copyright notices and GPL license, and provide its corresponding source under GPLv3. For downloadable binaries, §6(d) permits equivalent source access with clear directions beside the binary. The source must match the distributed version and include required build materials and modifications. An unqualified link to upstream's latest branch is insufficient. [GPLv3 §§1, 4–6][gpl-license]
- **Linked library:** the FSF treats static and dynamic linking as a combined work covered by GPL. A Rust addon or embedded library therefore requires GPL-compatible distribution of the combined application, rather than an MIT-only distribution. Existing MIT code can retain its notices. [FSF linking guidance][gpl-linking] [GPLv3 §5][gpl-license]

Recommended first integration: run the pinned executable on supported text conflicts, preview its proposed result, and retain Pierre for unresolved conflicts and manual changes. Mergiraf's CLI also records merge attempts in its cache. That storage needs an explicit lifecycle in Gnosis. The CLI uses Git for some fallback paths, so a standalone binary does not eliminate the backend's Git dependency. [CLI source][mergiraf-cli]

[pierre-docs]: https://diffs.com/llms-full.txt
[pierre-types]: https://unpkg.com/@pierre/diffs@1.6.1/dist/types.d.ts
[pierre-react]: https://unpkg.com/@pierre/diffs@1.6.1/dist/react/UnresolvedFile.d.ts
[pierre-hook]: https://unpkg.com/@pierre/diffs@1.6.1/dist/react/utils/useUnresolvedFileInstance.js
[pierre-vanilla]: https://unpkg.com/@pierre/diffs@1.6.1/dist/components/UnresolvedFile.d.ts
[pierre-editor]: https://unpkg.com/@pierre/diffs@1.6.1/dist/edit/index.d.ts
[pierre-exports]: https://unpkg.com/@pierre/diffs@1.6.1/dist/index.d.ts
[github-conflicts]: https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/addressing-merge-conflicts/resolving-a-merge-conflict-on-github
[github-update]: https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request-branch
[github-merge]: https://docs.github.com/en/rest/branches/branches#merge-a-branch
[github-trees]: https://docs.github.com/en/rest/git/trees#create-a-tree
[github-commits]: https://docs.github.com/en/rest/git/commits#create-a-commit
[github-refs]: https://docs.github.com/en/rest/git/refs#update-a-reference
[github-forks]: https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/allowing-changes-to-a-pull-request-branch-created-from-a-fork
[git-merge-tree]: https://git-scm.com/docs/git-merge-tree
[git-push]: https://git-scm.com/docs/git-push#Documentation/git-push.txt---force-with-leaseltrefnamegtltexpectgt
[mergiraf-lib]: https://codeberg.org/mergiraf/mergiraf/src/branch/main/src/lib.rs
[mergiraf-cli]: https://codeberg.org/mergiraf/mergiraf/src/branch/main/src/main.rs
[mergiraf-merge]: https://codeberg.org/mergiraf/mergiraf/src/branch/main/src/merge.rs
[mergiraf-cargo]: https://codeberg.org/mergiraf/mergiraf/src/branch/main/Cargo.toml
[mergiraf-license]: https://codeberg.org/mergiraf/mergiraf/src/branch/main/LICENSE.txt
[mergiraf-release]: https://codeberg.org/mergiraf/mergiraf/releases/tag/v0.20.0
[mergiraf-languages]: https://mergiraf.org/languages.html
[mergiraf-usage]: https://mergiraf.org/usage.html
[gpl-license]: https://www.gnu.org/licenses/gpl-3.0.html
[gpl-aggregation]: https://www.gnu.org/licenses/gpl-faq.html#MereAggregation
[gpl-linking]: https://www.gnu.org/licenses/gpl-faq.html#GPLStaticVsDynamic
