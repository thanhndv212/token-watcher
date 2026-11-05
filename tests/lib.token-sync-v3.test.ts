import { describe, expect, it } from "vitest";

import type { MachineIdentity } from "../src/lib/machine-identity.js";
import type { SessionUsageSource, TaggedMessage } from "../src/lib/session-usage.js";
import {
  buildSyncExportV3,
  localSessionKeys,
  mergeRemoteSessions,
  parseSyncFile,
  remoteSessionTokens,
  syncFileStem,
  syncSessionKey,
  type ParsedSyncFile,
} from "../src/lib/token-sync-v3.js";

function tagged(
  source: SessionUsageSource,
  rootID: string,
  opts: { sessionID?: string; model?: string; input?: number; created?: number } = {},
): TaggedMessage {
  return {
    source,
    rootID,
    subagent: Boolean(opts.sessionID && opts.sessionID !== rootID),
    message: {
      id: `m-${rootID}-${opts.created ?? 0}`,
      sessionID: opts.sessionID ?? rootID,
      role: "assistant",
      providerID: "anthropic",
      modelID: opts.model ?? "claude-opus",
      time: { created: opts.created ?? 1_000 },
      tokens: { input: opts.input ?? 100, output: 10, reasoning: 0, cache: { read: 5, write: 1 } },
    } as TaggedMessage["message"],
  };
}

const mac: MachineIdentity = {
  machineId: "mac-1",
  hostname: "Thanhs-MacBook-Pro.local",
  mapped: true,
  status: "mapped",
};
const linux: MachineIdentity = {
  machineId: "linux-1",
  hostname: "thanh-desktop",
  mapped: true,
  status: "mapped",
};
const allRead = new Map<SessionUsageSource, { status: "read" }>([
  ["claude-code", { status: "read" }],
  ["opencode", { status: "read" }],
  ["codex", { status: "read" }],
]);

function exportFor(machine: MachineIdentity, msgs: TaggedMessage[], nowMs = 5_000) {
  return buildSyncExportV3({ tagged: msgs, coverage: allRead, machine, nowMs });
}

function parsed(file: string, data: unknown): ParsedSyncFile {
  const p = parseSyncFile(file, JSON.stringify(data));
  if (!p) throw new Error(`fixture ${file} did not parse`);
  return p;
}

function v2(machine: string, sessions: Record<string, object>, exportedAt = 4_000) {
  return { version: 2, machine, exportedAt, sessions };
}

const local = { machineId: mac.machineId, hostname: mac.hostname };

describe("buildSyncExportV3", () => {
  it("groups responses by root session and model, with first and last times", () => {
    const out = exportFor(mac, [
      tagged("claude-code", "root", { created: 2_000 }),
      tagged("claude-code", "root", { sessionID: "child", created: 1_000, model: "claude-haiku" }),
      tagged("codex", "c1", { input: 7 }),
    ]);
    expect(out).toMatchObject({ version: 3, machineId: "mac-1", mapped: true, exportedAt: 5_000 });
    expect(out.sources.map((s) => s.status)).toEqual(["read", "read", "read"]);
    expect(out.sessions).toEqual([
      {
        s: "claude-code",
        id: "root",
        t0: 1_000,
        t1: 2_000,
        m: {
          "anthropic/claude-haiku": { n: 1, i: 100, o: 10, r: 0, cr: 5, cw: 1 },
          "anthropic/claude-opus": { n: 1, i: 100, o: 10, r: 0, cr: 5, cw: 1 },
        },
      },
      {
        s: "codex",
        id: "c1",
        t0: 1_000,
        t1: 1_000,
        m: { "anthropic/claude-opus": { n: 1, i: 7, o: 10, r: 0, cr: 5, cw: 1 } },
      },
    ]);
  });

  it("is deterministic regardless of input order and skips zero-token responses", () => {
    const msgs = [
      tagged("opencode", "b"),
      tagged("opencode", "a"),
      { ...tagged("opencode", "z"), message: { ...tagged("opencode", "z").message, tokens: {} } },
    ] as TaggedMessage[];
    const a = JSON.stringify(exportFor(mac, msgs));
    const b = JSON.stringify(exportFor(mac, [...msgs].reverse()));
    expect(a).toBe(b);
    expect(JSON.parse(a).sessions.map((s: { id: string }) => s.id)).toEqual(["a", "b"]);
  });

  it("stores no text beyond ids, model names and counts", () => {
    const msg = tagged("opencode", "s1");
    (msg.message as any).title = "secret project plan";
    (msg.message as any).content = "sk-ant-api-key";
    const text = JSON.stringify(exportFor(mac, [msg]));
    expect(text).not.toContain("secret");
    expect(text).not.toContain("sk-ant");
  });

  it("makes a safe file stem from a machine id", () => {
    expect(syncFileStem("mac-1")).toBe("mac-1");
    expect(syncFileStem("../etc/passwd")).toBe("__etc_passwd");
    expect(syncFileStem("")).toBe("unknown");
  });
});

