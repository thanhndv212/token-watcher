import { createLoadConfigMeta, loadConfig } from "./config.js";
import {
  getPricingRefreshPolicy,
  getPricingSnapshotHealth,
  getPricingSnapshotMeta,
  getPricingSnapshotSelection,
  getPricingSnapshotSource,
  getRuntimePricingSnapshotPath,
  maybeRefreshPricingSnapshot,
  readPricingRefreshState,
  setPricingSnapshotAutoRefresh,
  setPricingSnapshotSelection,
  type PricingRefreshResult,
  type PricingRefreshStateV1,
} from "./modelsdev-pricing.js";
import type { PricingSnapshotSource } from "./types.js";

export const PRICING_USAGE = [
  "Usage:",
  "  npx @thanhndv212/token-watcher pricing [status] [--json]",
  "  npx @thanhndv212/token-watcher pricing refresh [--force] [--json]",
  "",
  "Model pricing comes from a models.dev snapshot. The desktop app, the plugin and",
  "`/pricing_refresh` keep it fresh; this command is for scheduled jobs (cron, launchd).",
  "",
  "  status     Show the active snapshot, its age and the last refresh attempt",
  "  refresh    Fetch models.dev when the snapshot is older than",
  "             pricingSnapshot.autoRefresh days (default 7); otherwise do nothing",
  "             --force   Fetch now, whatever the age",
  "  --json     Print machine-readable output",
  "",
  "Exit codes: 0 refreshed, fresh or skipped; 1 the fetch failed; 2 bad arguments.",
].join("\n");

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PricingStatus {
  selection: PricingSnapshotSource;
  active: "runtime" | "bundled" | "empty";
  generatedAt: string | null;
  ageDays: number | null;
  maxAgeDays: number;
  stale: boolean;
  runtimeSnapshotPath: string;
  providers: string[];
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastResult: PricingRefreshStateV1["lastResult"] | null;
  lastError: string | null;
}

export interface CliPricingDeps {
  applyConfig: () => Promise<void>;
  refresh: (opts: { force: boolean }) => Promise<PricingRefreshResult>;
  readState: () => Promise<PricingRefreshStateV1 | null>;
  nowMs: () => number;
}

const DEFAULT_DEPS: CliPricingDeps = {
  async applyConfig() {
    // Standalone, like the desktop app: the user/global quota-toast.json, never a repo's.
    const config = await loadConfig(undefined, createLoadConfigMeta(), { globalOnly: true });
    setPricingSnapshotAutoRefresh(config.pricingSnapshot.autoRefresh);
    setPricingSnapshotSelection(config.pricingSnapshot.source);
  },
  refresh: ({ force }) => maybeRefreshPricingSnapshot({ force, reason: "manual" }),
  readState: () => readPricingRefreshState(),
  nowMs: () => Date.now(),
};

function iso(ms: number | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0
    ? new Date(ms).toISOString()
    : null;
}

function days(ms: number): number {
  return Math.round((ms / DAY_MS) * 10) / 10;
}

export async function readPricingStatus(deps: CliPricingDeps): Promise<PricingStatus> {
  const nowMs = deps.nowMs();
  const policy = getPricingRefreshPolicy();
  const health = getPricingSnapshotHealth({ nowMs, maxAgeMs: policy.maxAgeMs });
  const meta = getPricingSnapshotMeta();
  const state = await deps.readState();
  return {
    selection: getPricingSnapshotSelection(),
    active: getPricingSnapshotSource(),
    generatedAt: iso(health.generatedAt),
    ageDays: health.generatedAt > 0 ? days(health.ageMs) : null,
    maxAgeDays: days(policy.maxAgeMs),
    stale: health.stale,
    runtimeSnapshotPath: getRuntimePricingSnapshotPath(),
    providers: [...meta.providers],
    lastAttemptAt: iso(state?.lastAttemptAt),
    lastSuccessAt: iso(state?.lastSuccessAt),
    lastResult: state?.lastResult ?? null,
    lastError: state?.lastError ?? null,
  };
}

function formatStatus(status: PricingStatus): string {
  const plural = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
  const age =
    status.ageDays === null
      ? "no snapshot"
      : `${plural(status.ageDays)} old (refresh after ${plural(status.maxAgeDays)})` +
        (status.stale ? ", stale" : "");
  return [
    `Pricing snapshot: ${status.active} (selection: ${status.selection})`,
    `Generated: ${status.generatedAt ?? "n/a"}, ${age}`,
    `Providers: ${status.providers.join(", ") || "none"}`,
    `Runtime snapshot: ${status.runtimeSnapshotPath}`,
    `Last refresh: ${status.lastResult ?? "never"}${status.lastAttemptAt ? ` at ${status.lastAttemptAt}` : ""}` +
      (status.lastError ? ` (${status.lastError})` : ""),
  ].join("\n");
}

const REASON_TEXT: Record<string, string> = {
  fresh: "snapshot is fresh; nothing fetched",
  throttled: "a refresh was attempted recently; nothing fetched",
  selection_bundled: "pricingSnapshot.source is bundled; nothing fetched",
  disabled: "refresh is disabled; nothing fetched",
};

export async function runCliPricingCommand(params: {
  argv: string[];
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  deps?: Partial<CliPricingDeps>;
}): Promise<number> {
  const stdout = params.stdout ?? process.stdout;
  const stderr = params.stderr ?? process.stderr;
  const deps: CliPricingDeps = { ...DEFAULT_DEPS, ...params.deps };

  const args = [...params.argv];
  const json = args.includes("--json");
  const force = args.includes("--force");
  if (args.includes("--help") || args.includes("-h")) {
    stdout.write(`${PRICING_USAGE}\n`);
    return 0;
  }
  const positional = args.filter((a) => !a.startsWith("--"));
  const unknown = args.filter((a) => a.startsWith("--") && a !== "--json" && a !== "--force");
  const action = positional[0] ?? "status";
  if (
    unknown.length > 0 ||
    positional.length > 1 ||
    (action !== "status" && action !== "refresh") ||
    (force && action !== "refresh")
  ) {
    stderr.write(`${PRICING_USAGE}\n`);
    return 2;
  }

  await deps.applyConfig();

  if (action === "status") {
    const status = await readPricingStatus(deps);
    stdout.write(json ? `${JSON.stringify(status, null, 2)}\n` : `${formatStatus(status)}\n`);
    return 0;
  }

  const result = await deps.refresh({ force });
  const status = await readPricingStatus(deps);
  const failed = result.attempted && !result.updated;
  if (json) {
    stdout.write(
      `${JSON.stringify(
        {
          attempted: result.attempted,
          updated: result.updated,
          reason: result.reason ?? null,
          error: result.error ?? null,
          status,
        },
        null,
        2,
      )}\n`,
    );
  } else if (failed) {
    stderr.write(`Pricing refresh failed: ${result.error ?? "unknown error"}\n`);
    stdout.write(`${formatStatus(status)}\n`);
  } else {
    const what = result.updated
      ? "Pricing snapshot refreshed from models.dev."
      : `Pricing: ${REASON_TEXT[result.reason ?? ""] ?? result.reason ?? "nothing fetched"}.`;
    stdout.write(`${what}\n${formatStatus(status)}\n`);
  }
  return failed ? 1 : 0;
}
