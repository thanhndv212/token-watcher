/**
 * Cross-machine session usage, sync format version 3 (UA-TW-06).
 *
 * Version 2 (`token-sync/<hostname>.json`) carries OpenCode sessions only and
 * records one provider/model per session. Version 3 is written beside it as
 * `token-sync/<machineId>.v3.json`. It carries Claude Code, OpenCode and Codex
 * root sessions keyed by Session Knowledge machine id, with tokens per
 * provider/model. Version 2 keeps being written, so older Token Watcher
 * installs (which skip any file whose version is not 2) keep working and a
 * downgrade is a rollback.
 *
 * Merging is deterministic and idempotent: every session is keyed by
 * `(source, sessionID)` and counted once, local sessions first, then version
 * 3 files, then version 2 files, newest export first. This machine's own
 * files are never read back as remote usage. Only ids, timestamps, model
 * names and counts are stored, never conversation text or titles.
 */

import type { MachineIdentity } from "./machine-identity.js";
import { normalizeHostname } from "./machine-identity.js";
import type { SessionUsageSource, TaggedMessage } from "./session-usage.js";
import {
  addTokenBuckets,
  emptyTokenBuckets,
  tokenBucketsFromMessage,
  totalTokenBuckets,
  type TokenBuckets,
} from "./token-buckets.js";

export const SYNC_V3_VERSION = 3;
export const SYNC_V3_SUFFIX = ".v3.json";

const SOURCES: readonly SessionUsageSource[] = ["claude-code", "opencode", "codex"];
const MAX_ID = 200;
const MAX_SESSIONS = 100_000;
const MAX_MODELS = 50;

/** Tokens and responses for one provider/model within a session. */
export type SyncedModelUsageV3 = {
  n: number;
  i: number;
  o: number;
  r: number;
  cr: number;
  cw: number;
};

export type SyncedSessionV3 = {
  /** source */
  s: SessionUsageSource;
  /** root session id */
  id: string;
  /** first and last response time, epoch ms; null when undated */
  t0: number | null;
  t1: number | null;
  /** "<provider>/<model>" -> usage */
  m: Record<string, SyncedModelUsageV3>;
};

export type SyncedMachineExportV3 = {
  version: 3;
  machineId: string;
  hostname: string;
  mapped: boolean;
  exportedAt: number;
  /** Sources read on the exporting machine; `read` with zero sessions is real zero. */
  sources: { source: SessionUsageSource; status: "read" | "not-found" | "unavailable" }[];
  sessions: SyncedSessionV3[];
};

export type RemoteModelUsage = {
  provider: string;
  model: string;
  /** Null for version 2 records, which do not record responses. */
  responses: number | null;
  tokens: TokenBuckets;
};

export type RemoteSession = {
  machineId: string;
  source: SessionUsageSource;
  sessionID: string;
  startMs: number | null;
  endMs: number | null;
  models: RemoteModelUsage[];
};

export type ParsedSyncFile = {
  file: string;
  version: 2 | 3;
  machineId: string;
  hostname: string;
  mapped: boolean;
  exportedAt: number;
  sessions: RemoteSession[];
};

export type SyncedMachineSummary = {
  machineId: string;
  hostname: string;
  mapped: boolean;
  version: 2 | 3;
  file: string;
  exportedAt: number;
  /** Sessions counted from this file. */
  sessions: number;
  /** Sessions skipped as already counted locally or from another file. */
  duplicates: number;
};

export type MergedRemoteUsage = {
  sessions: RemoteSession[];
  machines: SyncedMachineSummary[];
  /** Files skipped as this machine's own, or unreadable, with the reason. */
  skippedFiles: { file: string; reason: "own-machine" | "superseded" | "invalid" }[];
};

/** Turns a machine id into a safe file name stem. */
export function syncFileStem(machineId: string): string {
  const stem = machineId.replace(/[^A-Za-z0-9._-]/gu, "_").replace(/^\.+/u, "_");
  return stem.slice(0, MAX_ID) || "unknown";
}

export function syncSessionKey(source: string, sessionID: string): string {
  return `${source}\u0000${sessionID}`;
}

function modelKey(providerID: string | undefined, modelID: string | undefined): string {
  return `${providerID || "unknown"}/${modelID || "unknown"}`;
}

