import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  importUsageRecords,
  importUsageRecordsFromFile,
  readUsageImportStore,
  summariseImports,
} from "../src/lib/usage-import-store.js";

const MAC = "mac-1";

function record(overrides: Record<string, unknown> = {}) {
  return {
    contract: 1,
    machineId: MAC,
    source: "claude-code",
    sessionId: "s-native",
    startedAt: "2026-11-02T10:00:00Z",
    endedAt: "2026-11-02T11:00:00Z",
    projectId: "token-watcher",
    models: ["claude-opus"],
    activity: { userTurns: 4, assistantTurns: 9, toolCalls: 20 },
    usage: { method: "reported", input: 999_999, output: 1 },
    outcome: {
      method: "git-proxy",
      commits: ["abc1234"],
      pullRequests: ["thanhndv212/token-watcher#82"],
    },
    ...overrides,
  };
}

const fixtures = [
  record(),
  record({
    source: "copilot",
    sessionId: "cp-1",
    usage: { method: "unavailable" },
    activity: { userTurns: 2, assistantTurns: 2, toolCalls: null },
    outcome: { method: "none" },
  }),
  record({
    source: "zcode",
    sessionId: "z-1",
    usage: null,
    activity: null,
    outcome: { method: "git-proxy", commits: ["def5678"], pullRequests: [] },
  }),
  record({
    machineId: "linux-1",
    sessionId: "s-remote",
    outcome: { method: "git-proxy", commits: ["abc1234", "0123456"] },
  }),
  record({ sessionId: "s-gone", outcome: { method: "git-proxy", commits: ["fedcba9"] } }),
  record({ sessionId: "s-undated", startedAt: null, endedAt: null }),
];
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

let dir: string;
let storePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tw-imports-"));
  storePath = join(dir, "nested", "session-knowledge-imports.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("importUsageRecords", () => {
  it("adds records, and re-importing the same fixtures adds no duplicates", () => {
    const first = importUsageRecords(jsonl(fixtures), { storePath, nowMs: 1 });
    expect(first).toMatchObject({
      read: 6,
      added: 6,
      updated: 0,
      unchanged: 0,
      rejected: 0,
      stored: 6,
    });
    const bytes = readFileSync(storePath, "utf8");

    const second = importUsageRecords(jsonl(fixtures), { storePath, nowMs: 2 });
    expect(second).toMatchObject({ added: 0, updated: 0, unchanged: 6, stored: 6 });
    // Nothing changed, so the store is not rewritten.
    expect(readFileSync(storePath, "utf8")).toBe(bytes);

    // Same records in another order and as a JSON array: still no change.
    const third = importUsageRecords(JSON.stringify([...fixtures].reverse()), { storePath });
    expect(third).toMatchObject({ added: 0, unchanged: 6, stored: 6 });
    expect(readUsageImportStore(storePath).records).toHaveLength(6);
  });

  it("updates a record whose content changed, keyed by machine, source and session", () => {
    importUsageRecords(jsonl(fixtures), { storePath });
    const changed = record({ activity: { userTurns: 5, assistantTurns: 9, toolCalls: 20 } });
    const r = importUsageRecords(jsonl([changed, record({ source: "codex" })]), { storePath });
    expect(r).toMatchObject({ added: 1, updated: 1, stored: 7 });
    const stored = readUsageImportStore(storePath).records;
    expect(
      stored.find((x) => x.source === "claude-code" && x.sessionId === "s-native")!.activity
        .userTurns,
    ).toBe(5);
  });

  it("stores no conversation text or credentials and never echoes rejected input", () => {
    const secret = "sk-ant-api03-SECRETSECRET";
    const r = importUsageRecords(
      jsonl([
        record({ title: "Fix the auth bug", prompt: "my password is hunter2", apiKey: secret }),
        { contract: secret },
        record({ sessionId: `multi\nline ${secret}` }),
      ]) + `not json ${secret}\n`,
      { storePath },
    );
    expect(r).toMatchObject({ added: 1, rejected: 3 });
    const stored = readFileSync(storePath, "utf8");
    for (const text of [secret, "hunter2", "Fix the auth bug", "title", "prompt"]) {
      expect(stored).not.toContain(text);
      expect(JSON.stringify(r)).not.toContain(text);
    }
    expect(r.rejections.map((x) => x.line)).toEqual([2, 3, 4]);
    expect(r.rejections[0]!.error).toBe("unsupported contract string");
  });

  it("refuses to overwrite a store it can't read", () => {
    writeFileSync(join(dir, "bad.json"), "{ not json");
    expect(() => importUsageRecords(jsonl(fixtures), { storePath: join(dir, "bad.json") })).toThrow(
      /can't be read/,
    );
    expect(readFileSync(join(dir, "bad.json"), "utf8")).toBe("{ not json");
  });

  it("rejects a hand-edited store that breaks the contract", () => {
    importUsageRecords(jsonl(fixtures), { storePath });
    const data = JSON.parse(readFileSync(storePath, "utf8"));
    data.records[0].sessionId = "two\nlines";
    writeFileSync(storePath, JSON.stringify(data));
    expect(readUsageImportStore(storePath)).toMatchObject({ status: "unreadable" });
  });

  it("imports from a file", () => {
    const file = join(dir, "export.jsonl");
    writeFileSync(file, jsonl(fixtures));
    expect(importUsageRecordsFromFile(file, { storePath })).toMatchObject({ added: 6 });
    expect(readUsageImportStore(join(dir, "missing.json"))).toMatchObject({ status: "not-found" });
  });
});

