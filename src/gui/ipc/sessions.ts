/**
 * Session usage view for the desktop app (UA-TW-07).
 *
 * Serves the same report as `token-watcher sessions`, with optional quota
 * windows (UA-TW-05) and Session Knowledge imports (UA-TW-04). Parameters
 * from the renderer are validated here, and the report is trimmed before it
 * crosses the IPC bridge: a bounded number of sessions, working directories
 * reduced to their last path segment, and window/unattributed lists capped.
 */

import { basename } from "path";

import {
  buildSessionUsageReport,
  type SessionUsageDeps,
  type SessionUsageReport,
} from "../../lib/session-usage.js";

const DAY_MS = 86_400_000;
export const SESSION_VIEW_DAYS = [7, 14, 28, 90] as const;
const MAX_SESSIONS = 25;
const MAX_WINDOWS = 40;

export type SessionViewParams = {
  days: number;
  windows: boolean;
  imports: boolean;
};

export type SessionView = Omit<SessionUsageReport, "sessions"> & {
  days: number;
  /** Sessions in the report; `sessions` holds at most the top 25 by tokens. */
  sessionCount: number;
  sessions: (Omit<SessionUsageReport["sessions"][number], "directory"> & {
    project: string | null;
  })[];
};

export function parseSessionViewParams(raw: unknown): SessionViewParams {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const days = (SESSION_VIEW_DAYS as readonly number[]).includes(p.days as number)
    ? (p.days as number)
    : 28;
  return { days, windows: p.windows === true, imports: p.imports === true };
}

/** The latest windows and those with usage first, capped so the view stays small. */
function trimWindows(report: SessionUsageReport): SessionUsageReport["quotaWindows"] {
  const q = report.quotaWindows;
  if (!q) return null;
  const windows = [...q.windows]
    .sort(
      (a, b) =>
        Number(b.responses > 0) - Number(a.responses > 0) ||
        b.endMs - a.endMs ||
        a.provider.localeCompare(b.provider),
    )
    .slice(0, MAX_WINDOWS)
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.startMs - b.startMs);
  return { ...q, windows };
}

export async function querySessionView(
  raw: unknown,
  options: { nowMs?: number; deps?: Partial<SessionUsageDeps> } = {},
): Promise<SessionView> {
  const params = parseSessionViewParams(raw);
  const nowMs = options.nowMs ?? Date.now();
  const report = await buildSessionUsageReport(
    {
      sinceMs: nowMs - params.days * DAY_MS,
      nowMs,
      quotaWindows: params.windows,
      imports: params.imports,
    },
    options.deps,
  );
  return {
    ...report,
    days: params.days,
    sessionCount: report.sessions.length,
    sessions: report.sessions.slice(0, MAX_SESSIONS).map(({ directory, ...rest }) => ({
      ...rest,
      project: directory ? basename(directory) : null,
    })),
    quotaWindows: trimWindows(report),
  };
}
