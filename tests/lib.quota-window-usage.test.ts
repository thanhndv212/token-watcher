import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { describe, expect, it } from "vitest";

import {
  buildWindowInstances,
  normalizeWindowKind,
  placeUsageOnQuotaWindows,
  quotaProviderFor,
  readQuotaWindowObservations,
  windowsInRange,
  type QuotaWindowObservation,
  type WindowUsageResponse,
} from "../src/lib/quota-window-usage.js";

const H = 3_600_000;
const T0 = Date.parse("2026-10-30T00:00:00Z");

function obs(over: Partial<QuotaWindowObservation> & { resetsAtMs: number; observedAtMs: number }) {
  return {
    provider: "anthropic",
    account: "unknown",
    kind: "5h:",
    group: "Claude",
    model: null,
    percentUsed: 10,
    ...over,
  } satisfies QuotaWindowObservation;
}

function resp(createdMs: number | null, over: Partial<WindowUsageResponse> = {}) {
  return {
    providerID: "anthropic",
    createdMs,
    sessionKey: "claude-code\u0000s1",
    source: "claude-code",
    totalTokens: 100,
    ...over,
  } satisfies WindowUsageResponse;
}

describe("buildWindowInstances", () => {
  it("clusters jittered reset times into one instance ending at the latest reset", () => {
    const instances = buildWindowInstances([
      obs({ observedAtMs: T0 + 1 * H, resetsAtMs: T0 + 5 * H - 480, percentUsed: 10 }),
      obs({ observedAtMs: T0 + 2 * H, resetsAtMs: T0 + 5 * H + 232, percentUsed: 30 }),
    ]);
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({
      window: "5h",
      startMs: T0 + 232,
      endMs: T0 + 5 * H + 232,
      startMethod: "duration",
      percentUsed: 30,
      observedAtMs: T0 + 2 * H,
      observations: 2,
      concurrent: false,
    });
  });

  it("starts unknown-length windows at the previous reset, or the first observation", () => {
    const instances = buildWindowInstances([
      obs({ kind: "Monthly:", observedAtMs: T0, resetsAtMs: T0 + 100 * H }),
      obs({ kind: "Monthly:", observedAtMs: T0 + 101 * H, resetsAtMs: T0 + 800 * H }),
    ]);
    expect(instances.map((i) => [i.startMs, i.endMs, i.startMethod])).toEqual([
      [T0, T0 + 100 * H, "first-observation"],
      [T0 + 100 * H, T0 + 800 * H, "previous-reset"],
    ]);
  });

  it("clips a known-length window at an earlier reset instead of overlapping it", () => {
    // An early reset: the weekly window reset after 3 days, then a new week began.
    const instances = buildWindowInstances([
      obs({ kind: "Weekly:", observedAtMs: T0, resetsAtMs: T0 + 72 * H }),
      obs({ kind: "Weekly:", observedAtMs: T0 + 73 * H, resetsAtMs: T0 + 100 * H }),
    ]);
    expect(instances.map((i) => [i.startMs, i.endMs])).toEqual([
      [T0 + 72 * H - 168 * H, T0 + 72 * H],
      [T0 + 72 * H, T0 + 100 * H],
    ]);
  });

  it("flags instances observed live at the same time as mixed accounts", () => {
    const instances = buildWindowInstances([
      obs({ kind: "Weekly:", observedAtMs: T0, resetsAtMs: T0 + 24 * H, percentUsed: 37 }),
      obs({ kind: "Weekly:", observedAtMs: T0 + 1 * H, resetsAtMs: T0 + 60 * H, percentUsed: 64 }),
      obs({ kind: "Weekly:", observedAtMs: T0 + 2 * H, resetsAtMs: T0 + 24 * H, percentUsed: 38 }),
    ]);
    expect(instances.map((i) => i.concurrent)).toEqual([true, true]);
  });

  it("keeps accounts and model-scoped limits in separate series", () => {
    const instances = buildWindowInstances([
      obs({ account: "a".repeat(64), observedAtMs: T0, resetsAtMs: T0 + 5 * H }),
      obs({ account: "b".repeat(64), observedAtMs: T0, resetsAtMs: T0 + 3 * H }),
      obs({ model: "opus", observedAtMs: T0, resetsAtMs: T0 + 4 * H }),
    ]);
    expect(instances).toHaveLength(3);
    expect(instances.every((i) => !i.concurrent)).toBe(true);
  });
});

