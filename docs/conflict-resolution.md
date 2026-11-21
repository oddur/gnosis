# Resolve PR conflicts

Open **Resolve conflicts…** in the PR actions, in a PR's context menu, or beside a conflicted PR in the stack overview. The workspace brings the base branch into the PR branch with a merge commit. It does not merge the PR.

The heading names the task, such as "Bring main into @ana's feature/retry". Below it, one sentence says where you are: "3 files have conflicts. 7 of 9 conflicts are merged and checked. 2 need you." When nothing is left to decide or check, it names the files that wait for **Mark reviewed** ("1 file is ready for review."). The footer counts the files you reviewed. There is no step rail and no guide.

## Resolve each file

Each conflict shows two labelled versions side by side: **This PR · branch** and the base branch. The common ancestor is under a collapsed **Before both changes**. Git's markers and commit IDs are never shown as labels.

1. Choose **Keep PR change**, **Keep main's change** or **Keep both** for each conflict. The block then shows a short note, such as "Kept PR change · Undo", even when the proposal had the same text: a choice you make is yours. Undo works per block and survives switching files. Use **Edit result** to write your own result.
2. When no conflict is left, the file is **Resolved · needs review**. Select **Review result** to compare the result with the PR version. The columns are labelled.
3. **Mark reviewed** is available only after the current result has been shown. A file whose every conflict is Merged shows its results already, so its next step is **Mark reviewed**. It saves the file as **Reviewed** and opens the next file that needs work.
4. When every file is reviewed, the confirmation opens directly.

### Compare with

The file header has a switch, **Compare with: PR · main · both**. Gnosis remembers the choice for every file and PR while the window stays open.

- **PR** (the default) compares the result with the PR's version: what the author sees change on their branch.
- **main** compares the result with the base branch's version: what the PR still changes after the merge.
- **both** shows each conflict as three rows: the PR's side, the base branch's side and the result, each compared with the version before both changes. Only the conflicts show, with every line of each row; PR and main show the whole file. When the draft has no conflicts left, **both** is off and the view shows PR.

The switch never hides a conflict. Each Check and Decide card stays under its conflict's lines in every mode. A conflict you have not decided shows its two sides, never one of them as the result: against main, the PR's lines stand in for it, and in both its result row says "Nothing is chosen yet." Lines you reveal in PR stay revealed when you switch to another mode and back.

Structural merge runs on every file while the merge is prepared, so there is no engine to choose. **Ask <model>…** (the Bot icon) asks the selected model about the open file, with optional instructions. Its result is a draft: it never marks a file reviewed. The model gets the three versions, your draft and the PR context, without a checkout or test runner.

A conflict Gnosis can't write as text, such as a rename on both sides, a deletion or a binary file, shows **Needs a local merge tool** in the file list and the file header. Gnosis pushes only a merge it can resolve completely, so the file says to merge the PR on your computer and gives the commands to start (**Copy commands**).

Each file has one main action in the footer: **Next conflict**, **Review result**, **Mark reviewed**, **Next file** or **Review and push…**. Drafts save automatically; the summary row shows "Saving…" or "Saved". **Start over with latest code…** asks before it replaces the draft with a fresh merge.

### Keyboard

| Key | Action |
| --- | --- |
| J / K | Next / previous conflict |
| 1 / 2 / 3 | Keep PR change / base change / both, for the focused conflict |
| M | Mark the file reviewed and open the next file. A file with a choice or an edit of yours shows its result first |
| N / P | Next / previous file |

Opening a file focuses the first conflict that needs you, or the file's next action when none does. Shortcuts pause in text fields, the result editor and the confirmation. The keyboard button in the summary row lists them on hover or focus, as does the keyboard shortcut overlay (?).

## Confirm and push

The confirmation is the only place that pushes. It shows the final update in two parts: **Your resolutions** (the files you resolved) and **Changes coming from the base branch** (files Git merged cleanly). It names the author's branch and says that approvals may be dismissed if the repository requires it. Enter a commit message and select **Push merge commit**. Enter alone never pushes. The title and **Push merge commit** stay in view; only the diff between them scrolls.

After the push, the outcome names the updated branch, the merge commit, the files you resolved, and that checks restart. It also says how to undo: reset the branch to its previous commit. **Done** closes the workspace.

If someone pushed to the branch after you started, the push is rejected and nothing is pushed. **Load latest changes** prepares the merge again on the new head. Conflicts whose text did not change keep your resolutions, and you review each file again. Other Git errors show plain copy, with the raw output under **Details**. A failed push is never resent; **Check again** only reads the branch.

### When the base branch moves

On a busy base branch, new commits land while you resolve. That alone does not block the push. When **Review and push…** or **Push merge commit** finds a newer base commit, Gnosis merges the PR head with it again, using the same fast preparation as opening the workspace, and moves your resolutions over:

