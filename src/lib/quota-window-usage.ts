/**
 * Places session usage on provider quota windows (UA-TW-05).
 *
 * Token Watcher's history database records each provider's quota limits as
 * they were observed: the window kind ("5h:", "Weekly:", ...), the percent
 * used and the reset time. This module rebuilds window instances from those
 * observations and sums local session responses into the instance that was
 * open when each response was made.
 *
 * Attribution is conservative. A response is only placed in a window when one
 * observed instance for its provider covers the response time; responses with
 * no recorded windows, outside every known instance, or covered by instances
 * from more than one account stay unattributed with a reason. Nothing is
 * estimated, and tokens are local counts, not the provider's billed usage.
 */

import { existsSync } from "fs";
import { dirname, join } from "path";

import { getOpenCodeDbPath } from "./opencode-storage.js";
import { openOpenCodeSqliteReadOnly } from "./opencode-sqlite.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Reset times within this gap belong to one window instance (polls jitter by < 1 s). */
export const RESET_CLUSTER_MS = 5 * MINUTE_MS;

/** Window kinds whose length is fixed and known; others start at the previous reset. */
export const KNOWN_WINDOW_DURATIONS_MS: Readonly<Record<string, number>> = {
  "5h": 5 * HOUR_MS,
  weekly: 7 * DAY_MS,
};

/** Session-store provider ids that differ from the quota provider id. */
export const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  "github-copilot": "copilot",
};

export type QuotaWindowObservation = {
  provider: string;
  /** Hashed account identity, or "unknown". */
  account: string;
  /** Limit kind as recorded, e.g. "5h:" or "Weekly:". */
  kind: string;
  /** Limit group, e.g. "Claude" or "OpenCode Go". */
  group: string;
  /** Model scope of a model-specific limit. */
  model: string | null;
  observedAtMs: number;
  resetsAtMs: number;
  percentUsed: number | null;
};

export type WindowUsageResponse = {
  /** Session-store provider id; mapped through PROVIDER_ALIASES. */
  providerID: string | null;
  createdMs: number | null;
  sessionKey: string;
  source: string;
  totalTokens: number;
};

export type WindowStartMethod =
  /** reset minus the known window length */
  | "duration"
  /** the previous instance's reset */
  | "previous-reset"
  /** first observation; the window may have started earlier */
  | "first-observation";

export type QuotaWindowRow = {
  provider: string;
  account: string;
  /** Normalised kind: "5h", "weekly", "monthly", "quota", ... */
  window: string;
  group: string;
  model: string | null;
  startMs: number;
  endMs: number;
  startMethod: WindowStartMethod;
  /** Latest observed percent used in this instance, and when it was observed. */
  percentUsed: number | null;
  observedAtMs: number;
  observations: number;
  /** Observed live alongside another instance of the same limit: accounts were mixed. */
  concurrent: boolean;
  sessions: number;
  responses: number;
  totalTokens: number;
  bySource: { source: string; responses: number; totalTokens: number }[];
};

export type UnattributedReason =
  /** no quota window was ever recorded for the provider */
  | "no-window"
  /** windows exist for the provider but none covers the response time */
  | "outside-known-windows"
  /** instances from more than one account (identified or not) cover the response time */
  | "ambiguous-account"
  /** the response has no provider id or no timestamp */
  | "no-provider-or-time";

export type UnattributedRow = {
  provider: string | null;
  /** Null for reasons that apply to every window kind. */
  window: string | null;
  reason: UnattributedReason;
  responses: number;
  totalTokens: number;
};

export type QuotaWindowUsage = {
  status: "read" | "not-found" | "unavailable";
  reason?: string;
  windows: QuotaWindowRow[];
  unattributed: UnattributedRow[];
};

/** "5h:" -> "5h", "Weekly:" -> "weekly", "Quota:" -> "quota". */
export function normalizeWindowKind(kind: string): string {
  return kind.trim().replace(/:$/u, "").trim().toLowerCase();
}

export function quotaProviderFor(providerID: string): string {
  const id = providerID.trim().toLowerCase();
  return PROVIDER_ALIASES[id] ?? id;
}

type Instance = {
  provider: string;
  account: string;
  window: string;
  group: string;
  model: string | null;
  startMs: number;
  endMs: number;
  startMethod: WindowStartMethod;
  percentUsed: number | null;
  observedAtMs: number;
  observations: number;
  concurrent: boolean;
  sessions: Set<string>;
  responses: number;
  totalTokens: number;
  bySource: Map<string, { source: string; responses: number; totalTokens: number }>;
};

