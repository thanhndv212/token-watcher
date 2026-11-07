import { describe, expect, it } from "vitest";

import { parseTimelineParams, queryUsageTimeline } from "../src/gui/ipc/usage-timeline.js";
import type { OpenCodeMessage } from "../src/lib/opencode-storage.js";

// Thursday 2026-11-05 12:00 UTC.
const NOW = Date.parse("2026-11-05T12:00:00Z");
const HOUR = 3_600_000;

function msg(
  sessionID: string,
  atMs: number | undefined,
  input: number,
  modelID = "claude-sonnet",
): OpenCodeMessage {
  return {
    id: `${sessionID}-${atMs}`,
    sessionID,
    role: "assistant",
    providerID: "anthropic",
    modelID,
    tokens: { input, output: 10, reasoning: 0, cache: { read: 100, write: 0 } },
    time: atMs === undefined ? undefined : { created: atMs },
  } as OpenCodeMessage;
}

describe("usage timeline IPC", () => {
  it("validates parameters and falls back to safe defaults", () => {
    expect(parseTimelineParams({ days: 7, tzOffsetMinutes: -540 })).toEqual({
      days: 7,
      tzOffsetMinutes: -540,
    });
    expect(parseTimelineParams({ days: 3, tzOffsetMinutes: 99999 })).toEqual({
      days: 30,
      tzOffsetMinutes: 0,
    });
    expect(parseTimelineParams(null)).toEqual({ days: 30, tzOffsetMinutes: 0 });
  });

  it("buckets by local day and hour-of-week, prices only priced models, and reports unread stores", async () => {
    const timeline = await queryUsageTimeline(
      // UTC+9: 2026-11-05 12:00Z is 21:00 local on Thursday.
      { days: 7, tzOffsetMinutes: -540 },
      {
        nowMs: NOW,
        deps: {
          readOpenCode: async () => [
            msg("a", NOW, 1000),
            // 2026-11-04 16:00Z is 01:00 local on Thursday 11-05, same local day as NOW.
            msg("a", NOW - 20 * HOUR, 500),
            msg("b", undefined, 999),
            // 2026-10-27 is in the previous 7-day period (10-23..10-29 local).
            msg("old", Date.parse("2026-10-27T03:00:00Z"), 4000),
            // Older than both periods: ignored.
            msg("older", Date.parse("2026-10-01T03:00:00Z"), 9000),
          ],
          readClaude: async () => [msg("c", NOW - 48 * HOUR, 2000, "unpriced-model")],
          readCodex: async () => {
            throw new Error("sessions dir unreadable");
          },
          price: ({ modelID, tokens }) =>
            modelID === "unpriced-model" ? null : tokens.input / 1000,
        },
      },
    );

    expect(timeline.daily).toHaveLength(7);
    const today = timeline.daily[6]!;
    expect(today.day).toBe("2026-11-05");
    expect(today.responses).toBe(2);
    expect(today.sessions).toBe(1);
    expect(today.totalTokens).toBe(1000 + 500 + 2 * 110);
    expect(today.costUsd).toBeCloseTo(1.5);
    expect(today.bySource.opencode.responses).toBe(2);

    const twoDaysAgo = timeline.daily[4]!;
    expect(twoDaysAgo.day).toBe("2026-11-03");
    expect(twoDaysAgo.bySource["claude-code"].totalTokens).toBe(2110);
    expect(twoDaysAgo.costUsd).toBe(0);

    // Thursday = weekday 3 (Monday = 0), 21:00 and 01:00 local.
    expect(timeline.hourOfWeek[3]![21]).toBe(1110);
    expect(timeline.hourOfWeek[3]![1]).toBe(610);
    expect(timeline.hourOfWeekResponses[3]![21]).toBe(1);

    expect(timeline.undatedResponses).toBe(1);
    expect(timeline.previous).toMatchObject({ totalTokens: 4110, responses: 1, sessions: 1 });
    expect(timeline.previous.costUsd).toBeCloseTo(4);
    expect(timeline.totals.sessions).toBe(2);
    expect(timeline.totals.pricedShare).toBeCloseTo(1720 / 3830);
    const unpriced = timeline.models.find((m) => m.modelID === "unpriced-model");
    expect(unpriced?.costUsd).toBeNull();
    expect(timeline.unavailable).toEqual([{ source: "codex", reason: "sessions dir unreadable" }]);
  });
});
