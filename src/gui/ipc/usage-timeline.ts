/**
 * Usage timeline for the desktop app's analytical views.
 *
 * Reads the same three local stores as the Tokens view (OpenCode, the Claude
 * Code CLI and the Codex CLI) once, and buckets every assistant response by
 * local calendar day and by local hour-of-week. Each bucket carries token
 * buckets, a cost estimate for the priced share, and per-source splits, so the
 * renderer can draw trends, mixes and activity heatmaps without issuing one
 * aggregate query per day.
 *
 * Everything is local and deterministic: no network, no model calls, no
 * conversation text or session titles. Unpriced responses keep their tokens
 * but add nothing to cost; `pricedShare` says how much of the total the cost
 * covers, so a partial estimate is never presented as complete.
 */

import { iterAssistantMessages, type OpenCodeMessage } from "../../lib/opencode-storage.js";
import { iterClaudeCodeCliMessages } from "../../lib/claude-code-cli-storage.js";
import { iterCodexCliMessages } from "../../lib/codex-cli-storage.js";
import { priceTokensUsd } from "../../lib/quota-stats.js";
import {
  addTokenBuckets,
  emptyTokenBuckets,
  tokenBucketsFromMessage,
  totalTokenBuckets,
  type TokenBuckets,
} from "../../lib/token-buckets.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
export const TIMELINE_DAYS = [7, 14, 30, 90] as const;

export type TimelineSource = "opencode" | "claude-code" | "codex";
export const TIMELINE_SOURCES: readonly TimelineSource[] = ["opencode", "claude-code", "codex"];

export type SourceSplit = { totalTokens: number; costUsd: number; responses: number };

export type TimelineDay = {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  /** Local midnight that starts the day, epoch ms. */
  startMs: number;
  tokens: TokenBuckets;
  totalTokens: number;
  /** Estimated cost of the priced responses in the day. */
  costUsd: number;
  responses: number;
  sessions: number;
  bySource: Record<TimelineSource, SourceSplit>;
};

export type TimelineModel = {
  source: TimelineSource;
  providerID: string;
  modelID: string;
  tokens: TokenBuckets;
  totalTokens: number;
  /** Null when the model has no known price. */
  costUsd: number | null;
  responses: number;
};

export type UsageTimeline = {
  generatedAtMs: number;
  sinceMs: number;
  untilMs: number;
  days: number;
  /** Minutes behind UTC used for local bucketing (same sign as Date#getTimezoneOffset). */
  tzOffsetMinutes: number;
  daily: TimelineDay[];
  /** hourOfWeek[weekday][hour]: total tokens; weekday 0 = Monday, local time. */
  hourOfWeek: number[][];
  /** Response counts per hour-of-week cell, same layout as hourOfWeek. */
  hourOfWeekResponses: number[][];
  totals: {
    tokens: TokenBuckets;
    totalTokens: number;
    costUsd: number;
    responses: number;
    sessions: number;
    /** Share of tokens with a known price; null with no tokens. */
    pricedShare: number | null;
  };
  bySource: Record<TimelineSource, SourceSplit & { sessions: number }>;
  /**
   * The equal-length period immediately before `daily`, for period-over-period
   * deltas. Zero when the stores hold nothing that old; never extrapolated.
   */
  previous: {
    sinceMs: number;
    totalTokens: number;
    costUsd: number;
    responses: number;
    sessions: number;
  };
  models: TimelineModel[];
  /** Responses with no timestamp; counted nowhere in the timeline. */
  undatedResponses: number;
  /** Sources whose store could not be read. */
  unavailable: Array<{ source: TimelineSource; reason: string }>;
};

export type TimelineParams = { days: number; tzOffsetMinutes: number };

export type TimelineDeps = {
  readOpenCode: (p: { sinceMs: number; untilMs: number }) => Promise<OpenCodeMessage[]>;
  readClaude: (p: { sinceMs: number; untilMs: number }) => Promise<OpenCodeMessage[]>;
  readCodex: (p: { sinceMs: number; untilMs: number }) => Promise<OpenCodeMessage[]>;
  price: (p: { providerID?: string; modelID?: string; tokens: TokenBuckets }) => number | null;
};