- A conflict whose PR, base and ancestor text are unchanged keeps your result, whether you chose a side, edited it or accepted a suggestion. Edits you made around the conflicts are kept with a text merge.
- A file that conflicted before but now merges cleanly takes Git's clean result.
- **No new conflicts:** the preview or push goes ahead. The confirmation or the outcome says in one line that the base branch moved and the merge includes its latest changes.
- **New conflicts:** nothing is pushed. The workspace returns to the files, opens the first file with a new conflict, and says how many conflicts are new. Only those conflicts are open; files without new conflicts stay **Reviewed**.

If the base branch keeps moving, Gnosis tries three times and then asks you to try again. The push lease still checks the exact PR head, so a commit someone pushed to the PR in the meantime is never overwritten.

## Other states

- **Already up to date:** the PR branch already contains the base branch. There is nothing to merge.
- **No conflicts to resolve:** Git merges cleanly. **Review and push…** opens the confirmation.
- **The PR changed:** someone pushed to the PR branch, or the PR now targets another base branch. The draft cannot be pushed. **Load latest changes** prepares the merge again and keeps resolutions that still apply. New base commits alone do not make a draft stale.
- **Preparing:** progress shows inline. After about five seconds the workspace says that preparation continues in Activity, where it can also be cancelled.

## Restack dependent PRs

After the push, a stack can restack the PRs above this one. A paused restack uses the same conflict view, with **Updated parent** and **This PR** as the versions. Each prepared PR update has its **Reviewed** checkbox at its header. Continue stays disabled, with the reason beside it, until every update is reviewed. All branches are pushed together in one atomic push, or none are.

## Supported conflicts

This version handles regular UTF-8 text files with a common ancestor and both branch versions. Binary, rename/delete, file-mode and repository-structure conflicts require a local merge tool. The workspace explains unsupported files and prevents publication until all conflicts can be resolved. Limits are 100 conflicted files, 1 MB per file version, and 12 MB of combined conflict text.

Git 2.40 or newer must be installed and available to the app: preparation runs `git merge-tree --merge-base`. With an older Git, Resolve conflicts stops before it starts and says which version it found. Mergiraf 0.20.0 is bundled. Project tests are **not** run: agents receive the supplied ancestor, branch versions, current draft and PR context, without a checkout or test runner. The confirmation and proposal notes state this limitation.

## Storage and publication

All network, Git, model and disk work runs in Electron's backend. The renderer receives bounded text and parsed preview metadata. Editor code loads only when the workspace opens.

Drafts use the existing SQLite app-data store, scoped by GitHub account and PR URL. They are saved work, so clearing the GitHub cache does not delete them. No user checkout is created or changed.

Preparation asks GitHub for the merge base, then fetches only three commits (head, base and merge base) with `--depth=1 --filter=blob:none`. `git merge-tree --merge-base` merges them without history. The commits go into one bare repository per account and base repository, `userData/conflict-objects/stores/<hash>`, so a second PR in the same repository fetches only its new commits. Each PR keeps a small private repository under `userData/conflict-objects/sessions/<account-and-PR-hash>`. It borrows the store's objects through Git alternates, lists the three commits as shallow, and holds no branch refs. The store keeps one set of refs per session (`refs/gnosis/<session-hash>/…`), so its objects are never pruned while a session uses them. Fetches and ref updates in a store run one at a time. If a repository is linked in **Settings → Local clones**, its object directory is added as a read-only alternate, so commits that are already on disk are not downloaded. Gnosis finds that directory without running Git in the clone and never writes to it. File versions that the merge needs arrive on demand, as before.

If GitHub does not return a merge base, or a shallow fetch or merge fails, preparation falls back to the previous path: the whole history of both commits, without blobs, in the session's own repository. When there is one merge base, both paths label the common ancestor in conflict markers with the same 12-character abbreviation, so they write identical results. Restacking dependent PRs needs history. It fetches the full history into the session repository first, which costs what every preparation cost before.

On startup, Gnosis removes cache directories that no saved session needs: discarded sessions, published sessions without a paused or prepared restack, and full-history caches from earlier versions. A draft whose cache was removed rebuilds its merge from the shared store when it is previewed or published, and checks that the result is the same tree. A store is removed when no session borrows from it. The resolution memory (`conflict-objects/resolution-memory`) is not changed.

### Conflict resolution stats

**Settings → Diagnostics → Conflict resolution stats** counts how the buckets fare, so a later version can decide whether verified Merged conflicts may skip review by default. Nothing changes a default yet. For Merged, Check and Decide it counts the conflicts shown, accepted as is, undone, and changed to another option. It also counts the sessions started, started over and pushed, and shows the Merged undo rate. **Reset** sets every count to zero.

- **Shown:** each conflict of a fresh preparation that you open, once its checks have run. The bucket is saved with the draft, so a reopen does not count it again. Load latest changes keeps the conflicts that did not change.
- **Accepted as is:** a conflict pushed with its proposal unchanged. Decide has no proposal, so it shows "—".
- **Undone** and **changed to another option:** at most once per conflict and session. Undo of a Merged conflict is the signal for the Merged undo rate.

