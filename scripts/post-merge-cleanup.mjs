#!/usr/bin/env node
// Post-merge cleanup: fast-forward main, delete merged branches (local and origin), drop
// build output and stale smoke temp directories, and optionally remove stale agent
// worktrees. Prints the plan by default; changes nothing without --apply.
//
//   pnpm run cleanup:merged                       # dry run
//   pnpm run cleanup:merged -- --apply            # do it
//   pnpm run cleanup:merged -- --apply --worktrees
//
// The app installed in /Applications is never touched. Rebuild it from main first; see
// docs/POST_MERGE_CLEANUP.md.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { isPlanEmpty, parseWorktrees, planCleanup } from "./lib/post-merge-cleanup.mjs";

const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (!["--apply", "--worktrees", "--keep-release", "--help", "-h"].includes(arg)) {
    console.error(`Unknown option: ${arg}`);
    process.exit(2);
  }
}
if (args.has("--help") || args.has("-h")) {
  console.log(
    "Usage: post-merge-cleanup [--apply] [--worktrees] [--keep-release]\n" +
      "  --apply         perform the plan (default: print it only)\n" +
      "  --worktrees     also remove clean agent worktrees already contained in main\n" +
      "  --keep-release  keep release/ build output",
  );
  process.exit(0);
}
const apply = args.has("--apply");

const git = (cwd, gitArgs) =>
  execFileSync("git", ["-C", cwd, ...gitArgs], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const gitOk = (cwd, gitArgs) =>
  spawnSync("git", ["-C", cwd, ...gitArgs], { stdio: "ignore" }).status === 0;

const cwd = git(process.cwd(), ["rev-parse", "--show-toplevel"]);

console.log("Fetching origin (with prune)...");
execFileSync("git", ["-C", cwd, "fetch", "--prune", "origin"], { stdio: "inherit" });

let mainBranch = "main";
try {
  mainBranch = git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).replace(
    /^origin\//,
    "",
  );
} catch {}
const remoteMain = `refs/remotes/origin/${mainBranch}`;

const originUrl = git(cwd, ["remote", "get-url", "origin"]);
const repoMatch = originUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
const repo = repoMatch ? `${repoMatch[1]}/${repoMatch[2]}` : null;

const worktrees = parseWorktrees(git(cwd, ["worktree", "list", "--porcelain"]));
const dirtyWorktrees = new Set();
for (const wt of worktrees) {
  if (wt.prunable || wt.bare || !existsSync(wt.path)) continue;
  if (git(wt.path, ["status", "--porcelain"]) !== "") dirtyWorktrees.add(wt.path);
}

const refs = (prefix) =>
  git(cwd, ["for-each-ref", "--format=%(refname) %(objectname)", prefix])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref, sha] = line.split(" ");
      return { name: ref.slice(prefix.length), sha };
    });
const localBranches = refs("refs/heads/");
const remoteBranches = refs("refs/remotes/origin/").filter((b) => b.name !== "HEAD");

let mergedPrs = [];
if (repo) {
  const result = spawnSync(
    "gh",
    [
      "pr",
      "list",
      "-R",
      repo,
      "--state",
      "merged",
      "--limit",
      "500",
      "--json",
      "number,headRefName,headRefOid,headRepositoryOwner",
    ],
    { encoding: "utf8" },
  );
  if (result.status === 0) {
    mergedPrs = JSON.parse(result.stdout).map((pr) => ({
      number: pr.number,
      headRefName: pr.headRefName,
      headRefOid: pr.headRefOid,
      headOwner: pr.headRepositoryOwner?.login ?? null,
    }));
  } else {
    console.warn(
      "warning: gh pr list failed; only branches contained in main will be deleted and no remote branches.",
    );
  }
}

const ancestorCache = new Map();
const isAncestorOfMain = (sha) => {
  if (!ancestorCache.has(sha))
    ancestorCache.set(sha, gitOk(cwd, ["merge-base", "--is-ancestor", sha, remoteMain]));
  return ancestorCache.get(sha);
};

let mainStatus = null;
const localMain = localBranches.find((b) => b.name === mainBranch);
const remoteMainSha = remoteBranches.find((b) => b.name === mainBranch)?.sha;
if (remoteMainSha) {
  let ahead = 0;
  let behind = 0;
  if (localMain) {
    [ahead, behind] = git(cwd, [
      "rev-list",
      "--left-right",
      "--count",
      `refs/heads/${mainBranch}...${remoteMain}`,
    ])
      .split(/\s+/)
      .map(Number);
  }
  mainStatus = { localSha: localMain?.sha ?? null, remoteSha: remoteMainSha, ahead, behind };
}