const defaultDeps: TimelineDeps = {
  readOpenCode: (p) => iterAssistantMessages(p),
  readClaude: (p) => iterClaudeCodeCliMessages(p),
  readCodex: (p) => iterCodexCliMessages(p),
  price: priceTokensUsd,
};

export function parseTimelineParams(raw: unknown): TimelineParams {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const days = (TIMELINE_DAYS as readonly number[]).includes(p.days as number)
    ? (p.days as number)
    : 30;
  const tz = Number(p.tzOffsetMinutes);
  // Real offsets lie within ±14h; anything else falls back to UTC.
  const tzOffsetMinutes = Number.isInteger(tz) && Math.abs(tz) <= 14 * 60 ? tz : 0;
  return { days, tzOffsetMinutes };
}

function emptySplit(): SourceSplit {
  return { totalTokens: 0, costUsd: 0, responses: 0 };
}

function emptyBySource(): Record<TimelineSource, SourceSplit> {
  return { opencode: emptySplit(), "claude-code": emptySplit(), codex: emptySplit() };
}

/** Local wall-clock ms for an epoch ms, given a Date#getTimezoneOffset-style offset. */
function toLocal(ms: number, tzOffsetMinutes: number): number {
  return ms - tzOffsetMinutes * 60_000;
}

function localDayStart(ms: number, tzOffsetMinutes: number): number {
  const local = toLocal(ms, tzOffsetMinutes);
  return Math.floor(local / DAY_MS) * DAY_MS + tzOffsetMinutes * 60_000;
}

function dayKey(dayStartMs: number, tzOffsetMinutes: number): string {
  return new Date(toLocal(dayStartMs, tzOffsetMinutes)).toISOString().slice(0, 10);
}