/** Groups observations into window instances, one series per provider/account/limit. */
export function buildWindowInstances(observations: QuotaWindowObservation[]): Instance[] {
  const series = new Map<string, QuotaWindowObservation[]>();
  for (const o of observations) {
    if (!Number.isFinite(o.resetsAtMs) || !Number.isFinite(o.observedAtMs)) continue;
    const window = normalizeWindowKind(o.kind);
    const key = [o.provider, o.account, window, o.group, o.model ?? ""].join("\u0000");
    const list = series.get(key) ?? [];
    list.push(o);
    series.set(key, list);
  }

  const instances: Instance[] = [];
  for (const list of series.values()) {
    list.sort((a, b) => a.resetsAtMs - b.resetsAtMs || a.observedAtMs - b.observedAtMs);
    const clusters: QuotaWindowObservation[][] = [];
    for (const o of list) {
      const current = clusters.at(-1);
      const last = current?.at(-1);
      if (current && last && o.resetsAtMs - last.resetsAtMs <= RESET_CLUSTER_MS) current.push(o);
      else clusters.push([o]);
    }

    // One account has one instance of a limit open at a time. Instances of
    // the same series observed live at overlapping times therefore come from
    // accounts that were not told apart (e.g. no account identity recorded).
    const live = clusters.map((cluster) => ({
      from: Math.min(...cluster.map((o) => o.observedAtMs)),
      to: Math.max(...cluster.map((o) => o.observedAtMs)),
    }));
    const concurrent = live.map((a, i) =>
      live.some((b, j) => j !== i && a.from < b.to && b.from < a.to),
    );

    let previousEnd: number | null = null;
    for (const [index, cluster] of clusters.entries()) {
      const first = cluster[0]!;
      const window = normalizeWindowKind(first.kind);
      const endMs = Math.max(...cluster.map((o) => o.resetsAtMs));
      const firstObserved = live[index]!.from;
      const latest = cluster.reduce((a, b) => (b.observedAtMs >= a.observedAtMs ? b : a));
      const duration = KNOWN_WINDOW_DURATIONS_MS[window];
      const mixed = concurrent[index]!;

      let startMs: number;
      let startMethod: WindowStartMethod;
      if (duration !== undefined) {
        startMs = endMs - duration;
        startMethod = "duration";
      } else if (previousEnd !== null && !mixed) {
        startMs = previousEnd;
        startMethod = "previous-reset";
      } else {
        startMs = Math.min(firstObserved, endMs);
        startMethod = "first-observation";
      }
      if (!mixed) {
        // Never overlap the previous instance of the same series.
        if (previousEnd !== null && startMs < previousEnd) startMs = previousEnd;
        previousEnd = endMs;
      }
      if (startMs >= endMs) continue;

      instances.push({
        provider: first.provider,
        account: first.account,
        window,
        group: first.group,
        model: first.model,
        startMs,
        endMs,
        startMethod,
        percentUsed: latest.percentUsed,
        observedAtMs: latest.observedAtMs,
        observations: cluster.length,
        concurrent: mixed,
        sessions: new Set(),
        responses: 0,
        totalTokens: 0,
        bySource: new Map(),
      });
    }
  }
  return instances;
}

/** Sums responses into the window instance covering each response's time. */
export function placeUsageOnQuotaWindows(
  observations: QuotaWindowObservation[],
  responses: WindowUsageResponse[],
): Omit<QuotaWindowUsage, "status" | "reason"> {
  const instances = buildWindowInstances(observations);
  const byProvider = new Map<string, Instance[]>();
  for (const instance of instances) {
    const list = byProvider.get(instance.provider) ?? [];
    list.push(instance);
    byProvider.set(instance.provider, list);
  }

  const unattributed = new Map<string, UnattributedRow>();
  function miss(
    provider: string | null,
    window: string | null,
    reason: UnattributedReason,
    r: WindowUsageResponse,
  ) {
    const key = [provider ?? "", window ?? "", reason].join("\u0000");
    const row = unattributed.get(key) ?? { provider, window, reason, responses: 0, totalTokens: 0 };
    row.responses += 1;
    row.totalTokens += r.totalTokens;
    unattributed.set(key, row);
  }

  for (const r of responses) {
    if (!r.providerID || r.createdMs === null || !Number.isFinite(r.createdMs)) {
      miss(r.providerID ? quotaProviderFor(r.providerID) : null, null, "no-provider-or-time", r);
      continue;
    }
    const provider = quotaProviderFor(r.providerID);
    const candidates = byProvider.get(provider);
    if (!candidates) {
      miss(provider, null, "no-window", r);
      continue;
    }

    // Each limit (window kind, group, model scope) is attributed independently.
    const limits = new Map<string, Instance[]>();
    for (const instance of candidates) {
      const key = [instance.window, instance.group, instance.model ?? ""].join("\u0000");
      const list = limits.get(key) ?? [];
      list.push(instance);
      limits.set(key, list);
    }
    for (const list of limits.values()) {
      const t = r.createdMs;
      const covering = list.filter((i) => t >= i.startMs && t < i.endMs);
      const accounts = new Set(covering.map((i) => i.account));
      const window = list[0]!.window;
      if (covering.length === 0) {
        miss(provider, window, "outside-known-windows", r);
      } else if (accounts.size > 1 || covering.some((i) => i.concurrent)) {
        miss(provider, window, "ambiguous-account", r);
      } else {
        const instance = covering[0]!;
        instance.sessions.add(r.sessionKey);
        instance.responses += 1;
        instance.totalTokens += r.totalTokens;
        const share = instance.bySource.get(r.source) ?? {
          source: r.source,
          responses: 0,
          totalTokens: 0,
        };
        share.responses += 1;
        share.totalTokens += r.totalTokens;
        instance.bySource.set(r.source, share);
      }
    }
  }

  const windows: QuotaWindowRow[] = instances
    .map((i) => ({
      provider: i.provider,
      account: i.account,
      window: i.window,
      group: i.group,
      model: i.model,
      startMs: i.startMs,
      endMs: i.endMs,
      startMethod: i.startMethod,
      percentUsed: i.percentUsed,
      observedAtMs: i.observedAtMs,
      observations: i.observations,
      concurrent: i.concurrent,
      sessions: i.sessions.size,
      responses: i.responses,
      totalTokens: i.totalTokens,
      bySource: [...i.bySource.values()].sort((a, b) => a.source.localeCompare(b.source)),
    }))
    .sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) ||
        a.window.localeCompare(b.window) ||
        a.group.localeCompare(b.group) ||
        a.account.localeCompare(b.account) ||
        a.startMs - b.startMs,
    );

  return {
    windows,
    unattributed: [...unattributed.values()].sort(
      (a, b) =>
        (a.provider ?? "").localeCompare(b.provider ?? "") ||
        (a.window ?? "").localeCompare(b.window ?? "") ||
        a.reason.localeCompare(b.reason),
    ),
  };
}