The stats are counts only, one record for the app in the local app-data store. There are no file contents, paths, file names, PR names or accounts, and nothing is sent anywhere. A count is written in the background and never delays Undo, Start over or Push. Restacks are not counted.

### Preparation in the background

When GitHub reports conflicts on a PR you wrote or starred, or on a PR whose page you open, Gnosis prepares it in the background, one PR at a time: the same fetch, merge, earlier resolutions, structural merge and checks as **Resolve conflicts**. Nothing is pushed. The PR's readiness line then says what is waiting, such as "3 files have conflicts. 7 of 9 conflicts are merged and checked. 2 need you.", or "Checking 3 files…" while it runs. When every conflict is merged and checked, the action reads **Review and push…**. If you can't push to the branch, the line says so and nothing is prepared. Opening the conflicts reuses the background draft while the PR head is the same, and the draft becomes yours. A new head or a clean merge removes it. Gnosis keeps the 8 newest background drafts, for at most a week, and removes the rest with their caches. Nothing starts on battery power, and a running preparation stops until the computer is on power again. Metered networks are not detected.

The checks run in the main process, in a worker thread, with the tree-sitter grammars the app ships. Each file's result is saved with the draft.

Mergiraf receives temporary files that Gnosis deletes after the operation. Upstream Mergiraf also retains a local attempt cache, capped at 128 attempts, in its platform application-data directory. This cache is shared with standalone Mergiraf; Gnosis does not delete it. The bundled executable, matching upstream source archive, license and build directions are under the app's `Resources/mergiraf` directory.

Preview and publish recheck account, permissions, repository, branch names, and both revisions. A new PR head or base branch blocks publication; a new base commit is merged again as described above. The merge commit has the original PR head as its first parent and the base commit it was merged with as its second. An exact-head Git push lease rejects concurrent PR updates. Protected-branch rules still apply. Publication cannot be cancelled once confirmed; reopening reconciles a successful push if its response or local status write was interrupted.

The preparation reads the live target branch tip (`baseRef.target.oid`), not the PR's historical `baseRefOid` snapshot. If Git can merge it cleanly, Gnosis says **No conflicts to resolve** and offers **Review and push…**. If the PR already contains that tip, Gnosis says that the branch already includes the base and prevents an unnecessary merge commit. Neither state means that Gnosis pushed anything.

## Testing the resolvers

The conflict lab (`tests/fixtures/conflicts`, `npm run conflict-lab`) runs real conflicts through the conflict service and checks the bucket of each conflict. Its README describes the cases and the generated matrix.

The resolver audit checks the checks. Each resolver and rule runs over the lab's cases as the service runs it: Mergiraf, unions of both sides' additions, the PR's version of a change both sides made, the rule for a side that only reformatted, earlier resolutions (each case's known-correct resolution, replayed as rerere would replay it) and whole-file proposals. Each result that passes the checks is then changed in one wrong way at a time:

| Mutation | What changes |
| --- | --- |
| `drop-definition` | A whole definition in the result is removed. |
| `duplicate-definition` | A whole definition is repeated after itself. |
| `broken-parse` | A line that does not parse is inserted. |
| `drop-pr-line`, `drop-main-line` | One line from the PR or from main is removed, a line that side added first. |
| `swap-order` | Two lines of one function body, both from one side, change places. |
| `interleave-sides` | A line only one side added moves inside the other side's added lines, or past them. |
| `cross-anchor` | A line one side changed moves past lines the other side inserted next to it, before or after it in the ancestor. |
| `change-number`, `change-string` | A number or a string in the result changes. |
| `touch-outside` | A number or a name that is not a keyword changes on a line next to the conflict, outside it, in the resolver's whole output. The output is then mapped onto Git's conflicts again. |

No mutation may end Merged, and a whole-file proposal may not pass its checks. A union is never Merged; the audit still counts a mutation the checks would not catch (`held`). An earlier resolution is your own resolution of the same conflict, so it may drop a side, reorder or edit lines on purpose (`own`). It is held only to parsing, no duplicated definition and no text outside the conflict.

```
npm run conflict-resolver-audit                 # the fixtures and one matrix case per pattern and language
npm run conflict-resolver-audit -- --all        # the whole matrix (about 75 s)
npm run conflict-resolver-audit -- --only ts-   # cases whose name contains "ts-"
```

It prints a table of resolver × mutation (caught, held, own, escaped), which check caught each mutation, and each escape with its case, file, conflict and mutated text. `npm test` runs the sample (`tests/conflict-resolver-audit.test.ts`, about 10 s), so CI runs it on every push. It needs Mergiraf (`npm run prepare:mergiraf`) and skips without it. When the audit finds an escape, fix the check so that it fails closed, and add the case to the lab.