describe("placeUsageOnQuotaWindows", () => {
  const twoWindowsWithGap = [
    // First 5h window [T0, T0+5h), then a gap with no recorded window, then [T0+8h, T0+13h).
    obs({ observedAtMs: T0 + 1 * H, resetsAtMs: T0 + 5 * H, percentUsed: 40 }),
    obs({ observedAtMs: T0 + 9 * H, resetsAtMs: T0 + 13 * H, percentUsed: 15 }),
    obs({ kind: "Weekly:", observedAtMs: T0 + 1 * H, resetsAtMs: T0 + 100 * H, percentUsed: 5 }),
  ];

  it("sums responses into the window open at each response, across a reset and a gap", () => {
    const result = placeUsageOnQuotaWindows(twoWindowsWithGap, [
      resp(T0 + 1 * H),
      resp(T0 + 4 * H, { sessionKey: "codex\u0000s2", source: "codex", providerID: "Anthropic" }),
      resp(T0 + 6 * H, { totalTokens: 7 }), // in the gap
      resp(T0 + 9 * H, { totalTokens: 50 }),
    ]);
    const fiveHour = result.windows.filter((w) => w.window === "5h");
    expect(fiveHour.map((w) => [w.startMs, w.responses, w.sessions, w.totalTokens])).toEqual([
      [T0, 2, 2, 200],
      [T0 + 8 * H, 1, 1, 50],
    ]);
    expect(fiveHour[0]!.bySource).toEqual([
      { source: "claude-code", responses: 1, totalTokens: 100 },
      { source: "codex", responses: 1, totalTokens: 100 },
    ]);
    expect(fiveHour[0]!.percentUsed).toBe(40);

    const weekly = result.windows.find((w) => w.window === "weekly")!;
    expect(weekly).toMatchObject({ responses: 4, totalTokens: 257 });

    expect(result.unattributed).toEqual([
      {
        provider: "anthropic",
        window: "5h",
        reason: "outside-known-windows",
        responses: 1,
        totalTokens: 7,
      },
    ]);
  });

  it("leaves usage unattributed when no window covers it, never assigning it", () => {
    const result = placeUsageOnQuotaWindows(twoWindowsWithGap, [
      resp(T0 - 200 * H),
      resp(T0 + 1 * H, { providerID: "zai" }),
      resp(null),
      resp(T0, { providerID: null }),
    ]);
    expect(result.windows.every((w) => w.responses === 0)).toBe(true);
    expect(result.unattributed.map((u) => [u.provider, u.window, u.reason, u.responses])).toEqual([
      [null, null, "no-provider-or-time", 1],
      ["anthropic", null, "no-provider-or-time", 1],
      ["anthropic", "5h", "outside-known-windows", 1],
      ["anthropic", "weekly", "outside-known-windows", 1],
      ["zai", null, "no-window", 1],
    ]);
  });

  it("does not pick an account when windows of two accounts cover a response", () => {
    const result = placeUsageOnQuotaWindows(
      [
        obs({ account: "a".repeat(64), observedAtMs: T0, resetsAtMs: T0 + 5 * H }),
        obs({ account: "b".repeat(64), observedAtMs: T0, resetsAtMs: T0 + 3 * H }),
      ],
      [resp(T0 + 1 * H), resp(T0 + 4 * H)],
    );
    expect(result.unattributed).toEqual([
      {
        provider: "anthropic",
        window: "5h",
        reason: "ambiguous-account",
        responses: 1,
        totalTokens: 100,
      },
    ]);
    // Only the a-account window was open at T0+4h.
    expect(result.windows.map((w) => [w.account[0], w.responses])).toEqual([
      ["a", 1],
      ["b", 0],
    ]);
  });

  it("does not place usage in windows of accounts that were not told apart", () => {
    const result = placeUsageOnQuotaWindows(
      [
        obs({ kind: "Weekly:", observedAtMs: T0, resetsAtMs: T0 + 24 * H }),
        obs({ kind: "Weekly:", observedAtMs: T0 + 1 * H, resetsAtMs: T0 + 60 * H }),
        obs({ kind: "Weekly:", observedAtMs: T0 + 2 * H, resetsAtMs: T0 + 24 * H }),
      ],
      [resp(T0 + 3 * H)],
    );
    expect(result.windows.every((w) => w.responses === 0 && w.concurrent)).toBe(true);
    expect(result.unattributed[0]).toMatchObject({ reason: "ambiguous-account", responses: 1 });
  });

  it("maps session provider ids to quota provider ids", () => {
    expect(quotaProviderFor("github-copilot")).toBe("copilot");
    expect(quotaProviderFor("OpenAI")).toBe("openai");
    const result = placeUsageOnQuotaWindows(
      [obs({ provider: "copilot", kind: "Quota:", observedAtMs: T0, resetsAtMs: T0 + 10 * H })],
      [resp(T0 + 1 * H, { providerID: "github-copilot" })],
    );
    expect(result.windows[0]).toMatchObject({ provider: "copilot", window: "quota", responses: 1 });
  });
});

