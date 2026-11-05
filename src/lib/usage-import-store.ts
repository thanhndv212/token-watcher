/**
 * Session Knowledge usage imports (UA-TW-04).
 *
 * Imports per-session records in usage import contract 1 (UA-TW-01) into a
 * separate store, `session-knowledge-imports.json`, next to the quota history
 * database. Nothing is written to the daily or provider history.
 *
 * Imports are additive and idempotent: records are keyed by
 * `(machineId, source, sessionId)`, a record replaces the stored one only
 * when it differs, and re-importing the same file changes nothing. Only the
 * allow-listed fields `parseUsageImportRecord()` returns are stored, so
 * titles, messages, prompts and any other text never reach disk or output.
 * Rejected lines are reported by line number and reason only.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { getOpenCodeDbPath } from "./opencode-storage.js";
import {
  importedTokenUsage,
  parseUsageImportRecord,
  tokenOwner,
  usageImportKey,
  USAGE_IMPORT_CONTRACT_VERSION,
  type TokenOwner,
  type UsageImportRecord,
} from "./usage-import-contract.js";

export const IMPORT_STORE_VERSION = 1;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_RECORDS = 200_000;
const MAX_REJECTIONS_LISTED = 20;

export type UsageImportStore = {
  version: typeof IMPORT_STORE_VERSION;
  contract: typeof USAGE_IMPORT_CONTRACT_VERSION;
  updatedAtMs: number;
  records: UsageImportRecord[];
};

export type ImportResult = {
  storePath: string;
  read: number;
  added: number;
  updated: number;
  unchanged: number;
  rejected: number;
  /** First rejections, by 1-based line (or array index) and reason; never the line's content. */
  rejections: { line: number; error: string }[];
  stored: number;
};

export type StoreRead =
  | { status: "read"; path: string; records: UsageImportRecord[] }
  | { status: "not-found"; path: string; records: [] }
  | { status: "unreadable"; path: string; reason: string; records: [] };

/** `TOKEN_WATCHER_IMPORT_STORE` overrides the default location next to the quota history. */
export function getUsageImportStorePath(): string {
  const override = process.env.TOKEN_WATCHER_IMPORT_STORE?.trim();
  if (override) return override;
  return join(dirname(getOpenCodeDbPath()), "session-knowledge-imports.json");
}

/** Splits an export into raw records: a JSON array, or one JSON object per line. */
function splitInput(text: string): { line: number; value: unknown; error?: string }[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    let values: unknown;
    try {
      values = JSON.parse(trimmed);
    } catch {
      return [{ line: 1, value: null, error: "file is not valid JSON" }];
    }
    if (!Array.isArray(values)) return [{ line: 1, value: null, error: "expected an array" }];
    return values.map((value, index) => ({ line: index + 1, value }));
  }
  const out: { line: number; value: unknown; error?: string }[] = [];
  text.split(/\r?\n/u).forEach((raw, index) => {
    if (raw.trim() === "") return;
    try {
      out.push({ line: index + 1, value: JSON.parse(raw) });
    } catch {
      out.push({ line: index + 1, value: null, error: "line is not valid JSON" });
    }
  });
  return out;
}

function sortRecords(records: Iterable<UsageImportRecord>): UsageImportRecord[] {
  return [...records].sort((a, b) => usageImportKey(a).localeCompare(usageImportKey(b)));
}

export function readUsageImportStore(path = getUsageImportStorePath()): StoreRead {
  if (!existsSync(path)) return { status: "not-found", path, records: [] };
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (
      data?.version !== IMPORT_STORE_VERSION ||
      data?.contract !== USAGE_IMPORT_CONTRACT_VERSION ||
      !Array.isArray(data.records)
    ) {
      return { status: "unreadable", path, reason: "unsupported store version", records: [] };
    }
    // Re-validate on read so a hand-edited store can't bypass the contract.
    const records: UsageImportRecord[] = [];
    for (const raw of data.records) {
      const parsed = parseUsageImportRecord(toContractShape(raw));
      if (!parsed.ok) {
        return { status: "unreadable", path, reason: "store holds an invalid record", records: [] };
      }
      records.push(parsed.record);
    }
    return { status: "read", path, records };
  } catch {
    return { status: "unreadable", path, reason: "store is not valid JSON", records: [] };
  }
}

