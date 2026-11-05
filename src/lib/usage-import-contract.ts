/**
 * Session Knowledge usage import contract, version 1 (UA-TW-01).
 *
 * Session Knowledge exports one record per session; Token Watcher consumes
 * them. Records are keyed by `(machineId, source, sessionId)`; every other
 * field is nullable, and a missing value stays `null` rather than zero.
 *
 * Source-of-truth rule: Token Watcher's native readers own token values for
 * Claude Code, OpenCode and Codex. For those sources an imported record only
 * contributes activity, project and outcome metadata, and its `usage` is
 * ignored even when it is reported. Other sources (for example Copilot and
 * Zcode) own their token values only when the record reports them, otherwise
 * they are activity-only.
 *
 * The parser copies allow-listed fields only, so conversation text, titles or
 * tool payloads in an export never reach Token Watcher storage or output.
 * Strings are length-bounded identifiers; anything else is rejected.
 */

import { SESSION_USAGE_SOURCES, type SessionUsageSource } from "./session-usage.js";

export const USAGE_IMPORT_CONTRACT_VERSION = 1;

const MAX_ID_LENGTH = 200;
const MAX_LIST_LENGTH = 50;
const SOURCE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;
const PULL_REQUEST_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+$/;

export type ReportedImportUsage = {
  method: "reported";
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
};

export type ImportUsage = ReportedImportUsage | { method: "unavailable" };

export type ImportActivity = {
  userTurns: number | null;
  assistantTurns: number | null;
  toolCalls: number | null;
};

export type ImportOutcome = {
  method: "git-proxy";
  commits: string[];
  pullRequests: string[];
};

export type UsageImportRecord = {
  contract: typeof USAGE_IMPORT_CONTRACT_VERSION;
  machineId: string;
  source: string;
  sessionId: string;
  parentSessionId: string | null;
  isSubagent: boolean | null;
  projectId: string | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  models: string[];
  activity: ImportActivity;
  usage: ImportUsage;
  outcome: ImportOutcome | null;
};

export type ParseUsageImportResult =
  | { ok: true; record: UsageImportRecord }
  | { ok: false; error: string };

export type TokenOwner = "native" | "import" | "none";

class ContractError extends Error {}

