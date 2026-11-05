import { describe, expect, it, vi } from "vitest";

import { runCliPricingCommand, type CliPricingDeps } from "../src/lib/cli-pricing.js";
import {
  setPricingSnapshotAutoRefresh,
  type PricingRefreshResult,
} from "../src/lib/modelsdev-pricing.js";

function sink() {
  let text = "";
  return {
    stream: { write: (chunk: string) => ((text += chunk), true) },
    text: () => text,
  };
}

async function run(argv: string[], deps: Partial<CliPricingDeps> = {}) {
  const out = sink();
  const err = sink();
  const refresh = vi.fn(
    async (): Promise<PricingRefreshResult> => ({
      attempted: false,
      updated: false,
      reason: "fresh",
      state: { version: 1, updatedAt: 0 },
    }),
  );
  const code = await runCliPricingCommand({
    argv,
    stdout: out.stream,
    stderr: err.stream,
    deps: {
      applyConfig: async () => {},
      readState: async () => null,
      nowMs: () => Date.UTC(2026, 10, 5),
      refresh,
      ...deps,
    },
  });
  return { code, out: out.text(), err: err.text(), refresh: deps.refresh ?? refresh };
}

describe("token-watcher pricing", () => {
  it("prints status by default and as JSON", async () => {
    const text = await run([]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("Pricing snapshot: ");
    expect(text.out).toContain("Last refresh: never");

    // The configured pricingSnapshot.autoRefresh days decide staleness.
    const json = await run(["status", "--json"], {
      applyConfig: async () => setPricingSnapshotAutoRefresh(2),
    });
    const status = JSON.parse(json.out);
    expect(status).toMatchObject({ maxAgeDays: 2, lastResult: null });
    expect(typeof status.stale).toBe("boolean");
  });

  it("refreshes only when stale unless --force is given", async () => {
    const plain = await run(["refresh"]);
    expect(plain.code).toBe(0);
    expect(plain.refresh).toHaveBeenCalledWith({ force: false });
    expect(plain.out).toContain("snapshot is fresh; nothing fetched");

    const forced = await run(["refresh", "--force", "--json"]);
    expect(forced.refresh).toHaveBeenCalledWith({ force: true });
    expect(JSON.parse(forced.out)).toMatchObject({ attempted: false, reason: "fresh" });
  });

  it("exits 1 when the fetch fails", async () => {
    const failed = await run(["refresh"], {
      refresh: async () => ({
        attempted: true,
        updated: false,
        error: "Failed to fetch: 503",
        state: { version: 1, updatedAt: 0 },
      }),
    });
    expect(failed.code).toBe(1);
    expect(failed.err).toContain("Pricing refresh failed: Failed to fetch: 503");
  });

  it("rejects unknown actions and flags without touching config", async () => {
    const applyConfig = vi.fn(async () => {});
    for (const argv of [["update"], ["status", "--force"], ["refresh", "--since"], ["a", "b"]]) {
      expect((await run(argv, { applyConfig })).code).toBe(2);
    }
    expect(applyConfig).not.toHaveBeenCalled();
  });
});