/** Builds this machine's version 3 export from tagged local responses. */
export function buildSyncExportV3(params: {
  tagged: TaggedMessage[];
  coverage: Map<SessionUsageSource, { status: "read" | "not-found" | "unavailable" }>;
  machine: MachineIdentity;
  nowMs: number;
}): SyncedMachineExportV3 {
  const sessions = new Map<string, SyncedSessionV3>();
  for (const t of params.tagged) {
    const tokens = tokenBucketsFromMessage(t.message);
    if (totalTokenBuckets(tokens) === 0) continue;
    const key = syncSessionKey(t.source, t.rootID);
    let session = sessions.get(key);
    if (!session) {
      session = { s: t.source, id: t.rootID, t0: null, t1: null, m: {} };
      sessions.set(key, session);
    }
    const created = t.message.time?.created;
    if (typeof created === "number" && Number.isFinite(created)) {
      session.t0 = session.t0 === null ? created : Math.min(session.t0, created);
      session.t1 = session.t1 === null ? created : Math.max(session.t1, created);
    }
    const mk = modelKey(t.message.providerID, t.message.modelID);
    const usage = session.m[mk] ?? { n: 0, i: 0, o: 0, r: 0, cr: 0, cw: 0 };
    usage.n += 1;
    usage.i += tokens.input;
    usage.o += tokens.output;
    usage.r += tokens.reasoning;
    usage.cr += tokens.cache_read;
    usage.cw += tokens.cache_write;
    session.m[mk] = usage;
  }

  // Sorted so repeated exports of the same data are byte-identical apart from exportedAt.
  const sorted = [...sessions.values()]
    .sort((a, b) => a.s.localeCompare(b.s) || a.id.localeCompare(b.id))
    .map((session) => ({
      ...session,
      m: Object.fromEntries(Object.entries(session.m).sort(([a], [b]) => a.localeCompare(b))),
    }));

  return {
    version: 3,
    machineId: params.machine.machineId,
    hostname: params.machine.hostname,
    mapped: params.machine.mapped,
    exportedAt: params.nowMs,
    sources: SOURCES.map((source) => ({
      source,
      status: params.coverage.get(source)?.status ?? "not-found",
    })),
    sessions: sorted,
  };
}

function isId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID &&
    !/[\r\n]/u.test(value)
  );
}

