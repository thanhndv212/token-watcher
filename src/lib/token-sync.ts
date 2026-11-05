/**
 * Cross-machine token usage sync via git.
 *
 * Each machine exports per-session token counts to `token-sync/<hostname>.json`
 * (version 2, OpenCode only) and `token-sync/<machineId>.v3.json` (version 3,
 * Claude Code, OpenCode and Codex; see token-sync-v3.ts). Git syncs these files
 * between machines.  On import, each (source, session) is counted once: local
 * sessions first, then version 3, then version 2 files — so merging is
 * additive and non-duplicating.
 */

import { readFile, writeFile } from "fs/promises";
import { readdirSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { hostname } from "os";

import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";

import type { TokenBuckets } from "./token-buckets.js";
import { emptyTokenBuckets, addTokenBuckets } from "./token-buckets.js";
import type { OpenCodeMessage } from "./opencode-storage.js";
import { iterAssistantMessages, readAllSessionsIndex } from "./opencode-storage.js";
import { calculateUsdFromTokenBuckets } from "./token-cost.js";
import { lookupUserCostSync } from "./user-pricing.js";
import { lookupCost } from "./modelsdev-pricing.js";
import { resolveMachineIdentity } from "./machine-identity.js";
import { loadSessionMessages, type SessionUsageDeps } from "./session-usage.js";
import {
  buildSyncExportV3,
  localSessionKeys,
  mergeRemoteSessions,
  parseSyncFile,
  syncFileStem,
  SYNC_V3_SUFFIX,
  type ParsedSyncFile,
  type SyncedMachineExportV3,
  type SyncedMachineSummary,
} from "./token-sync-v3.js";

// =============================================================================
// Types
// =============================================================================

const SYNC_DIRNAME = "token-sync";
const SYNC_VERSION = 2;

/** Per-session token record — compact for git-friendly diffs */
interface SyncedSessionRecord {
  /** provider/model key (e.g. "deepseek/deepseek-v4-pro") */
  k: string;
  /** raw tokens from the single message (we aggregate per-session before writing) */
  i: number; // input
  o: number; // output
  r?: number; // reasoning
  cr?: number; // cache_read
  cw?: number; // cache_write
}

export interface SyncedMachineExport {
  version: 2;
  machine: string;
  exportedAt: number;
  /** Map of sessionID → aggregated token record (one per session) */
  sessions: Record<string, SyncedSessionRecord>;
}

// =============================================================================
// Paths
// =============================================================================

function getTokenSyncDir(): string {
  if (process.env.OPENCODE_QUOTA_SYNC_DIR) {
    return process.env.OPENCODE_QUOTA_SYNC_DIR;
  }
  const { configDirs } = getOpencodeRuntimeDirCandidates();
  const base = configDirs[0] ?? process.cwd();
  const dir = join(base, "opencode-quota", SYNC_DIRNAME);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getMachineFileName(): string {
  return `${hostname()}.json`;
}

// =============================================================================
// Export
// =============================================================================

/**
 * Export this machine's token usage — one record per session for precise
 * deduplication on the receiving end.
 */
export async function exportTokenSync(
  deps: Partial<SessionUsageDeps> = {},
): Promise<SyncedMachineExport> {
  const messages = await iterAssistantMessages({});
  const sessionsIdx = await readAllSessionsIndex();

  // Aggregate tokens per session (sessions may have multiple assistant messages)
  const sessions = new Map<string, SyncedSessionRecord>();

  for (const msg of messages) {
    const tokens = extractTokens(msg);
    if (!tokens) continue;

    const sid = msg.sessionID;
    const existing = sessions.get(sid);
    if (existing) {
      existing.i += tokens.input ?? 0;
      existing.o += tokens.output ?? 0;
      existing.r = (existing.r ?? 0) + (tokens.reasoning ?? 0);
      existing.cr = (existing.cr ?? 0) + (tokens.cache_read ?? 0);
      existing.cw = (existing.cw ?? 0) + (tokens.cache_write ?? 0);
    } else {
      const provider = msg.providerID ?? "unknown";
      const model = msg.modelID ?? "unknown";
      sessions.set(sid, {
        k: `${provider}/${model}`,
        i: tokens.input ?? 0,
        o: tokens.output ?? 0,
        r: (tokens.reasoning ?? 0) || undefined,
        cr: (tokens.cache_read ?? 0) || undefined,
        cw: (tokens.cache_write ?? 0) || undefined,
      });
    }
  }

  const export_: SyncedMachineExport = {
    version: 2,
    machine: hostname(),
    exportedAt: Date.now(),
    sessions: Object.fromEntries(sessions),
  };

  const syncDir = getTokenSyncDir();
  const filePath = join(syncDir, getMachineFileName());
  await writeFile(filePath, JSON.stringify(export_, null, 2), "utf-8");

  // Version 3 beside version 2: older installs only read version 2 files.
  const v3 = await exportTokenSyncV3(deps);
  await writeFile(
    join(syncDir, `${syncFileStem(v3.machineId)}${SYNC_V3_SUFFIX}`),
    JSON.stringify(v3, null, 2),
    "utf-8",
  );

  return export_;
}

/** Builds this machine's version 3 export (all native sources, keyed by machine id). */
export async function exportTokenSyncV3(
  deps: Partial<SessionUsageDeps> = {},
  nowMs: number = Date.now(),
): Promise<SyncedMachineExportV3> {
  const { coverage, tagged } = await loadSessionMessages({}, deps);
  const machine = (deps.machine ?? resolveMachineIdentity)();
  return buildSyncExportV3({ tagged, coverage, machine, nowMs });
}

// =============================================================================
// Import / Merge
// =============================================================================

export interface MergedTokenData {
  totals: { tokens: TokenBuckets; messages: number; costUsd: number };
  byProviderModel: Array<{
    provider: string;
    model: string;
    tokens: TokenBuckets;
    messages: number;
    costUsd: number;
  }>;
  remoteSessionCount: number;
  totalSessionCount: number;
  /** Remote machine files counted, with sessions counted and duplicates skipped. */
  machines: SyncedMachineSummary[];
  /** Files not counted: this machine's own, superseded by version 3, or invalid. */
  skippedFiles: { file: string; reason: "own-machine" | "superseded" | "invalid" }[];
}

type ProviderModelTotals = Map<
  string,
  { provider: string; model: string; tokens: TokenBuckets; messages: number; costUsd: number }
>;

function addUsage(
  byProviderModel: ProviderModelTotals,
  totals: TokenBuckets & { messages: number; costUsd: number },
  provider: string,
  model: string,
  tokens: TokenBuckets,
  messages: number,
): void {
  const costRates = lookupUserCostSync(provider, model) ?? lookupCost(provider, model) ?? undefined;
  const costUsd = costRates ? calculateUsdFromTokenBuckets(costRates, tokens) : 0;
  const key = `${provider}/${model}`;
  const existing = byProviderModel.get(key);
  if (existing) {
    existing.tokens = addTokenBuckets(existing.tokens, tokens);
    existing.messages += messages;
    existing.costUsd += costUsd;
  } else {
    byProviderModel.set(key, { provider, model, tokens, messages, costUsd });
  }
  Object.assign(totals, addTokenBuckets(totals, tokens));
  totals.messages += messages;
  totals.costUsd += costUsd;
}

/** Reads and parses every sync file in the sync directory. */
export async function readSyncFiles(
  syncDir: string = getTokenSyncDir(),
): Promise<(ParsedSyncFile | { file: string; invalid: true })[]> {
  if (!existsSync(syncDir)) return [];
  const files: (ParsedSyncFile | { file: string; invalid: true })[] = [];
  for (const entry of readdirSync(syncDir).sort()) {
    if (!entry.endsWith(".json")) continue;
    try {
      const parsed = parseSyncFile(entry, await readFile(join(syncDir, entry), "utf-8"));
      files.push(parsed ?? { file: entry, invalid: true });
    } catch {
      files.push({ file: entry, invalid: true });
    }
  }
  return files;
}

/**
 * Read all synced machine exports and merge with local data.
 *
 * Local usage covers Claude Code, OpenCode and Codex on this machine. Each
 * remote (source, session) is counted once and never when it is also local,
 * so repeated syncs and old files from a renamed host never double-count.
 */
export async function loadMergedTokenUsage(
  deps: Partial<SessionUsageDeps> = {},
): Promise<MergedTokenData> {
  // 1. Aggregate local data
  const { tagged } = await loadSessionMessages({}, deps);
  const openCodeIndex = await (deps.readOpenCodeIndex ?? readAllSessionsIndex)().catch(() => ({}));
  const machine = (deps.machine ?? resolveMachineIdentity)();

  const byProviderModel: ProviderModelTotals = new Map();
  const totals: TokenBuckets & { messages: number; costUsd: number } = {
    ...emptyTokenBuckets(),
    messages: 0,
    costUsd: 0,
  };
  const localRoots = new Set<string>();
  for (const t of tagged) {
    const tokens = extractTokens(t.message);
    if (!tokens) continue;
    localRoots.add(`${t.source}\u0000${t.rootID}`);
    addUsage(
      byProviderModel,
      totals,
      t.message.providerID ?? "unknown",
      t.message.modelID ?? "unknown",
      tokens,
      1,
    );
  }

  // 2. Merge synced machine files
  const merged = mergeRemoteSessions({
    files: await readSyncFiles(),
    localKeys: localSessionKeys(tagged, Object.keys(openCodeIndex)),
    local: { machineId: machine.machineId, hostname: machine.hostname },
  });
  for (const session of merged.sessions) {
    for (const m of session.models) {
      // Version 2 records do not count responses; they count as one, as before.
      addUsage(byProviderModel, totals, m.provider, m.model, m.tokens, m.responses ?? 1);
    }
  }

  return {
    totals: { tokens: totals, messages: totals.messages, costUsd: totals.costUsd },
    byProviderModel: Array.from(byProviderModel.values()),
    remoteSessionCount: merged.sessions.length,
    totalSessionCount: localRoots.size + merged.sessions.length,
    machines: merged.machines,
    skippedFiles: merged.skippedFiles,
  };
}

// =============================================================================
// Helpers
// =============================================================================

function extractTokens(msg: OpenCodeMessage): TokenBuckets | null {
  const t = msg.tokens;
  if (!t) return null;
  const input = typeof t.input === "number" ? t.input : 0;
  const output = typeof t.output === "number" ? t.output : 0;
  const cacheRead = typeof t.cache?.read === "number" ? t.cache.read : 0;
  const cacheWrite = typeof t.cache?.write === "number" ? t.cache.write : 0;
  const reasoning = typeof t.reasoning === "number" ? t.reasoning : 0;
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && reasoning === 0)
    return null;
  return { input, output, cache_read: cacheRead, cache_write: cacheWrite, reasoning };
}
