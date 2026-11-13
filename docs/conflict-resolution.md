# Resolve PR conflicts

Open **Resolve conflicts…** in the PR actions or beside a conflicted PR in the stack overview.

1. Choose the PR change, base-branch change, or both for each conflict. Use **Edit result** for manual edits.
2. **Try Mergiraf** proposes a structural merge. **Ask agent** uses your selected Claude or Codex model. You can supply instructions or answer its question under Agent guidance.
3. Inspect the result and **Mark reviewed** for each file. Automatic proposals never mark themselves reviewed.
4. Open **Review resolution…** to inspect the complete branch update, including clean changes from the base branch.
5. Enter a commit message and select **Commit resolution & update PR**. This adds a merge commit to the PR branch. It does not merge the PR into its target.

**Save draft** stores edits locally. Switching files, closing the workspace, or starting another action also saves pending edits. Background work appears in Activity. Reopen Resolve conflicts to resume. Start over asks before replacing saved work.

## Supported conflicts

This version handles regular UTF-8 text files with a common ancestor and both branch versions. Binary, rename/delete, file-mode and repository-structure conflicts require a local merge tool. The workspace explains unsupported files and prevents publication until all conflicts can be resolved. Limits are 100 conflicted files, 1 MB per file version, and 12 MB of combined conflict text.

Git 2.38 or newer must be installed and available to the app. Git 2.40 or newer prepares conflicts without fetching history. Mergiraf 0.20.0 is bundled. Project tests are **not** run: agents receive the supplied ancestor, branch versions, current draft and PR context, without a checkout or test runner. The final preview states this limitation.

## Storage and publication

All network, Git, model and disk work runs in Electron's backend. The renderer receives bounded text and parsed preview metadata. Editor code loads only when the workspace opens.

Drafts use the existing SQLite app-data store, scoped by GitHub account and PR URL. They are saved work, so clearing the GitHub cache does not delete them. No user checkout is created or changed.

Preparation asks GitHub for the merge base, then fetches only three commits (head, base and merge base) with `--depth=1 --filter=blob:none`. With Git 2.40 or newer, `git merge-tree --merge-base` merges them without history. The commits go into one bare repository per account and base repository, `userData/conflict-objects/stores/<hash>`, so a second PR in the same repository fetches only its new commits. Each PR keeps a small private repository under `userData/conflict-objects/sessions/<account-and-PR-hash>`. It borrows the store's objects through Git alternates, lists the three commits as shallow, and holds no branch refs. The store keeps one set of refs per session (`refs/gnosis/<session-hash>/…`), so its objects are never pruned while a session uses them. Fetches and ref updates in a store run one at a time. If a repository is linked in **Settings → Local clones**, its object directory is added as a read-only alternate, so commits that are already on disk are not downloaded. Gnosis finds that directory without running Git in the clone and never writes to it. File versions that the merge needs arrive on demand, as before.

If GitHub does not return a merge base, or a shallow fetch or merge fails, preparation falls back to the previous path: the whole history of both commits, without blobs, in the session's own repository. When there is one merge base, both paths label the common ancestor in conflict markers with the same 12-character abbreviation, so they write identical results. Restacking dependent PRs needs history. It fetches the full history into the session repository first, which costs what every preparation cost before.

On startup, Gnosis removes cache directories that no saved session needs: discarded sessions, published sessions without a paused or prepared restack, and full-history caches from earlier versions. A draft whose cache was removed rebuilds its merge from the shared store when it is previewed or published, and checks that the result is the same tree. A store is removed when no session borrows from it. The resolution memory (`conflict-objects/resolution-memory`) is not changed.

Mergiraf receives temporary files that Gnosis deletes after the operation. Upstream Mergiraf also retains a local attempt cache, capped at 128 attempts, in its platform application-data directory. This cache is shared with standalone Mergiraf; Gnosis does not delete it. The bundled executable, matching upstream source archive, license and build directions are under the app's `Resources/mergiraf` directory.

Preview and publish recheck account, permissions, repository, branch names, and both pinned revisions. The merge commit has the original PR head as its first parent and the pinned base as its second. An exact-head Git push lease rejects concurrent PR updates. Protected-branch rules still apply. Publication cannot be cancelled once confirmed; reopening reconciles a successful push if its response or local status write was interrupted.

The preparation reads the live target branch tip (`baseRef.target.oid`), not the PR's historical `baseRefOid` snapshot. If Git can merge it cleanly, Gnosis says that it prepared a local merge and offers **Review branch update…**. If the PR already contains that tip, Gnosis says **PR branch is already up to date** and prevents an unnecessary merge commit. Neither state means that Gnosis pushed anything.