function count(value: unknown): number | null {
  if (value === undefined) return 0;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function time(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function splitModelKey(key: string): { provider: string; model: string } {
  const slash = key.indexOf("/");
  return slash < 0
    ? { provider: key, model: "unknown" }
    : { provider: key.slice(0, slash), model: key.slice(slash + 1) };
}

function parseTokens(u: any): TokenBuckets | null {
  if (!u || typeof u !== "object") return null;
  const values = [count(u.i), count(u.o), count(u.r), count(u.cr), count(u.cw)];
  if (values.some((v) => v === null)) return null;
  const [input, output, reasoning, cache_read, cache_write] = values as number[];
  return { input, output, reasoning, cache_read, cache_write };
}

/**
 * Parses one sync file. Returns null for anything that is not a valid version
 * 2 or 3 export; a single bad session rejects the file rather than counting
 * part of it.
 */
export function parseSyncFile(file: string, raw: string): ParsedSyncFile | null {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const exportedAt = time(data.exportedAt);
  if (exportedAt === undefined || exportedAt === null) return null;

  if (data.version === 2) {
    if (!isId(data.machine) || !data.sessions || typeof data.sessions !== "object") return null;
    const entries = Object.entries(data.sessions);
    if (entries.length > MAX_SESSIONS) return null;
    const sessions: RemoteSession[] = [];
    for (const [sessionID, rec] of entries) {
      const tokens = parseTokens(rec);
      if (!isId(sessionID) || !tokens || !isId((rec as any).k)) return null;
      sessions.push({
        machineId: data.machine,
        source: "opencode",
        sessionID,
        startMs: null,
        endMs: null,
        models: [{ ...splitModelKey((rec as any).k), responses: null, tokens }],
      });
    }
    return {
      file,
      version: 2,
      machineId: data.machine,
      hostname: data.machine,
      mapped: false,
      exportedAt,
      sessions,
    };
  }

  if (data.version === 3) {
    if (!isId(data.machineId) || !isId(data.hostname) || typeof data.mapped !== "boolean")
      return null;
    if (!Array.isArray(data.sessions) || data.sessions.length > MAX_SESSIONS) return null;
    const sessions: RemoteSession[] = [];
    for (const s of data.sessions) {
      if (!s || typeof s !== "object" || !SOURCES.includes(s.s) || !isId(s.id)) return null;
      const t0 = time(s.t0);
      const t1 = time(s.t1);
      if (t0 === undefined || t1 === undefined) return null;
      if (!s.m || typeof s.m !== "object") return null;
      const entries = Object.entries(s.m);
      if (entries.length === 0 || entries.length > MAX_MODELS) return null;
      const models: RemoteModelUsage[] = [];
      for (const [key, u] of entries) {
        const tokens = parseTokens(u);
        const responses = count((u as any)?.n);
        if (!isId(key) || !tokens || responses === null) return null;
        models.push({ ...splitModelKey(key), responses, tokens });
      }
      sessions.push({
        machineId: data.machineId,
        source: s.s,
        sessionID: s.id,
        startMs: t0,
        endMs: t1,
        models,
      });
    }
    return {
      file,
      version: 3,
      machineId: data.machineId,
      hostname: data.hostname,
      mapped: data.mapped,
      exportedAt,
      sessions,
    };
  }
  return null;
}

/**
 * Merges remote sync files with this machine's sessions, counting each
 * `(source, sessionID)` once.
 */
export function mergeRemoteSessions(params: {
  files: (ParsedSyncFile | { file: string; invalid: true })[];
  localKeys: ReadonlySet<string>;
  local: { machineId: string; hostname: string };
}): MergedRemoteUsage {
  const localHost = normalizeHostname(params.local.hostname);
  const skippedFiles: MergedRemoteUsage["skippedFiles"] = [];
  const valid: ParsedSyncFile[] = [];
  for (const f of params.files) {
    if ("invalid" in f) skippedFiles.push({ file: f.file, reason: "invalid" });
    else valid.push(f);
  }

  const isOwn = (f: ParsedSyncFile) =>
    f.version === 3
      ? f.machineId === params.local.machineId || normalizeHostname(f.hostname) === localHost
      : normalizeHostname(f.hostname) === localHost;
  // A version 2 file is superseded by a version 3 file from the same host.
  const v3Hosts = new Set(
    valid.filter((f) => f.version === 3).map((f) => normalizeHostname(f.hostname)),
  );

  const ordered = valid
    .filter((f) => {
      if (isOwn(f)) {
        skippedFiles.push({ file: f.file, reason: "own-machine" });
        return false;
      }
      if (f.version === 2 && v3Hosts.has(normalizeHostname(f.hostname))) {
        skippedFiles.push({ file: f.file, reason: "superseded" });
        return false;
      }
      return true;
    })
    .sort(
      (a, b) =>
        b.version - a.version || b.exportedAt - a.exportedAt || a.file.localeCompare(b.file),
    );

  const seen = new Set(params.localKeys);
  const sessions: RemoteSession[] = [];
  const machines: SyncedMachineSummary[] = [];
  for (const f of ordered) {
    let counted = 0;
    let duplicates = 0;
    for (const session of f.sessions) {
      const key = syncSessionKey(session.source, session.sessionID);
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);
      sessions.push(session);
      counted += 1;
    }
    machines.push({
      machineId: f.machineId,
      hostname: f.hostname,
      mapped: f.mapped,
      version: f.version,
      file: f.file,
      exportedAt: f.exportedAt,
      sessions: counted,
      duplicates,
    });
  }
  machines.sort((a, b) => a.machineId.localeCompare(b.machineId) || a.file.localeCompare(b.file));
  skippedFiles.sort((a, b) => a.file.localeCompare(b.file));
  return { sessions, machines, skippedFiles };
}

/** Keys of every local session, by root and by raw session id. */
export function localSessionKeys(tagged: TaggedMessage[], extraOpenCodeIDs: string[] = []) {
  const keys = new Set<string>();
  for (const t of tagged) {
    keys.add(syncSessionKey(t.source, t.rootID));
    keys.add(syncSessionKey(t.source, t.message.sessionID));
  }
  for (const id of extraOpenCodeIDs) keys.add(syncSessionKey("opencode", id));
  return keys;
}

export function remoteSessionTokens(session: RemoteSession): TokenBuckets {
  return session.models.reduce((sum, m) => addTokenBuckets(sum, m.tokens), emptyTokenBuckets());
}