/** Keeps only windows that overlap the report range. */
export function windowsInRange(
  usage: Omit<QuotaWindowUsage, "status" | "reason">,
  sinceMs: number | undefined,
  untilMs: number | undefined,
): Omit<QuotaWindowUsage, "status" | "reason"> {
  return {
    ...usage,
    windows: usage.windows.filter(
      (w) =>
        (sinceMs === undefined || w.endMs > sinceMs) &&
        (untilMs === undefined || w.startMs <= untilMs),
    ),
  };
}

export function getQuotaHistoryDbPath(): string {
  return join(dirname(getOpenCodeDbPath()), "quota-dashboard.db");
}

type SnapshotRow = { provider: string; captured_at: number; quota_data: string };

function parseSnapshot(row: SnapshotRow): QuotaWindowObservation[] {
  let data: any;
  try {
    data = JSON.parse(row.quota_data);
  } catch {
    return [];
  }
  if (!data || !Array.isArray(data.limits)) return [];
  const observedAtMs =
    typeof data.observation?.observedAt === "number"
      ? data.observation.observedAt
      : row.captured_at;
  const account =
    typeof data.accountIdentity === "string" && /^[a-f0-9]{64}$/u.test(data.accountIdentity)
      ? data.accountIdentity
      : "unknown";
  const out: QuotaWindowObservation[] = [];
  for (const limit of data.limits) {
    if (!limit || typeof limit.kind !== "string" || typeof limit.resets_at !== "string") continue;
    const resetsAtMs = Date.parse(limit.resets_at);
    if (!Number.isFinite(resetsAtMs)) continue;
    out.push({
      provider: row.provider,
      account,
      kind: limit.kind,
      group: typeof limit.group === "string" ? limit.group : "",
      model: typeof limit.scope?.model === "string" ? limit.scope.model : null,
      observedAtMs,
      resetsAtMs,
      percentUsed:
        typeof limit.percent === "number" && Number.isFinite(limit.percent) ? limit.percent : null,
    });
  }
  return out;
}

/**
 * Reads recorded quota limits from the history database, read-only. Weekly
 * windows reset up to seven days after they are observed, so reads start a
 * little over a week before the report range.
 */
export async function readQuotaWindowObservations(params: {
  sinceMs?: number;
  dbPath?: string;
}): Promise<QuotaWindowObservation[] | null> {
  const dbPath = params.dbPath ?? getQuotaHistoryDbPath();
  if (!existsSync(dbPath)) return null;
  const since = params.sinceMs === undefined ? 0 : params.sinceMs - 8 * DAY_MS;
  const conn = await openOpenCodeSqliteReadOnly(dbPath);
  try {
    const rows = conn.all<SnapshotRow>(
      `SELECT provider, captured_at, quota_data FROM quota_snapshots
       WHERE CASE WHEN json_valid(quota_data)
         THEN COALESCE(json_extract(quota_data, '$.observation.observedAt'), captured_at)
         ELSE captured_at END >= ?
       ORDER BY captured_at ASC`,
      [since],
    );
    return rows.flatMap(parseSnapshot);
  } finally {
    conn.close();
  }
}