export function buildUsageTimeline(
  input: Record<TimelineSource, OpenCodeMessage[]>,
  params: TimelineParams & { nowMs: number; unavailable?: UsageTimeline["unavailable"] },
  price: TimelineDeps["price"],
): UsageTimeline {
  const { days, tzOffsetMinutes, nowMs } = params;
  const lastDayStart = localDayStart(nowMs, tzOffsetMinutes);
  const firstDayStart = lastDayStart - (days - 1) * DAY_MS;

  const daily: TimelineDay[] = [];
  const daySessions: Set<string>[] = [];
  for (let i = 0; i < days; i++) {
    const startMs = firstDayStart + i * DAY_MS;
    daily.push({
      day: dayKey(startMs, tzOffsetMinutes),
      startMs,
      tokens: emptyTokenBuckets(),
      totalTokens: 0,
      costUsd: 0,
      responses: 0,
      sessions: 0,
      bySource: emptyBySource(),
    });
    daySessions.push(new Set());
  }

  const hourOfWeek = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const hourOfWeekResponses = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const models = new Map<string, TimelineModel>();
  const sessions = new Set<string>();
  const sourceSessions: Record<TimelineSource, Set<string>> = {
    opencode: new Set(),
    "claude-code": new Set(),
    codex: new Set(),
  };
  const bySource = emptyBySource();
  let totalBuckets = emptyTokenBuckets();
  let costUsd = 0;
  let pricedTokens = 0;
  let responses = 0;
  let undatedResponses = 0;
  const previousStart = firstDayStart - days * DAY_MS;
  const previous = {
    sinceMs: previousStart,
    totalTokens: 0,
    costUsd: 0,
    responses: 0,
    sessions: 0,
  };
  const previousSessions = new Set<string>();

  for (const source of TIMELINE_SOURCES) {
    for (const msg of input[source]) {
      const at = msg.time?.created;
      if (typeof at !== "number" || !Number.isFinite(at)) {
        undatedResponses += 1;
        continue;
      }
      const index = Math.floor((localDayStart(at, tzOffsetMinutes) - firstDayStart) / DAY_MS);
      if (index < -days || index >= days) continue;

      const tokens = tokenBucketsFromMessage(msg);
      const total = totalTokenBuckets(tokens);
      const cost = price({ providerID: msg.providerID, modelID: msg.modelID, tokens });
      const sessionKey = source + "\u0000" + msg.sessionID;

      if (index < 0) {
        previous.totalTokens += total;
        previous.costUsd += cost ?? 0;
        previous.responses += 1;
        previousSessions.add(sessionKey);
        continue;
      }

      const day = daily[index]!;
      day.tokens = addTokenBuckets(day.tokens, tokens);
      day.totalTokens += total;
      day.responses += 1;
      day.costUsd += cost ?? 0;
      day.bySource[source].totalTokens += total;
      day.bySource[source].costUsd += cost ?? 0;
      day.bySource[source].responses += 1;
      daySessions[index]!.add(sessionKey);

      // Weekday with Monday = 0, in local time.
      const local = new Date(toLocal(at, tzOffsetMinutes));
      const weekday = (local.getUTCDay() + 6) % 7;
      const hour = Math.floor((toLocal(at, tzOffsetMinutes) % DAY_MS) / HOUR_MS);
      hourOfWeek[weekday]![hour]! += total;
      hourOfWeekResponses[weekday]![hour]! += 1;

      const providerID = msg.providerID ?? "unknown";
      const modelID = msg.modelID ?? "unknown";
      const modelKey = [source, providerID, modelID].join("\u0000");
      const existing = models.get(modelKey);
      if (existing) {
        existing.tokens = addTokenBuckets(existing.tokens, tokens);
        existing.totalTokens += total;
        existing.responses += 1;
        if (cost != null) existing.costUsd = (existing.costUsd ?? 0) + cost;
      } else {
        models.set(modelKey, {
          source,
          providerID,
          modelID,
          tokens,
          totalTokens: total,
          costUsd: cost,
          responses: 1,
        });
      }

      totalBuckets = addTokenBuckets(totalBuckets, tokens);
      costUsd += cost ?? 0;
      if (cost != null) pricedTokens += total;
      responses += 1;
      sessions.add(sessionKey);
      sourceSessions[source].add(sessionKey);
      bySource[source].totalTokens += total;
      bySource[source].costUsd += cost ?? 0;
      bySource[source].responses += 1;
    }
  }

  daily.forEach((day, i) => (day.sessions = daySessions[i]!.size));
  previous.sessions = previousSessions.size;
  const totalTokens = totalTokenBuckets(totalBuckets);

  return {
    generatedAtMs: nowMs,
    sinceMs: firstDayStart,
    untilMs: nowMs,
    days,
    tzOffsetMinutes,
    daily,
    hourOfWeek,
    hourOfWeekResponses,
    totals: {
      tokens: totalBuckets,
      totalTokens,
      costUsd,
      responses,
      sessions: sessions.size,
      pricedShare: totalTokens > 0 ? pricedTokens / totalTokens : null,
    },
    bySource: {
      opencode: { ...bySource.opencode, sessions: sourceSessions.opencode.size },
      "claude-code": { ...bySource["claude-code"], sessions: sourceSessions["claude-code"].size },
      codex: { ...bySource.codex, sessions: sourceSessions.codex.size },
    },
    previous,
    models: [...models.values()].sort(
      (a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.totalTokens - a.totalTokens,
    ),
    undatedResponses,
    unavailable: params.unavailable ?? [],
  };
}

export async function queryUsageTimeline(
  raw: unknown,
  options: { nowMs?: number; deps?: Partial<TimelineDeps> } = {},
): Promise<UsageTimeline> {
  const params = parseTimelineParams(raw);
  const nowMs = options.nowMs ?? Date.now();
  const deps = { ...defaultDeps, ...options.deps };
  // Two periods (current + previous, for deltas) plus one day of margin so the
  // first local day is complete in any timezone.
  const range = { sinceMs: nowMs - (2 * params.days + 1) * DAY_MS, untilMs: nowMs };
  const unavailable: UsageTimeline["unavailable"] = [];
  const read = async (source: TimelineSource, fn: TimelineDeps["readOpenCode"]) => {
    try {
      return await fn(range);
    } catch (err) {
      unavailable.push({ source, reason: err instanceof Error ? err.message : String(err) });
      return [];
    }
  };
  const [opencode, claude, codex] = await Promise.all([
    read("opencode", deps.readOpenCode),
    read("claude-code", deps.readClaude),
    read("codex", deps.readCodex),
  ]);
  return buildUsageTimeline(
    { opencode, "claude-code": claude, codex },
    { ...params, nowMs, unavailable },
    deps.price,
  );
}