/** Converts a stored record (epoch ms) back to the wire shape (ISO strings) for re-validation. */
function toContractShape(raw: any): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const iso = (ms: unknown) =>
    typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : (ms ?? null);
  const { startedAtMs, endedAtMs, ...rest } = raw;
  return { ...rest, startedAt: iso(startedAtMs), endedAt: iso(endedAtMs) };
}

function writeStore(path: string, records: UsageImportRecord[], nowMs: number): void {
  const store: UsageImportStore = {
    version: IMPORT_STORE_VERSION,
    contract: USAGE_IMPORT_CONTRACT_VERSION,
    updatedAtMs: nowMs,
    records: sortRecords(records),
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Imports a Session Knowledge export file into the store. The store is not
 * written when nothing changed, and is never written if it can't be read.
 */
export function importUsageRecordsFromFile(
  file: string,
  options: { storePath?: string; nowMs?: number } = {},
): ImportResult {
  const storePath = options.storePath ?? getUsageImportStorePath();
  if (statSync(file).size > MAX_INPUT_BYTES) {
    throw new Error(`Import file is larger than ${MAX_INPUT_BYTES / 1024 / 1024} MB.`);
  }
  return importUsageRecords(readFileSync(file, "utf8"), { ...options, storePath });
}

export function importUsageRecords(
  text: string,
  options: { storePath?: string; nowMs?: number } = {},
): ImportResult {
  const storePath = options.storePath ?? getUsageImportStorePath();
  const existing = readUsageImportStore(storePath);
  if (existing.status === "unreadable") {
    throw new Error(`Import store ${storePath} can't be read (${existing.reason}); not changed.`);
  }

  const byKey = new Map(existing.records.map((r) => [usageImportKey(r), r]));
  const result: ImportResult = {
    storePath,
    read: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
    rejected: 0,
    rejections: [],
    stored: 0,
  };
  const reject = (line: number, error: string) => {
    result.rejected += 1;
    if (result.rejections.length < MAX_REJECTIONS_LISTED) result.rejections.push({ line, error });
  };

  for (const entry of splitInput(text)) {
    result.read += 1;
    if (entry.error) {
      reject(entry.line, entry.error);
      continue;
    }
    const parsed = parseUsageImportRecord(entry.value);
    if (!parsed.ok) {
      reject(entry.line, parsed.error);
      continue;
    }
    const key = usageImportKey(parsed.record);
    const previous = byKey.get(key);
    if (!previous) {
      if (byKey.size >= MAX_RECORDS) {
        reject(entry.line, `store already holds ${MAX_RECORDS} records`);
        continue;
      }
      result.added += 1;
    } else if (JSON.stringify(previous) === JSON.stringify(parsed.record)) {
      result.unchanged += 1;
      continue;
    } else {
      result.updated += 1;
    }
    byKey.set(key, parsed.record);
  }

  result.stored = byKey.size;
  if (result.added > 0 || result.updated > 0) {
    writeStore(storePath, [...byKey.values()], options.nowMs ?? Date.now());
  }
  return result;
}

// ---------------------------------------------------------------------------
// Report summary
// ---------------------------------------------------------------------------

export type ImportedSourceRow = {
  source: string;
  /** `native`: tokens come from Token Watcher's own reader; `import`: from the record; `none`: activity only. */
  owner: TokenOwner;
  sessions: number;
  userTurns: number | null;
  assistantTurns: number | null;
  toolCalls: number | null;
  /** Imported tokens; null for native and activity-only sources. */
  importedTokens: number | null;
  /** Sessions with a git-proxy outcome. */
  withOutcome: number;
};

export type OutcomeProxySummary = {
  /** Outcomes are linked by Session Knowledge from git history, not proof of delivered work. */
  method: "git-proxy";
  sessions: number;
  commits: number;
  pullRequests: number;
  /** This machine's native sessions in range that have a linked outcome. */
  matchedNativeSessions: number;
  matchedTokens: number;
  /** Cost of matched sessions; null when none is priced. */
  matchedCostUsd: number | null;
  /** Distinct commits on matched sessions. */
  matchedCommits: number;
  costPerCommitUsd: number | null;
  /** Outcome sessions from this machine with no native session in range. */
  unmatchedLocal: number;
  /** Outcome sessions recorded on other machines (their tokens are not read here). */
  otherMachines: number;
};

export type ImportedUsageSummary = {
  status: "read" | "not-found" | "unavailable";
  reason?: string;
  storedRecords: number;
  inRange: number;
  /** Records with no start time; not placed in any range. */
  undated: number;
  bySource: ImportedSourceRow[];
  outcomes: OutcomeProxySummary;
};

function addNullable(a: number | null, b: number | null): number | null {
  if (b === null) return a;
  return (a ?? 0) + b;
}

function emptyOutcomes(): OutcomeProxySummary {
  return {
    method: "git-proxy",
    sessions: 0,
    commits: 0,
    pullRequests: 0,
    matchedNativeSessions: 0,
    matchedTokens: 0,
    matchedCostUsd: null,
    matchedCommits: 0,
    costPerCommitUsd: null,
    unmatchedLocal: 0,
    otherMachines: 0,
  };
}

/**
 * Summarises imported records in range and joins outcomes to this machine's
 * native sessions. Tokens for native sources always come from `nativeSessions`.
 */
export function summariseImports(params: {
  store: StoreRead;
  sinceMs: number | null;
  untilMs: number | null;
  machineId: string;
  nativeSessions: {
    source: string;
    sessionID: string;
    totalTokens: number;
    costUsd: number | null;
  }[];
}): ImportedUsageSummary {
  const { store } = params;
  const base: ImportedUsageSummary = {
    status: store.status === "unreadable" ? "unavailable" : store.status,
    ...(store.status === "unreadable" ? { reason: store.reason } : {}),
    storedRecords: store.records.length,
    inRange: 0,
    undated: 0,
    bySource: [],
    outcomes: emptyOutcomes(),
  };
  if (store.status !== "read") return base;

  const native = new Map(
    params.nativeSessions.map((s) => [
      usageImportKey({ machineId: params.machineId, ...s, sessionId: s.sessionID }),
      s,
    ]),
  );
  const rows = new Map<string, ImportedSourceRow>();
  const commits = new Set<string>();
  const prs = new Set<string>();
  const matchedCommits = new Set<string>();
  const outcomes = base.outcomes;

  for (const r of store.records) {
    if (r.startedAtMs === null) {
      base.undated += 1;
      continue;
    }
    if (params.sinceMs !== null && r.startedAtMs < params.sinceMs) continue;
    if (params.untilMs !== null && r.startedAtMs > params.untilMs) continue;
    base.inRange += 1;

    const row = rows.get(r.source) ?? {
      source: r.source,
      owner: tokenOwner(r),
      sessions: 0,
      userTurns: null,
      assistantTurns: null,
      toolCalls: null,
      importedTokens: null,
      withOutcome: 0,
    };
    // A source owns its tokens if any record reports them.
    if (row.owner === "none" && tokenOwner(r) === "import") row.owner = "import";
    row.sessions += 1;
    row.userTurns = addNullable(row.userTurns, r.activity.userTurns);
    row.assistantTurns = addNullable(row.assistantTurns, r.activity.assistantTurns);
    row.toolCalls = addNullable(row.toolCalls, r.activity.toolCalls);
    const imported = importedTokenUsage(r);
    if (imported) {
      const sum = [
        imported.input,
        imported.output,
        imported.cacheRead,
        imported.cacheWrite,
        imported.reasoning,
      ].reduce<number | null>((acc, v) => addNullable(acc, v), null);
      row.importedTokens = addNullable(row.importedTokens, sum);
    }
    rows.set(r.source, row);

    const outcome = r.outcome;
    if (!outcome || (outcome.commits.length === 0 && outcome.pullRequests.length === 0)) continue;
    row.withOutcome += 1;
    outcomes.sessions += 1;
    outcome.commits.forEach((c) => commits.add(c));
    outcome.pullRequests.forEach((p) => prs.add(p));
    if (r.machineId !== params.machineId) {
      outcomes.otherMachines += 1;
      continue;
    }
    const match = native.get(usageImportKey(r));
    if (!match) {
      outcomes.unmatchedLocal += 1;
      continue;
    }
    outcomes.matchedNativeSessions += 1;
    outcomes.matchedTokens += match.totalTokens;
    outcomes.matchedCostUsd = addNullable(outcomes.matchedCostUsd, match.costUsd);
    outcome.commits.forEach((c) => matchedCommits.add(c));
  }

  outcomes.commits = commits.size;
  outcomes.pullRequests = prs.size;
  outcomes.matchedCommits = matchedCommits.size;
  outcomes.costPerCommitUsd =
    outcomes.matchedCostUsd !== null && matchedCommits.size > 0
      ? outcomes.matchedCostUsd / matchedCommits.size
      : null;
  base.bySource = [...rows.values()].sort((a, b) => a.source.localeCompare(b.source));
  return base;
}
