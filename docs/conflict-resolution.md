# Resolve PR conflicts

Open **Resolve conflicts…** in the PR actions, in a PR's context menu, or beside a conflicted PR in the stack overview. The workspace brings the base branch into the PR branch with a merge commit. It does not merge the PR.

The heading names the task, such as "Bring main into @ana's feature/retry". One step rail stays the same from start to end: **Resolve N files**, then **Confirm and push to the branch**, and, for a stack, an optional **Restack** step.

## Resolve each file

Each conflict shows two labelled versions side by side: **This PR · branch** and the base branch. The common ancestor is under a collapsed **Before both changes**. Git's markers and commit IDs are never shown as labels.

1. Choose **Keep PR change**, **Keep main's change** or **Keep both** for each conflict. The block then shows a short note, such as "Kept PR change · Undo". Undo works per block and survives switching files. Use **Edit result** to write your own result.
2. When no conflict is left, the file is **Resolved · needs review**. Select **Review result** to compare the result with the PR version. The columns are labelled.
3. **Mark reviewed** is available only after the current result has been shown. It saves the file as **Reviewed** and opens the next file that needs work.
4. When every file is reviewed, the confirmation opens directly.

**Suggest a resolution** offers a structural merge (Mergiraf, bundled, runs locally), **Ask <model>…** with optional instructions, and **Suggest for all unreviewed files…**. Suggestions are drafts: they never mark a file reviewed. The selected model gets the three versions, your draft and the PR context, without a checkout or test runner.

Each file has one main action in the footer: **Next conflict**, **Review result**, **Mark reviewed**, **Next file** or **Review and push…**. Drafts save automatically; the rail shows "Saving…" or "Saved". **Start over with latest code…** asks before it replaces the draft with a fresh merge.

The guide opens on first use. After it is hidden or the workspace is closed once, it stays collapsed (`gnosis-conflict-guide` in local storage) until you open it with **Guide**.

### Keyboard

| Key | Action |
| --- | --- |
| J / K | Next / previous conflict |
| 1 / 2 / 3 | Keep PR change / base change / both, for the focused conflict |
| M | Show the result, then mark the file reviewed and open the next file |
| N / P | Next / previous file |

Opening the workspace focuses the first unresolved conflict. Shortcuts pause in text fields, the result editor and the confirmation. They are also listed in the keyboard shortcut overlay (?).

## Confirm and push

The confirmation is the only place that pushes. It shows the final update in two parts: **Your resolutions** (the files you resolved) and **Changes coming from the base branch** (files Git merged cleanly). It names the author's branch and says that approvals may be dismissed if the repository requires it. Enter a commit message and select **Push merge commit**. Enter alone never pushes.

After the push, the outcome names the updated branch, the merge commit, the files you resolved, and that checks restart. It also says how to undo: reset the branch to its previous commit. **Done** closes the workspace.

If someone pushed to the branch after you started, the push is rejected and nothing is pushed. **Load latest changes** prepares the merge again on the new head. Resolutions recorded before the push attempt are reused, and you review each file again. Other Git errors show plain copy, with the raw output under **Details**. A failed push is never resent; **Check again** only reads the branch.

## Other states

- **Already up to date:** the PR branch already contains the base branch. There is nothing to merge.
- **No conflicts to resolve:** Git merges cleanly. **Review and push…** opens the confirmation.
- **The branches changed:** the draft is stale and cannot be pushed. **Start over with latest code…** or **Load latest changes** prepares the merge again.
- **Preparing:** progress shows inline. After about five seconds the workspace says that preparation continues in Activity, where it can also be cancelled.

## Restack dependent PRs

After the push, a stack can restack the PRs above this one. A paused restack uses the same conflict view, with **Updated parent** and **This PR** as the versions. Each prepared PR update has its **Reviewed** checkbox at its header. Continue stays disabled, with the reason beside it, until every update is reviewed. All branches are pushed together in one atomic push, or none are.

## Supported conflicts

This version handles regular UTF-8 text files with a common ancestor and both branch versions. Binary, rename/delete, file-mode and repository-structure conflicts require a local merge tool. The workspace explains unsupported files and prevents publication until all conflicts can be resolved. Limits are 100 conflicted files, 1 MB per file version, and 12 MB of combined conflict text.

Git 2.38 or newer must be installed and available to the app. Git 2.40 or newer prepares conflicts without fetching history. Mergiraf 0.20.0 is bundled. Project tests are **not** run: agents receive the supplied ancestor, branch versions, current draft and PR context, without a checkout or test runner. The confirmation and proposal notes state this limitation.

## Storage and publication

All network, Git, model and disk work runs in Electron's backend. The renderer receives bounded text and parsed preview metadata. Editor code loads only when the workspace opens.

Drafts use the existing SQLite app-data store, scoped by GitHub account and PR URL. They are saved work, so clearing the GitHub cache does not delete them. No user checkout is created or changed.

Preparation asks GitHub for the merge base, then fetches only three commits (head, base and merge base) with `--depth=1 --filter=blob:none`. With Git 2.40 or newer, `git merge-tree --merge-base` merges them without history. The commits go into one bare repository per account and base repository, `userData/conflict-objects/stores/<hash>`, so a second PR in the same repository fetches only its new commits. Each PR keeps a small private repository under `userData/conflict-objects/sessions/<account-and-PR-hash>`. It borrows the store's objects through Git alternates, lists the three commits as shallow, and holds no branch refs. The store keeps one set of refs per session (`refs/gnosis/<session-hash>/…`), so its objects are never pruned while a session uses them. Fetches and ref updates in a store run one at a time. If a repository is linked in **Settings → Local clones**, its object directory is added as a read-only alternate, so commits that are already on disk are not downloaded. Gnosis finds that directory without running Git in the clone and never writes to it. File versions that the merge needs arrive on demand, as before.

If GitHub does not return a merge base, or a shallow fetch or merge fails, preparation falls back to the previous path: the whole history of both commits, without blobs, in the session's own repository. When there is one merge base, both paths label the common ancestor in conflict markers with the same 12-character abbreviation, so they write identical results. Restacking dependent PRs needs history. It fetches the full history into the session repository first, which costs what every preparation cost before.

On startup, Gnosis removes cache directories that no saved session needs: discarded sessions, published sessions without a paused or prepared restack, and full-history caches from earlier versions. A draft whose cache was removed rebuilds its merge from the shared store when it is previewed or published, and checks that the result is the same tree. A store is removed when no session borrows from it. The resolution memory (`conflict-objects/resolution-memory`) is not changed.

Mergiraf receives temporary files that Gnosis deletes after the operation. Upstream Mergiraf also retains a local attempt cache, capped at 128 attempts, in its platform application-data directory. This cache is shared with standalone Mergiraf; Gnosis does not delete it. The bundled executable, matching upstream source archive, license and build directions are under the app's `Resources/mergiraf` directory.

Preview and publish recheck account, permissions, repository, branch names, and both pinned revisions. The merge commit has the original PR head as its first parent and the pinned base as its second. An exact-head Git push lease rejects concurrent PR updates. Protected-branch rules still apply. Publication cannot be cancelled once confirmed; reopening reconciles a successful push if its response or local status write was interrupted.

The preparation reads the live target branch tip (`baseRef.target.oid`), not the PR's historical `baseRefOid` snapshot. If Git can merge it cleanly, Gnosis says **No conflicts to resolve** and offers **Review and push…**. If the PR already contains that tip, Gnosis says that the branch already includes the base and prevents an unnecessary merge commit. Neither state means that Gnosis pushed anything.
