import { describe, expect, it } from "vitest";

import { parseSessionViewParams, querySessionView } from "../src/gui/ipc/sessions.js";
import type { OpenCodeMessage } from "../src/lib/opencode-storage.js";
import type { SessionUsageDeps } from "../src/lib/session-usage.js";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const DAY = 86_400_000;

function msg(sessionID: string, atMs: number, total: number): OpenCodeMessage {
  return {
    id: `${sessionID}-${atMs}`,
    sessionID,
    role: "assistant",
    providerID: "anthropic",
    modelID: "claude-sonnet",
    directory: `/Users/someone/private/work/${sessionID}-repo`,
    tokens: { input: total, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: atMs },
  } as OpenCodeMessage;
}

function deps(over: Partial<SessionUsageDeps> = {}): Partial<SessionUsageDeps> {
  return {
    readClaude: async () => [],
    readOpenCode: async () => [],
    readOpenCodeIndex: async () => ({}),
    readCodex: async () => [],
    storeExists: () => true,
    price: () => null,
    machine: () =>
      ({ machineId: "mac-1", mapped: true }) as ReturnType<SessionUsageDeps["machine"]>,
    readQuotaWindows: async () => {
      throw new Error("quota windows must not be read unless requested");
    },
    readImports: () => {
      throw new Error("imports must not be read unless requested");
    },
    ...over,
  };
}

describe("parseSessionViewParams", () => {
  it("accepts only the offered ranges and strict booleans", () => {
    expect(parseSessionViewParams({ days: 7, windows: true, imports: true })).toEqual({
      days: 7,
      windows: true,
      imports: true,
    });
    for (const raw of [undefined, null, "x", { days: 3 }, { days: "7" }, { days: 1e9 }]) {
      expect(parseSessionViewParams(raw)).toEqual({ days: 28, windows: false, imports: false });
    }
    expect(parseSessionViewParams({ windows: "true", imports: 1 })).toMatchObject({
      windows: false,
      imports: false,
    });
  });
});

describe("querySessionView", () => {
  it("reads only the chosen range and reduces directories to the project name", async () => {
    let since: number | undefined;
    const view = await querySessionView(
      { days: 7 },
      {
        nowMs: NOW,
        deps: deps({
          readClaude: async (p) => {
            since = p.sinceMs;
            return [msg("s1", NOW - DAY, 100)];
          },
        }),
      },
    );
    expect(since).toBe(NOW - 7 * DAY);
    expect(view.days).toBe(7);
    expect(view.sessionCount).toBe(1);
    expect(view.sessions[0]).toMatchObject({ sessionID: "s1", project: "s1-repo" });
    expect(JSON.stringify(view)).not.toContain("/Users/someone");
    expect(view.quotaWindows).toBeNull();
    expect(view.imports).toBeNull();
  });

  it("keeps the 25 largest sessions and reports the full count", async () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg(`s${i}`, NOW - DAY, i + 1));
    const view = await querySessionView(
      {},
      { nowMs: NOW, deps: deps({ readOpenCode: async () => messages }) },
    );
    expect(view.sessionCount).toBe(30);
    expect(view.sessions).toHaveLength(25);
    expect(view.sessions[0]!.totalTokens).toBe(30);
    expect(view.totals.sessions).toBe(30);
  });

  it("reads windows and imports only when asked", async () => {
    const view = await querySessionView(
      { windows: true, imports: true },
      {
        nowMs: NOW,
        deps: deps({
          readQuotaWindows: async () => null,
          readImports: () => ({ status: "not-found", path: "/x", records: [] }),
        }),
      },
    );
    expect(view.quotaWindows).toMatchObject({ status: "not-found" });
    expect(view.imports).toMatchObject({ status: "not-found" });
  });
});
