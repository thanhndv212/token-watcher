import { describe, expect, it } from "vitest";

import {
  MIN_TEMP_AGE_MS,
  isPlanEmpty,
  parseWorktrees,
  planCleanup,
} from "../scripts/lib/post-merge-cleanup.mjs";

const MAIN = "/repo";
const AGENT = "/repo/.claude/worktrees";
const NOW = 1_800_000_000_000;

function baseState(overrides: Record<string, unknown> = {}) {
  return {
    mainBranch: "main",
    repoOwner: "owner",
    worktrees: [{ path: MAIN, head: "m1", branch: "main" }],
    currentPath: MAIN,
    localBranches: [{ name: "main", sha: "m1" }],
    remoteBranches: [{ name: "main", sha: "m1" }],
    mergedPrs: [],
    isAncestorOfMain: () => false,
    dirtyWorktrees: new Set<string>(),
    mainStatus: { localSha: "m1", remoteSha: "m1", ahead: 0, behind: 0 },
    now: NOW,
    ...overrides,
  };
}

describe("parseWorktrees", () => {
  it("reads branches, detached heads and flags", () => {
    const porcelain = [
      "worktree /repo",
      "HEAD aaa",
      "branch refs/heads/main",
      "",
      "worktree /repo/.claude/worktrees/x",
      "HEAD bbb",
      "detached",
      "locked in use",
      "",
      "worktree /gone",
      "HEAD ccc",
      "branch refs/heads/feature/a",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n");
    expect(parseWorktrees(porcelain)).toEqual([
      expect.objectContaining({ path: "/repo", head: "aaa", branch: "main", detached: false }),
      expect.objectContaining({ path: "/repo/.claude/worktrees/x", detached: true, locked: true }),
      expect.objectContaining({ path: "/gone", branch: "feature/a", prunable: true }),
    ]);
  });
});

describe("planCleanup branches", () => {
  it("deletes a branch whose tip is a merged PR head (squash merge)", () => {
    const plan = planCleanup(
      baseState({
        localBranches: [
          { name: "main", sha: "m1" },
          { name: "feat", sha: "f1" },
        ],
        mergedPrs: [{ number: 7, headRefName: "feat", headRefOid: "f1", headOwner: "owner" }],
      }),
    );
    expect(plan.deleteLocal).toEqual([{ name: "feat", sha: "f1", reason: "PR #7 merged" }]);
  });

  it("keeps a branch that gained commits after its PR merged", () => {
    const plan = planCleanup(
      baseState({
        localBranches: [{ name: "feat", sha: "f2" }],
        mergedPrs: [{ number: 7, headRefName: "feat", headRefOid: "f1", headOwner: "owner" }],
      }),
    );
    expect(plan.deleteLocal).toEqual([]);
    expect(plan.keepLocal).toEqual([{ name: "feat", reason: "has commits after merged PR #7" }]);
  });

  it("deletes a branch already contained in origin/main", () => {
    const plan = planCleanup(
      baseState({
        localBranches: [{ name: "old", sha: "o1" }],
        isAncestorOfMain: (sha: string) => sha === "o1",
      }),
    );
    expect(plan.deleteLocal.map((b) => b.name)).toEqual(["old"]);
  });

  it("never deletes main or a branch checked out in a worktree", () => {
    const plan = planCleanup(
      baseState({
        worktrees: [
          { path: MAIN, head: "m1", branch: "main" },
          { path: "/ws/a", head: "f1", branch: "feat" },
        ],
        localBranches: [
          { name: "main", sha: "m1" },
          { name: "feat", sha: "f1" },
        ],
        mergedPrs: [{ number: 7, headRefName: "feat", headRefOid: "f1", headOwner: "owner" }],
        isAncestorOfMain: () => true,
      }),
    );
    expect(plan.deleteLocal).toEqual([]);
    expect(plan.keepLocal).toEqual([{ name: "feat", reason: "checked out in /ws/a" }]);
  });

  it("ignores merged PRs from other forks that reuse a branch name", () => {
    const plan = planCleanup(
      baseState({
        localBranches: [{ name: "fix", sha: "x1" }],
        remoteBranches: [{ name: "fix", sha: "x1" }],
        mergedPrs: [{ number: 3, headRefName: "fix", headRefOid: "x1", headOwner: "someone" }],
      }),
    );
    expect(plan.deleteLocal).toEqual([]);
    expect(plan.deleteRemote).toEqual([]);
  });

  it("deletes origin branches only when the tip equals the merged PR head", () => {
    const plan = planCleanup(
      baseState({
        remoteBranches: [
          { name: "main", sha: "m1" },
          { name: "done", sha: "d1" },
          { name: "moved", sha: "v2" },
          { name: "open", sha: "p1" },
        ],
        mergedPrs: [
          { number: 1, headRefName: "done", headRefOid: "d1", headOwner: "owner" },
          { number: 2, headRefName: "moved", headRefOid: "v1", headOwner: "owner" },
        ],
        isAncestorOfMain: () => true,
      }),
    );
    expect(plan.deleteRemote).toEqual([{ name: "done", sha: "d1", reason: "PR #1 merged" }]);
  });
});

describe("planCleanup main fast-forward", () => {
  it("fast-forwards the checked-out main when only behind", () => {
    const plan = planCleanup(
      baseState({
        dirtyWorktrees: new Set([MAIN]),
        mainStatus: { localSha: "m0", remoteSha: "m1", ahead: 0, behind: 3 },
      }),
    );
    expect(plan.fastForward).toEqual({
      action: "merge",
      path: MAIN,
      from: "m0",
      to: "m1",
      behind: 3,
      dirty: true,
    });
  });

  it("updates the ref when main is not checked out anywhere", () => {
    const plan = planCleanup(
      baseState({
        worktrees: [{ path: MAIN, head: "f1", branch: "feat" }],
        mainStatus: { localSha: "m0", remoteSha: "m1", ahead: 0, behind: 1 },
      }),
    );
    expect(plan.fastForward).toMatchObject({ action: "update-ref", path: null });
  });

  it("refuses to move a diverged main", () => {
    const plan = planCleanup(
      baseState({ mainStatus: { localSha: "m0", remoteSha: "m1", ahead: 2, behind: 1 } }),
    );
    expect(plan.fastForward).toMatchObject({ action: "skip" });
  });
});

describe("planCleanup worktrees", () => {
  const worktrees = [
    { path: MAIN, head: "m1", branch: "main" },
    { path: `${AGENT}/stale`, head: "s1", branch: null, detached: true },
    { path: `${AGENT}/dirty`, head: "s1", branch: null, detached: true },
    { path: `${AGENT}/ahead`, head: "n1", branch: null, detached: true },
    { path: `${AGENT}/locked`, head: "s1", branch: null, detached: true, locked: true },
    { path: "/conductor/ws", head: "s1", branch: null, detached: true },
  ];
  const state = {
    worktrees,
    dirtyWorktrees: new Set([`${AGENT}/dirty`]),
    isAncestorOfMain: (sha: string) => sha !== "n1",
  };

  it("lists stale agent worktrees but removes none without --worktrees", () => {
    const plan = planCleanup(baseState(state));
    expect(plan.removeWorktrees).toEqual([]);
    expect(plan.keepWorktrees).toEqual([
      { path: `${AGENT}/stale`, reason: "stale; pass --worktrees to remove" },
      { path: `${AGENT}/dirty`, reason: "has uncommitted or untracked changes" },
      { path: `${AGENT}/ahead`, reason: "HEAD not in origin/main or a merged PR" },
      { path: `${AGENT}/locked`, reason: "locked" },
      { path: "/conductor/ws", reason: "not an agent worktree" },
    ]);
  });

  it("removes only clean, merged agent worktrees with --worktrees", () => {
    const plan = planCleanup(baseState({ ...state, includeWorktrees: true }));
    expect(plan.removeWorktrees).toEqual([{ path: `${AGENT}/stale`, branch: null }]);
  });

  it("treats a worktree at a squash-merged PR head as merged", () => {
    const plan = planCleanup(
      baseState({
        ...state,
        includeWorktrees: true,
        mergedPrs: [{ number: 9, headRefName: "x", headRefOid: "n1", headOwner: "owner" }],
      }),
    );
    expect(plan.removeWorktrees.map((wt) => wt.path)).toEqual([`${AGENT}/stale`, `${AGENT}/ahead`]);
  });

  it("never removes the current worktree", () => {
    const plan = planCleanup(
      baseState({ ...state, currentPath: `${AGENT}/stale`, includeWorktrees: true }),
    );
    expect(plan.removeWorktrees).toEqual([]);
  });
});

describe("planCleanup directories", () => {
  it("removes release/ dirs and only stale smoke temp dirs", () => {
    const plan = planCleanup(
      baseState({
        releaseDirs: ["/repo/release"],
        tempEntries: [
          { name: "quota-packaged-abc", path: "/tmp/quota-packaged-abc", mtimeMs: 0 },
          {
            name: "quota-consumer-new",
            path: "/tmp/quota-consumer-new",
            mtimeMs: NOW - MIN_TEMP_AGE_MS / 2,
          },
          { name: "electron-download-x", path: "/tmp/electron-download-x", mtimeMs: 0 },
        ],
      }),
    );
    expect(plan.removeDirs.map((d) => d.path)).toEqual([
      "/repo/release",
      "/tmp/quota-packaged-abc",
    ]);
  });

  it("keeps release/ with --keep-release", () => {
    const plan = planCleanup(baseState({ releaseDirs: ["/repo/release"], includeRelease: false }));
    expect(plan.removeDirs).toEqual([]);
    expect(isPlanEmpty(plan)).toBe(true);
  });
});