const releaseDirs = worktrees
  .filter((wt) => !wt.prunable && !wt.bare)
  .map((wt) => path.join(wt.path, "release"))
  .filter((dir) => existsSync(dir));

const tmp = tmpdir();
const tempEntries = readdirSync(tmp, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => {
    const full = path.join(tmp, entry.name);
    try {
      return [{ name: entry.name, path: full, mtimeMs: statSync(full).mtimeMs }];
    } catch {
      return [];
    }
  });

const plan = planCleanup({
  mainBranch,
  repoOwner: repoMatch?.[1] ?? null,
  worktrees,
  currentPath: cwd,
  localBranches,
  remoteBranches,
  mergedPrs,
  isAncestorOfMain,
  dirtyWorktrees,
  mainStatus,
  includeWorktrees: args.has("--worktrees"),
  includeRelease: !args.has("--keep-release"),
  releaseDirs,
  tempEntries,
});

const short = (sha) => (sha ? sha.slice(0, 8) : "?");
const section = (title, items, format) => {
  if (items.length === 0) return;
  console.log(`\n${title}`);
  for (const item of items) console.log(`  ${format(item)}`);
};

console.log(`\nPost-merge cleanup plan (${apply ? "apply" : "dry run"})`);
const ff = plan.fastForward;
if (ff) {
  if (ff.action === "merge" || ff.action === "update-ref") {
    console.log(
      `\n${mainBranch}: fast-forward ${short(ff.from)} -> ${short(ff.to)} (${ff.behind} behind)` +
        (ff.path ? ` in ${ff.path}` : "") +
        (ff.dirty ? " [has local changes; kept if they do not overlap]" : ""),
    );
  } else {
    console.log(`\n${mainBranch}: ${ff.reason}`);
  }
}
section("Delete local branches", plan.deleteLocal, (b) => `${b.name} (${b.reason})`);
section("Delete origin branches", plan.deleteRemote, (b) => `origin/${b.name} (${b.reason})`);
section(
  "Remove worktrees",
  plan.removeWorktrees,
  (wt) => wt.path + (wt.branch ? ` [${wt.branch}]` : ""),
);
section("Remove directories", plan.removeDirs, (d) => `${d.path} (${d.reason})`);
section("Kept branches", plan.keepLocal, (b) => `${b.name}: ${b.reason}`);
section("Kept worktrees", plan.keepWorktrees, (wt) => `${wt.path}: ${wt.reason}`);

if (isPlanEmpty(plan)) {
  console.log("\nNothing to clean up.");
  process.exit(0);
}
if (!apply) {
  console.log("\nDry run only. Re-run with --apply to perform this plan.");
  process.exit(0);
}

const failures = [];
const attempt = (label, fn) => {
  try {
    fn();
  } catch (error) {
    failures.push(`${label}: ${error.stderr?.toString().trim() || error.message}`);
  }
};

if (ff?.action === "merge") {
  attempt(`fast-forward ${mainBranch}`, () =>
    execFileSync("git", ["-C", ff.path, "merge", "--ff-only", remoteMain], { stdio: "pipe" }),
  );
} else if (ff?.action === "update-ref") {
  attempt(`fast-forward ${mainBranch}`, () =>
    git(cwd, ["update-ref", `refs/heads/${mainBranch}`, ff.to, ff.from]),
  );
}
for (const wt of plan.removeWorktrees) {
  attempt(`remove worktree ${wt.path}`, () => git(cwd, ["worktree", "remove", wt.path]));
}
for (const branch of plan.deleteLocal) {
  // `-D` is safe here: the plan only lists branches whose tip is merged or in main.
  attempt(`delete ${branch.name}`, () => git(cwd, ["branch", "-D", branch.name]));
}
if (plan.deleteRemote.length > 0) {
  attempt("delete origin branches", () =>
    execFileSync(
      "git",
      ["-C", cwd, "push", "origin", "--delete", ...plan.deleteRemote.map((b) => b.name)],
      { stdio: "pipe" },
    ),
  );
}
for (const dir of plan.removeDirs) {
  attempt(`remove ${dir.path}`, () => rmSync(dir.path, { recursive: true, force: true }));
}
attempt("prune worktrees", () => git(cwd, ["worktree", "prune"]));
attempt("prune remote refs", () => git(cwd, ["fetch", "--prune", "origin"]));

if (failures.length > 0) {
  console.error("\nSome steps failed:");
  for (const failure of failures) console.error(`  ${failure}`);
  if (ff?.action === "merge" && failures.some((f) => f.startsWith("fast-forward"))) {
    console.error(
      `  Local changes in ${ff.path} overlap the incoming ${mainBranch}; commit them, then re-run.`,
    );
  }
  process.exit(1);
}
console.log("\nCleanup complete.");