describe("summariseImports", () => {
  const since = Date.parse("2026-11-01T00:00:00Z");
  const native = [
    { source: "claude-code", sessionID: "s-native", totalTokens: 50_000, costUsd: 2 },
    { source: "codex", sessionID: "x", totalTokens: 10, costUsd: null },
  ];

  function summary() {
    importUsageRecords(jsonl(fixtures), { storePath });
    return summariseImports({
      store: readUsageImportStore(storePath),
      sinceMs: since,
      untilMs: null,
      machineId: MAC,
      nativeSessions: native,
    });
  }

  it("shows Copilot and Zcode as activity-only rows and never takes native tokens from imports", () => {
    const s = summary();
    expect(s).toMatchObject({ status: "read", storedRecords: 6, inRange: 5, undated: 1 });
    expect(s.bySource).toEqual([
      {
        source: "claude-code",
        owner: "native",
        sessions: 3,
        userTurns: 12,
        assistantTurns: 27,
        toolCalls: 60,
        importedTokens: null,
        withOutcome: 3,
      },
      {
        source: "copilot",
        owner: "none",
        sessions: 1,
        userTurns: 2,
        assistantTurns: 2,
        toolCalls: null,
        importedTokens: null,
        withOutcome: 0,
      },
      {
        source: "zcode",
        owner: "none",
        sessions: 1,
        userTurns: null,
        assistantTurns: null,
        toolCalls: null,
        importedTokens: null,
        withOutcome: 1,
      },
    ]);
  });

  it("joins git-proxy outcomes to this machine's native sessions for cost per commit", () => {
    expect(summary().outcomes).toEqual({
      method: "git-proxy",
      sessions: 4,
      commits: 4,
      pullRequests: 1,
      matchedNativeSessions: 1,
      matchedTokens: 50_000,
      matchedCostUsd: 2,
      matchedCommits: 1,
      costPerCommitUsd: 2,
      unmatchedLocal: 2,
      otherMachines: 1,
    });
  });

  it("counts reported imported tokens for non-native sources", () => {
    importUsageRecords(
      jsonl([
        record({
          source: "copilot",
          sessionId: "cp-2",
          usage: { method: "reported", input: 10, output: null },
        }),
      ]),
      { storePath },
    );
    const s = summariseImports({
      store: readUsageImportStore(storePath),
      sinceMs: null,
      untilMs: null,
      machineId: MAC,
      nativeSessions: [],
    });
    expect(s.bySource[0]).toMatchObject({ source: "copilot", owner: "import", importedTokens: 10 });
  });

  it("reports a missing or unreadable store instead of an empty one", () => {
    const base = { sinceMs: null, untilMs: null, machineId: MAC, nativeSessions: [] };
    expect(summariseImports({ ...base, store: readUsageImportStore(storePath) })).toMatchObject({
      status: "not-found",
    });
    expect(
      summariseImports({
        ...base,
        store: { status: "unreadable", path: storePath, reason: "boom", records: [] },
      }),
    ).toMatchObject({ status: "unavailable", reason: "boom" });
  });
});

describe("getUsageImportStorePath", () => {
  it("honours TOKEN_WATCHER_IMPORT_STORE", async () => {
    const { getUsageImportStorePath } = await import("../src/lib/usage-import-store.js");
    vi.stubEnv("TOKEN_WATCHER_IMPORT_STORE", "/tmp/custom-imports.json");
    expect(getUsageImportStorePath()).toBe("/tmp/custom-imports.json");
    vi.stubEnv("TOKEN_WATCHER_IMPORT_STORE", "");
    expect(getUsageImportStorePath()).toMatch(/session-knowledge-imports\.json$/);
  });
});