describe("helpers", () => {
  it("normalises recorded limit kinds", () => {
    expect(["5h:", "Weekly:", " Monthly: ", "Quota:"].map(normalizeWindowKind)).toEqual([
      "5h",
      "weekly",
      "monthly",
      "quota",
    ]);
  });

  it("keeps only windows overlapping the report range", () => {
    const usage = placeUsageOnQuotaWindows(
      [
        obs({ observedAtMs: T0, resetsAtMs: T0 + 5 * H }),
        obs({ observedAtMs: T0 + 20 * H, resetsAtMs: T0 + 25 * H }),
      ],
      [],
    );
    expect(windowsInRange(usage, T0 + 6 * H, undefined).windows.map((w) => w.endMs)).toEqual([
      T0 + 25 * H,
    ]);
    expect(windowsInRange(usage, undefined, T0 + 19 * H).windows.map((w) => w.endMs)).toEqual([
      T0 + 5 * H,
    ]);
  });
});

describe("readQuotaWindowObservations", () => {
  it("returns null without a history database", async () => {
    expect(await readQuotaWindowObservations({ dbPath: "/nonexistent/quota.db" })).toBeNull();
  });

  it("reads recorded limits read-only, skipping bad rows", async () => {
    const sqlite = await import("node:sqlite").catch(() => null);
    if (!sqlite) return; // Node runtimes without node:sqlite; covered on Node 22 CI.
    const { DatabaseSync } = sqlite;
    const dir = mkdtempSync(join(tmpdir(), "tw-qw-"));
    const dbPath = join(dir, "quota-dashboard.db");
    try {
      const db = new DatabaseSync(dbPath);
      db.exec("CREATE TABLE quota_snapshots (provider TEXT, captured_at INTEGER, quota_data TEXT)");
      const insert = db.prepare("INSERT INTO quota_snapshots VALUES (?, ?, ?)");
      insert.run(
        "anthropic",
        T0,
        JSON.stringify({
          accountIdentity: "c".repeat(64),
          observation: { observedAt: T0 + 1000 },
          limits: [
            { kind: "5h:", group: "Claude", percent: 11, resets_at: "2026-10-30T05:00:00.000Z" },
            { kind: "Weekly:", group: "Claude", resets_at: "not a date" },
            {
              kind: "Weekly:",
              group: "Claude",
              percent: 3,
              scope: { model: "opus" },
              resets_at: "2026-11-05T00:00:00Z",
            },
          ],
        }),
      );
      insert.run("openai", T0, "{not json");
      insert.run(
        "openai",
        T0 - 30 * 24 * H,
        JSON.stringify({ limits: [{ kind: "Monthly:", resets_at: "2026-10-01T00:00:00Z" }] }),
      );
      db.close();

      const observations = await readQuotaWindowObservations({ dbPath, sinceMs: T0 });
      expect(observations).toEqual([
        {
          provider: "anthropic",
          account: "c".repeat(64),
          kind: "5h:",
          group: "Claude",
          model: null,
          observedAtMs: T0 + 1000,
          resetsAtMs: Date.parse("2026-10-30T05:00:00.000Z"),
          percentUsed: 11,
        },
        {
          provider: "anthropic",
          account: "c".repeat(64),
          kind: "Weekly:",
          group: "Claude",
          model: "opus",
          observedAtMs: T0 + 1000,
          resetsAtMs: Date.parse("2026-11-05T00:00:00Z"),
          percentUsed: 3,
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
