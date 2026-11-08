# Post-merge cleanup

Run this after every merged PR. It keeps local `main` in step with `origin/main`, removes merged branches and stale agent worktrees, and deletes build output, so the only app left is the one installed in `/Applications`.

## Sequence

1. Merge the PR on GitHub (squash, with `--delete-branch`).
2. If the change affects the desktop app, rebuild and reinstall it from the updated `main`. Do this before the cleanup, because the cleanup deletes `release/`, including the install backups that `scripts/install-mac.mjs` writes there.
3. Preview the cleanup, then apply it:

```bash
pnpm run cleanup:merged                          # dry run: prints the plan, changes nothing
pnpm run cleanup:merged -- --apply               # perform the plan
pnpm run cleanup:merged -- --apply --worktrees   # also remove stale agent worktrees
```

Run it from any checkout or worktree of the repository. It reads every worktree through the shared git directory.

## What it does

| Step               | Rule                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fetch              | `git fetch --prune origin`.                                                                                                                                                                                                                                                                                                           |
| `main`             | Fast-forward only. In the checkout that has `main`, it runs `git merge --ff-only`. Git keeps uncommitted work that does not overlap the incoming changes and refuses when it does; the script then reports the failure. Commit the work and re-run, because no stash is made. A `main` with local commits is reported and left alone. |
| Local branches     | Deleted when the tip is the head of a merged PR from the repository owner, or is already contained in `origin/main`. Squash merges are why the PR check is needed: `git branch --merged` does not see them. Kept when checked out in any worktree, or when it has commits added after its PR merged.                                  |
| Origin branches    | Deleted only when the tip equals the head of a merged PR. This removes branches left behind by merges done without `--delete-branch`.                                                                                                                                                                                                 |
| Agent worktrees    | Only those under `<main checkout>/.claude/worktrees/`. Removed with `--worktrees` when clean, unlocked and at a commit in `origin/main` or at a merged PR head. Without the flag they are listed as stale. Conductor workspaces are never removed; archive them in Conductor.                                                         |
| Build output       | `release/` in every worktree (packaged apps, dmg/zip files, install backups). `--keep-release` keeps it.                                                                                                                                                                                                                              |
| Smoke temp folders | `quota-pack-*`, `quota-consumer-*`, `quota-packaged-*`, `quota-account-processes-*` and `quota-history-compat-*` in the system temp directory, when older than an hour. Each smoke script removes its own folder on success, so leftovers come from interrupted runs. A recent folder may belong to a run in progress and is kept.    |

`/Applications/Token Watcher.app`, `node_modules/`, `dist/`, Electron download caches and archived release evidence outside the repository are not touched.

## Safety limits

- Merged-PR facts come from `gh pr list -R <owner>/<repo> --state merged`, with the repository taken from the `origin` URL. If `gh` fails, the script warns and falls back to the `origin/main` containment rule for local branches, and deletes no origin branches.
- `git worktree remove` is run without `--force`, so git itself refuses a worktree with changes that appeared after the plan was made.
- A worktree that another agent session has just created can be clean and at `main`. `--worktrees` is opt-in for that reason; check the stale list first if other sessions are running.

## Tests

`tests/scripts.post-merge-cleanup.test.ts` covers the planning rules in `scripts/lib/post-merge-cleanup.mjs`: squash-merged and moved branches, checked-out branches, other forks reusing a branch name, main fast-forward and divergence, the worktree rules and the temp-folder age limit. The `--apply` path was checked on 2026-11-08 against a throwaway repository with a bare origin: `main` was fast-forwarded while keeping an untracked file, the merged branch, clean agent worktree and `release/` were removed, and the unmerged branch and dirty worktree were kept.
