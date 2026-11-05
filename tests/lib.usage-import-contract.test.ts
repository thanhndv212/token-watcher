import { describe, expect, it } from "vitest";

import {
  importedTokenUsage,
  parseUsageImportRecord,
  tokenOwner,
  usageImportKey,
  type UsageImportRecord,
} from "../src/lib/usage-import-contract.js";

const BASE = {
  contract: 1,
  machineId: "mac-studio",
  source: "copilot-chat",
  sessionId: "8f1c",
  parentSessionId: null,
  isSubagent: false,
  projectId: "token-watcher",
  startedAt: "2026-10-18T08:02:11Z",
  endedAt: "2026-10-18T08:47:40Z",
  models: ["gpt-5"],
  activity: { userTurns: 14, assistantTurns: 14, toolCalls: 37 },
  usage: { method: "unavailable" },
  outcome: {
    method: "git-proxy",
    commits: ["88a8c6a"],
    pullRequests: ["thanhndv212/token-watcher#65"],
  },
};

function parse(over: Record<string, unknown> = {}): UsageImportRecord {
  const result = parseUsageImportRecord({ ...BASE, ...over });
  if (!result.ok) throw new Error(result.error);
  return result.record;
}

function parseError(over: Record<string, unknown>): string {
  const result = parseUsageImportRecord({ ...BASE, ...over });
  if (result.ok) throw new Error("expected a parse error");
  return result.error;
}

const REPORTED = {
  method: "reported",
  input: 100,
  output: 50,
  cacheRead: 900,
  cacheWrite: null,
  reasoning: 0,
};

describe("parseUsageImportRecord", () => {
  it("parses the roadmap example record", () => {
    expect(parse()).toEqual({
      contract: 1,
      machineId: "mac-studio",
      source: "copilot-chat",
      sessionId: "8f1c",
      parentSessionId: null,
      isSubagent: false,
      projectId: "token-watcher",
      startedAtMs: Date.parse("2026-10-18T08:02:11Z"),
      endedAtMs: Date.parse("2026-10-18T08:47:40Z"),
      models: ["gpt-5"],
      activity: { userTurns: 14, assistantTurns: 14, toolCalls: 37 },
      usage: { method: "unavailable" },
      outcome: {
        method: "git-proxy",
        commits: ["88a8c6a"],
        pullRequests: ["thanhndv212/token-watcher#65"],
      },
    });
  });

  it("keeps missing optional values null, never zero", () => {
    const record = parse({
      parentSessionId: undefined,
      isSubagent: undefined,
      projectId: undefined,
      startedAt: undefined,
      endedAt: undefined,
      models: undefined,
      activity: { userTurns: 3 },
      usage: { method: "reported", input: 10 },
      outcome: undefined,
    });
    expect(record).toMatchObject({
      parentSessionId: null,
      isSubagent: null,
      projectId: null,
      startedAtMs: null,
      endedAtMs: null,
      models: [],
      activity: { userTurns: 3, assistantTurns: null, toolCalls: null },
      usage: {
        method: "reported",
        input: 10,
        output: null,
        cacheRead: null,
        cacheWrite: null,
        reasoning: null,
      },
      outcome: null,
    });
  });

  it("drops fields outside the contract so text never reaches Token Watcher", () => {
    const record = parse({
      title: "fix the secret bug",
      messages: [{ role: "user", text: "my api key is sk-123" }],
      apiKey: "sk-123",
      activity: { userTurns: 1, prompt: "hello" },
    });
    const serialised = JSON.stringify(record);
    expect(serialised).not.toContain("secret");
    expect(serialised).not.toContain("sk-123");
    expect(serialised).not.toContain("hello");
    expect(Object.keys(record).sort()).toEqual(
      [
        "activity",
        "contract",
        "endedAtMs",
        "isSubagent",
        "machineId",
        "models",
        "outcome",
        "parentSessionId",
        "projectId",
        "sessionId",
        "source",
        "startedAtMs",
        "usage",
      ].sort(),
    );
  });

  it("rejects identifiers that could carry text", () => {
    expect(parseError({ projectId: "line one\nline two" })).toMatch(/projectId/);
    expect(parseError({ sessionId: "x".repeat(201) })).toMatch(/sessionId/);
    expect(parseError({ models: Array.from({ length: 51 }, (_, i) => `m${i}`) })).toMatch(/models/);
  });

  it("rejects unsupported contracts, keys and values", () => {
    expect(parseError({ contract: 2 })).toMatch(/unsupported contract 2/);
    expect(parseError({ machineId: "" })).toMatch(/machineId/);
    expect(parseError({ source: "Copilot Chat" })).toMatch(/source/);
    expect(parseError({ usage: { method: "estimated", input: 5 } })).toMatch(/reserved/);
    expect(parseError({ usage: { method: "reported", input: -1 } })).toMatch(/usage.input/);
    expect(parseError({ usage: { method: "reported", output: 1.5 } })).toMatch(/usage.output/);
    expect(parseError({ activity: { toolCalls: "3" } })).toMatch(/activity.toolCalls/);
    expect(parseError({ startedAt: "yesterday" })).toMatch(/startedAt/);
    expect(parseError({ endedAt: "2026-10-18T08:00:00Z" })).toMatch(/before startedAt/);
    expect(parseError({ isSubagent: "no" })).toMatch(/isSubagent/);
    expect(parseError({ outcome: { method: "git-proxy", commits: ["not-a-sha"] } })).toMatch(
      /outcome.commits/,
    );
    expect(parseError({ outcome: { method: "git-proxy", pullRequests: ["#65"] } })).toMatch(
      /outcome.pullRequests/,
    );
    expect(parseUsageImportRecord(null)).toEqual({
      ok: false,
      error: "record must be a JSON object",
    });
  });

  it("treats outcome method none as no outcome and dedupes outcome lists", () => {
    expect(parse({ outcome: { method: "none" } }).outcome).toBeNull();
    expect(
      parse({ outcome: { method: "git-proxy", commits: ["88a8c6a", "88a8c6a"] } }).outcome,
    ).toEqual({ method: "git-proxy", commits: ["88a8c6a"], pullRequests: [] });
  });
});

describe("source-of-truth rule", () => {
  it("never takes token values from an import for a natively read source", () => {
    for (const source of ["claude-code", "opencode", "codex"]) {
      const record = parse({ source, usage: REPORTED });
      expect(record.usage.method).toBe("reported");
      expect(tokenOwner(record)).toBe("native");
      expect(importedTokenUsage(record)).toBeNull();
    }
  });

  it("takes reported tokens for other sources and leaves the rest activity-only", () => {
    const reported = parse({ source: "zcode", usage: REPORTED });
    expect(tokenOwner(reported)).toBe("import");
    expect(importedTokenUsage(reported)).toEqual({
      method: "reported",
      input: 100,
      output: 50,
      cacheRead: 900,
      cacheWrite: null,
      reasoning: 0,
    });

    const activityOnly = parse({ source: "copilot-chat" });
    expect(tokenOwner(activityOnly)).toBe("none");
    expect(importedTokenUsage(activityOnly)).toBeNull();
  });

  it("keys records by machine, source and session", () => {
    const mac = parse({ machineId: "mac", source: "codex", sessionId: "s1" });
    const linux = parse({ machineId: "linux", source: "codex", sessionId: "s1" });
    const other = parse({ machineId: "mac", source: "opencode", sessionId: "s1" });
    expect(new Set([mac, linux, other].map(usageImportKey)).size).toBe(3);
    expect(usageImportKey(mac)).toBe(usageImportKey({ ...mac, projectId: "changed" }));
  });
});