describe("parseSyncFile", () => {
  it("round-trips a version 3 export", () => {
    const out = exportFor(linux, [tagged("codex", "c1", { input: 40 })]);
    const p = parsed("linux-1.v3.json", out);
    expect(p).toMatchObject({ version: 3, machineId: "linux-1", hostname: "thanh-desktop" });
    expect(p.sessions).toHaveLength(1);
    expect(p.sessions[0]).toMatchObject({ source: "codex", sessionID: "c1", startMs: 1_000 });
    expect(p.sessions[0]!.models[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-opus",
      responses: 1,
    });
    expect(remoteSessionTokens(p.sessions[0]!)).toEqual({
      input: 40,
      output: 10,
      reasoning: 0,
      cache_read: 5,
      cache_write: 1,
    });
  });

  it("reads version 2 as OpenCode sessions with unknown responses", () => {
    const p = parsed("old.json", v2("old-host", { ses_1: { k: "openai/gpt-4o", i: 9, o: 1 } }));
    expect(p).toMatchObject({ version: 2, machineId: "old-host", mapped: false });
    expect(p.sessions[0]).toMatchObject({ source: "opencode", sessionID: "ses_1", startMs: null });
    expect(p.sessions[0]!.models).toEqual([
      {
        provider: "openai",
        model: "gpt-4o",
        responses: null,
        tokens: { input: 9, output: 1, reasoning: 0, cache_read: 0, cache_write: 0 },
      },
    ]);
  });

  it.each([
    ["not json", "{"],
    ["unknown version", JSON.stringify({ version: 4, exportedAt: 1 })],
    ["missing exportedAt", JSON.stringify({ ...v2("h", {}), exportedAt: undefined })],
    ["negative count", JSON.stringify(v2("h", { s: { k: "a/b", i: -1 } }))],
    ["fractional count", JSON.stringify(v2("h", { s: { k: "a/b", i: 1.5 } }))],
    ["multi-line id", JSON.stringify(v2("h", { "a\nb": { k: "a/b", i: 1 } }))],
    ["oversized id", JSON.stringify(v2("h", { ["x".repeat(201)]: { k: "a/b", i: 1 } }))],
    [
      "unknown source",
      JSON.stringify({
        ...exportFor(linux, [tagged("codex", "c1")]),
        sessions: [{ s: "copilot", id: "x", t0: null, t1: null, m: { "a/b": { n: 1, i: 1 } } }],
      }),
    ],
    [
      "session without models",
      JSON.stringify({
        ...exportFor(linux, []),
        sessions: [{ s: "codex", id: "x", t0: null, t1: null, m: {} }],
      }),
    ],
  ])("rejects a file with %s", (_label, raw) => {
    expect(parseSyncFile("bad.json", raw)).toBeNull();
  });

  it("rejects the whole file when one session is bad", () => {
    const raw = JSON.stringify(v2("h", { good: { k: "a/b", i: 1 }, bad: { k: "a/b", i: "lots" } }));
    expect(parseSyncFile("mixed.json", raw)).toBeNull();
  });
});

