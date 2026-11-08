import path from "node:path";

// Temp-directory prefixes created by this repo's smoke and package scripts. Each script
// removes its own directory on success; an interrupted run leaves one behind.
export const SMOKE_TEMP_PREFIXES = [
  "quota-pack-",
  "quota-consumer-",
  "quota-packaged-",
  "quota-account-processes-",
  "quota-history-compat-",
];

// A smoke run in progress keeps writing to its directory, so only stale ones are removed.
export const MIN_TEMP_AGE_MS = 60 * 60 * 1000;

/** Parses `git worktree list --porcelain`. The first entry is the main checkout. */
export function parseWorktrees(porcelain) {
  const worktrees = [];
  let current = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = {
        path: line.slice("worktree ".length),
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      };
      worktrees.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true;
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      current.prunable = true;
    }
  }
  return worktrees;
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Decides what a post-merge cleanup removes. Pure: every fact about git, GitHub and the
 * filesystem is gathered by the caller, so the safety rules can be tested directly.
 *
 * Safety rules:
 * - A branch is deleted only when its tip is the head of a merged PR from this repo's owner,
 *   or is already contained in the remote main branch. A merged PR whose branch moved on
 *   afterwards keeps the branch, because the extra commits are unmerged.
 * - A branch checked out in any worktree is never deleted.
 * - A remote branch is deleted only when its tip equals a merged PR head.
 * - Only agent worktrees under `<main checkout>/.claude/worktrees/` are candidates for
 *   removal, and only when clean, unlocked and at a commit contained in the remote main
 *   branch or at the head of a merged PR (a squash merge leaves that commit outside main).
 *   Conductor workspaces are managed by Conductor and are never removed here.
 */
export function planCleanup(state) {
  const {
    mainBranch,
    repoOwner,
    worktrees,
    currentPath,
    localBranches,
    remoteBranches,
    mergedPrs,
    isAncestorOfMain,
    dirtyWorktrees = new Set(),
    mainStatus,
    includeWorktrees = false,
    includeRelease = true,
    releaseDirs = [],
    tempEntries = [],
    now = Date.now(),
  } = state;

  const mergedByBranch = new Map();
  for (const pr of mergedPrs) {
    if (repoOwner && pr.headOwner && pr.headOwner !== repoOwner) continue;
    const list = mergedByBranch.get(pr.headRefName) ?? [];
    list.push(pr);
    mergedByBranch.set(pr.headRefName, list);
  }
  const mergedPrForTip = (name, sha) =>
    (mergedByBranch.get(name) ?? []).find((pr) => pr.headRefOid === sha);

  const checkedOut = new Map();
  for (const wt of worktrees) if (wt.branch) checkedOut.set(wt.branch, wt.path);

  const plan = {
    fastForward: null,
    deleteLocal: [],
    keepLocal: [],
    deleteRemote: [],
    removeWorktrees: [],
    keepWorktrees: [],
    removeDirs: [],
  };

  // Main branch: fast-forward only. Diverged or overlapping local work is reported, not moved.
  if (mainStatus) {
    const { localSha, remoteSha, ahead, behind } = mainStatus;
    const mainWorktree = worktrees.find((wt) => wt.branch === mainBranch);
    if (!localSha) {
      plan.fastForward = { action: "skip", reason: `no local ${mainBranch} branch` };
    } else if (behind === 0) {
      plan.fastForward = { action: "none", reason: `${mainBranch} is up to date` };
    } else if (ahead > 0) {
      plan.fastForward = {
        action: "skip",
        reason: `${mainBranch} has ${ahead} local commit(s) not on origin; reconcile by hand`,
      };
    } else {
      plan.fastForward = {
        action: mainWorktree ? "merge" : "update-ref",
        path: mainWorktree?.path ?? null,
        from: localSha,
        to: remoteSha,
        behind,
        dirty: mainWorktree ? dirtyWorktrees.has(mainWorktree.path) : false,
      };
    }
  }

  for (const { name, sha } of localBranches) {
    if (name === mainBranch) continue;
    if (checkedOut.has(name)) {
      plan.keepLocal.push({ name, reason: `checked out in ${checkedOut.get(name)}` });
      continue;
    }
    const pr = mergedPrForTip(name, sha);
    if (pr) {
      plan.deleteLocal.push({ name, sha, reason: `PR #${pr.number} merged` });
    } else if (isAncestorOfMain(sha)) {
      plan.deleteLocal.push({ name, sha, reason: `contained in origin/${mainBranch}` });
    } else if (mergedByBranch.has(name)) {
      const numbers = mergedByBranch.get(name).map((p) => `#${p.number}`);
      plan.keepLocal.push({
        name,
        reason: `has commits after merged PR ${numbers.join(", ")}`,
      });
    } else {
      plan.keepLocal.push({ name, reason: "not merged" });
    }
  }

  for (const { name, sha } of remoteBranches) {
    if (name === mainBranch || name === "HEAD") continue;
    const pr = mergedPrForTip(name, sha);
    if (pr) plan.deleteRemote.push({ name, sha, reason: `PR #${pr.number} merged` });
  }

  const mainCheckout = worktrees[0]?.path;
  const agentRoot = mainCheckout ? path.join(mainCheckout, ".claude", "worktrees") : null;
  const deletedBranches = new Set(plan.deleteLocal.map((b) => b.name));
  const mergedHeads = new Set([...mergedByBranch.values()].flat().map((pr) => pr.headRefOid));
  const headMerged = (sha) => Boolean(sha) && (mergedHeads.has(sha) || isAncestorOfMain(sha));
  for (const wt of worktrees.slice(1)) {
    if (wt.prunable) continue; // `git worktree prune` handles missing directories.
    let reason = null;
    if (wt.path === currentPath) reason = "current worktree";
    else if (!agentRoot || !isInside(wt.path, agentRoot)) reason = "not an agent worktree";
    else if (wt.locked) reason = "locked";
    else if (dirtyWorktrees.has(wt.path)) reason = "has uncommitted or untracked changes";
    else if (!headMerged(wt.head)) reason = `HEAD not in origin/${mainBranch} or a merged PR`;
    else if (wt.branch && !deletedBranches.has(wt.branch)) reason = `branch ${wt.branch} kept`;
    if (reason) plan.keepWorktrees.push({ path: wt.path, reason });
    else if (includeWorktrees) plan.removeWorktrees.push({ path: wt.path, branch: wt.branch });
    else plan.keepWorktrees.push({ path: wt.path, reason: "stale; pass --worktrees to remove" });
  }

  // A removed worktree takes its release/ directory with it.
  const removedPaths = new Set(plan.removeWorktrees.map((wt) => wt.path));
  for (const dir of releaseDirs) {
    if (!includeRelease) break;
    if ([...removedPaths].some((p) => dir === path.join(p, "release"))) continue;
    plan.removeDirs.push({ path: dir, reason: "build output (release/)" });
  }
  for (const entry of tempEntries) {
    if (!SMOKE_TEMP_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
    if (now - entry.mtimeMs < MIN_TEMP_AGE_MS) continue;
    plan.removeDirs.push({ path: entry.path, reason: "stale smoke temp directory" });
  }

  return plan;
}

export function isPlanEmpty(plan) {
  return (
    (!plan.fastForward ||
      plan.fastForward.action === "none" ||
      plan.fastForward.action === "skip") &&
    plan.deleteLocal.length === 0 &&
    plan.deleteRemote.length === 0 &&
    plan.removeWorktrees.length === 0 &&
    plan.removeDirs.length === 0
  );
}