function fail(message: string): never {
  throw new ContractError(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function id(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${field} must be a non-empty string`);
  if (value.length > MAX_ID_LENGTH || /[\r\n\t]/.test(value)) {
    fail(`${field} must be a single-line identifier of at most ${MAX_ID_LENGTH} characters`);
  }
  return value;
}

function optionalId(value: unknown, field: string): string | null {
  return value === undefined || value === null ? null : id(value, field);
}

function count(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(`${field} must be a non-negative integer or null`);
  }
  return value;
}

function timestamp(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) fail(`${field} must be an ISO 8601 timestamp or null`);
  return ms;
}

function idList(value: unknown, field: string, pattern?: RegExp): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST_LENGTH) {
    fail(`${field} must be an array of at most ${MAX_LIST_LENGTH} entries`);
  }
  return [
    ...new Set(
      value.map((entry, index) => {
        const parsed = id(entry, `${field}[${index}]`);
        if (pattern && !pattern.test(parsed)) fail(`${field}[${index}] has an invalid format`);
        return parsed;
      }),
    ),
  ];
}

function parseUsage(value: unknown): ImportUsage {
  if (value === undefined || value === null) return { method: "unavailable" };
  if (!isObject(value)) fail("usage must be an object");
  if (value.method === "unavailable") return { method: "unavailable" };
  if (value.method === "estimated") {
    fail("usage.method 'estimated' is reserved and not accepted by contract 1");
  }
  if (value.method !== "reported") fail("usage.method must be 'reported' or 'unavailable'");
  return {
    method: "reported",
    input: count(value.input, "usage.input"),
    output: count(value.output, "usage.output"),
    cacheRead: count(value.cacheRead, "usage.cacheRead"),
    cacheWrite: count(value.cacheWrite, "usage.cacheWrite"),
    reasoning: count(value.reasoning, "usage.reasoning"),
  };
}

function parseActivity(value: unknown): ImportActivity {
  if (value === undefined || value === null) {
    return { userTurns: null, assistantTurns: null, toolCalls: null };
  }
  if (!isObject(value)) fail("activity must be an object");
  return {
    userTurns: count(value.userTurns, "activity.userTurns"),
    assistantTurns: count(value.assistantTurns, "activity.assistantTurns"),
    toolCalls: count(value.toolCalls, "activity.toolCalls"),
  };
}

function parseOutcome(value: unknown): ImportOutcome | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) fail("outcome must be an object");
  if (value.method === "none") return null;
  if (value.method !== "git-proxy") fail("outcome.method must be 'git-proxy' or 'none'");
  return {
    method: "git-proxy",
    commits: idList(value.commits, "outcome.commits", COMMIT_PATTERN),
    pullRequests: idList(value.pullRequests, "outcome.pullRequests", PULL_REQUEST_PATTERN),
  };
}

export function parseUsageImportRecord(value: unknown): ParseUsageImportResult {
  try {
    if (!isObject(value)) fail("record must be a JSON object");
    if (value.contract !== USAGE_IMPORT_CONTRACT_VERSION) {
      fail(`unsupported contract ${JSON.stringify(value.contract ?? null)}`);
    }
    const source = id(value.source, "source");
    if (!SOURCE_PATTERN.test(source)) fail("source must be a lower-case source id");
    if (
      value.isSubagent !== undefined &&
      value.isSubagent !== null &&
      typeof value.isSubagent !== "boolean"
    ) {
      fail("isSubagent must be a boolean or null");
    }

    const startedAtMs = timestamp(value.startedAt, "startedAt");
    const endedAtMs = timestamp(value.endedAt, "endedAt");
    if (startedAtMs !== null && endedAtMs !== null && endedAtMs < startedAtMs) {
      fail("endedAt is before startedAt");
    }

    return {
      ok: true,
      record: {
        contract: USAGE_IMPORT_CONTRACT_VERSION,
        machineId: id(value.machineId, "machineId"),
        source,
        sessionId: id(value.sessionId, "sessionId"),
        parentSessionId: optionalId(value.parentSessionId, "parentSessionId"),
        isSubagent: (value.isSubagent as boolean | null | undefined) ?? null,
        projectId: optionalId(value.projectId, "projectId"),
        startedAtMs,
        endedAtMs,
        models: idList(value.models, "models"),
        activity: parseActivity(value.activity),
        usage: parseUsage(value.usage),
        outcome: parseOutcome(value.outcome),
      },
    };
  } catch (error) {
    if (error instanceof ContractError) return { ok: false, error: error.message };
    throw error;
  }
}

export function usageImportKey(record: {
  machineId: string;
  source: string;
  sessionId: string;
}): string {
  return `${record.machineId}\u0000${record.source}\u0000${record.sessionId}`;
}

export function isNativeTokenSource(source: string): source is SessionUsageSource {
  return (SESSION_USAGE_SOURCES as readonly string[]).includes(source);
}

/** Who owns the token values for this record's session. */
export function tokenOwner(record: Pick<UsageImportRecord, "source" | "usage">): TokenOwner {
  if (isNativeTokenSource(record.source)) return "native";
  return record.usage.method === "reported" ? "import" : "none";
}

/**
 * Token values this record may contribute: `null` whenever a native reader
 * owns the source or the record reports no usage. Reports must take imported
 * tokens only through this function.
 */
export function importedTokenUsage(
  record: Pick<UsageImportRecord, "source" | "usage">,
): ReportedImportUsage | null {
  return tokenOwner(record) === "import" ? (record.usage as ReportedImportUsage) : null;
}