describe("mergeRemoteSessions", () => {
  const linuxFile = () =>
    parsed("linux-1.v3.json", exportFor(linux, [tagged("codex", "c1"), tagged("opencode", "o1")]));

  it("keeps Mac and Linux records distinct and never reads this machine's own files", () => {
    const own = parsed("mac-1.v3.json", exportFor(mac, [tagged("codex", "mine")]));
    const ownV2 = parsed("Thanhs-MacBook-Pro.json", v2("thanhs-macbook-pro", { x: { k: "a/b" } }));
    const merged = mergeRemoteSessions({
      files: [own, ownV2, linuxFile()],
      localKeys: new Set(),
      local,
    });
    expect(merged.sessions.map((s) => [s.machineId, s.source, s.sessionID])).toEqual([
      ["linux-1", "codex", "c1"],
      ["linux-1", "opencode", "o1"],
    ]);
    expect(merged.skippedFiles).toEqual([
      { file: "mac-1.v3.json", reason: "own-machine" },
      { file: "Thanhs-MacBook-Pro.json", reason: "own-machine" },
    ]);
    expect(merged.machines).toEqual([
      expect.objectContaining({ machineId: "linux-1", version: 3, sessions: 2, duplicates: 0 }),
    ]);
  });

  it("recognises this machine's v3 file under a new id by hostname", () => {
    const renamed = parsed(
      "old-id.v3.json",
      exportFor({ ...mac, machineId: "Thanhs-MacBook-Pro.local", mapped: false }, [
        tagged("codex", "x"),
      ]),
    );
    const merged = mergeRemoteSessions({ files: [renamed], localKeys: new Set(), local });
    expect(merged.sessions).toEqual([]);
    expect(merged.skippedFiles).toEqual([{ file: "old-id.v3.json", reason: "own-machine" }]);
  });

  it("does not count a session that is also local", () => {
    const merged = mergeRemoteSessions({
      files: [linuxFile()],
      localKeys: localSessionKeys([tagged("codex", "c1")]),
      local,
    });
    expect(merged.sessions.map((s) => s.sessionID)).toEqual(["o1"]);
    expect(merged.machines[0]).toMatchObject({ sessions: 1, duplicates: 1 });
  });

  it("matches local OpenCode sessions by raw id as well as root", () => {
    const keys = localSessionKeys([tagged("opencode", "root", { sessionID: "fork" })], ["extra"]);
    expect(keys.has(syncSessionKey("opencode", "root"))).toBe(true);
    expect(keys.has(syncSessionKey("opencode", "fork"))).toBe(true);
    expect(keys.has(syncSessionKey("opencode", "extra"))).toBe(true);
    expect(keys.has(syncSessionKey("codex", "root"))).toBe(false);
  });

  it("counts the same session id from two sources separately", () => {
    const file = parsed(
      "linux-1.v3.json",
      exportFor(linux, [tagged("codex", "same"), tagged("claude-code", "same")]),
    );
    const merged = mergeRemoteSessions({ files: [file], localKeys: new Set(), local });
    expect(merged.sessions).toHaveLength(2);
  });

  it("migrates from v2: a v3 file supersedes the same host's v2 file", () => {
    const oldV2 = parsed(
      "thanh-desktop.json",
      v2("thanh-desktop", { o1: { k: "a/b", i: 999 }, legacy: { k: "a/b", i: 1 } }),
    );
    const merged = mergeRemoteSessions({
      files: [oldV2, linuxFile()],
      localKeys: new Set(),
      local,
    });
    expect(merged.skippedFiles).toEqual([{ file: "thanh-desktop.json", reason: "superseded" }]);
    expect(merged.sessions.map((s) => s.sessionID).sort()).toEqual(["c1", "o1"]);
    // o1 comes from v3, not the stale v2 count.
    expect(merged.sessions.every((s) => s.models.every((m) => m.tokens.input === 100))).toBe(true);
  });

  it("rolls back to v2: with no v3 file the v2 file is read", () => {
    const oldV2 = parsed("thanh-desktop.json", v2("thanh-desktop", { o1: { k: "a/b", i: 3 } }));
    const merged = mergeRemoteSessions({ files: [oldV2], localKeys: new Set(), local });
    expect(merged.sessions).toEqual([expect.objectContaining({ machineId: "thanh-desktop" })]);
    expect(merged.machines[0]).toMatchObject({ version: 2, sessions: 1 });
  });

  it("counts a session copied into two other machines' files once, newest export first", () => {
    const older = parsed(
      "a.v3.json",
      exportFor({ ...linux, machineId: "a", hostname: "a" }, [tagged("codex", "dup")], 1_000),
    );
    const newer = parsed(
      "b.v3.json",
      exportFor({ ...linux, machineId: "b", hostname: "b" }, [tagged("codex", "dup")], 9_000),
    );
    const merged = mergeRemoteSessions({ files: [older, newer], localKeys: new Set(), local });
    expect(merged.sessions.map((s) => s.machineId)).toEqual(["b"]);
    expect(merged.machines.map((m) => [m.machineId, m.sessions, m.duplicates])).toEqual([
      ["a", 0, 1],
      ["b", 1, 0],
    ]);
  });

  it("is idempotent: merging the same files again gives the same result", () => {
    const files = [linuxFile(), parsed("old.json", v2("old-host", { z: { k: "a/b", i: 1 } }))];
    const first = mergeRemoteSessions({ files, localKeys: new Set(), local });
    const second = mergeRemoteSessions({
      files: [...files].reverse(),
      localKeys: new Set(),
      local,
    });
    expect(second).toEqual(first);
  });

  it("reports invalid files without counting them", () => {
    const merged = mergeRemoteSessions({
      files: [{ file: "broken.json", invalid: true }, linuxFile()],
      localKeys: new Set(),
      local,
    });
    expect(merged.skippedFiles).toEqual([{ file: "broken.json", reason: "invalid" }]);
    expect(merged.sessions).toHaveLength(2);
  });
});
