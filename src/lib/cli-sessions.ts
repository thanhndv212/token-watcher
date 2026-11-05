import { basename } from "path";

import { describeMachineIdentity } from "./machine-identity.js";
import type { QuotaWindowRow, QuotaWindowUsage, UnattributedReason } from "./quota-window-usage.js";
import {
  buildSessionUsageReport,
  type SessionUsageDeps,
  type SessionUsageReport,
  type UsageSummary,
} from "./session-usage.js";

export interface RunCliSessionsCommandOptions {
  argv?: string[];
  nowMs?: number;
  deps?: Partial<SessionUsageDeps>;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 28;
const DEFAULT_LIMIT = 10;

export const SESSIONS_USAGE = [
  "Usage:",
  "  npx @thanhndv212/token-watcher sessions [--since <YYYY-MM-DD|Nd>] [--until <YYYY-MM-DD>]",
  "                                         [--limit <n>] [--windows] [--json]",
  "",
  "Per-session token usage from Claude Code, OpenCode and Codex on this machine,",
  "with weekly trends and session-length buckets. Local and read-only.",
  "",
  "Options:",
  `  --since <date|Nd>  Start of the window, a UTC date or N days ago (default: ${DEFAULT_DAYS}d)`,
  "  --until <date>     End of the window, inclusive UTC date (default: now)",
  `  --limit <n>        Sessions to list in text output (default: ${DEFAULT_LIMIT})`,
  "  --windows          Also place usage on recorded provider quota windows (5h, weekly, ...)",
  "  --json             Print the full report as JSON",
  "  --help, -h         Show help",
].join("\n");

type ParsedSessionsArgs =
  | {
      ok: true;
      help: boolean;
      json: boolean;
      windows: boolean;
      sinceMs: number;
      untilMs?: number;
      limit: number;
    }
  | { ok: false; error: string };

function parseUtcDate(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(value) ? ms : null;
}

export function parseSessionsArgs(argv: string[], nowMs: number): ParsedSessionsArgs {
  let json = false;
  let windows = false;
  let sinceMs = nowMs - DEFAULT_DAYS * DAY_MS;
  let untilMs: number | undefined;
  let limit = DEFAULT_LIMIT;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") {
      return { ok: true, help: true, json: false, windows: false, sinceMs, limit };
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--windows") {
      windows = true;
      continue;
    }

    const match = /^--(since|until|limit)(?:=(.*))?$/.exec(arg);
    if (!match) {
      return {
        ok: false,
        error: arg.startsWith("-") ? `Unknown option: ${arg}` : `Unexpected argument: ${arg}`,
      };
    }
    const name = match[1]!;
    let value = match[2];
    if (value === undefined) {
      value = argv[index + 1];
      if (!value || value.startsWith("-"))
        return { ok: false, error: `Missing value for --${name}.` };
      index += 1;
    }
    value = value.trim();

    if (name === "since") {
      const days = /^(\d+)d$/.exec(value);
      const parsed = days ? nowMs - Number(days[1]) * DAY_MS : parseUtcDate(value);
      if (parsed === null) {
        return { ok: false, error: "--since must be a YYYY-MM-DD date or a day count like 28d." };
      }
      sinceMs = parsed;
    } else if (name === "until") {
      const parsed = parseUtcDate(value);
      if (parsed === null) return { ok: false, error: "--until must be a YYYY-MM-DD date." };
      untilMs = parsed + DAY_MS - 1;
    } else {
      const num = Number(value);
      if (!Number.isInteger(num) || num < 0) {
        return { ok: false, error: "--limit must be a non-negative integer." };
      }
      limit = num;
    }
  }

  if (untilMs !== undefined && untilMs < sinceMs) {
    return { ok: false, error: "--until is before --since." };
  }
  return { ok: true, help: false, json, windows, sinceMs, untilMs, limit };
}

const NA = "n/a";

export function formatTokens(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(Math.round(value));
}

function pct(value: number | null): string {
  return value === null ? NA : `${(value * 100).toFixed(1)}%`;
}

function usd(value: number | null): string {
  return value === null ? NA : `$${value.toFixed(2)}`;
}

function perResponse(value: number | null): string {
  return value === null ? NA : formatTokens(value);
}

function minutes(value: number | null): string {
  if (value === null) return NA;
  if (value >= 60) return `${(value / 60).toFixed(1)}h`;
  return `${Math.round(value)}m`;
}

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!)))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)];
}

function summaryCells(s: UsageSummary): string[] {
  return [
    String(s.sessions),
    String(s.responses),
    formatTokens(s.totalTokens),
    pct(s.cacheReadShare),
    perResponse(s.tokensPerResponse),
    pct(s.subagentShare),
    usd(s.costUsd),
    pct(s.pricedShare),
  ];
}

const SUMMARY_HEADER = [
  "sessions",
  "resp",
  "tokens",
  "cache",
  "tok/resp",
  "subagent",
  "cost",
  "priced",
];

function isoDate(ms: number | null): string {
  return ms === null ? "start" : new Date(ms).toISOString().slice(0, 10);
}

const UNATTRIBUTED_LABELS: Record<UnattributedReason, string> = {
  "no-window": "no quota window recorded for this provider",
  "outside-known-windows": "outside every recorded window",
  "ambiguous-account": "windows from more than one account cover it",
  "no-provider-or-time": "no provider id or timestamp",
};

function utcMinute(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

/**
 * Windows with usage, mixed-account windows (so the reason usage is not placed
 * shows), and the latest instance of each limit so current windows show.
 */
function shownWindows(windows: QuotaWindowRow[]): QuotaWindowRow[] {
  const latest = new Map<string, QuotaWindowRow>();
  for (const w of windows) {
    const key = [w.provider, w.account, w.window, w.group, w.model ?? ""].join("\u0000");
    const current = latest.get(key);
    if (!current || w.endMs > current.endMs) latest.set(key, w);
  }
  const keep = new Set(latest.values());
  return windows.filter((w) => w.responses > 0 || w.concurrent || keep.has(w));
}

export function formatQuotaWindowLines(usage: QuotaWindowUsage): string[] {
  const lines: string[] = ["Quota windows (UTC):"];
  if (usage.status === "not-found") {
    lines.push("  No quota history recorded on this machine yet.", "");
    return lines;
  }
  if (usage.status === "unavailable") {
    lines.push(`  Quota history unavailable: ${usage.reason ?? "read failed"}`, "");
    return lines;
  }
  const shown = shownWindows(usage.windows);
  if (shown.length === 0) {
    lines.push("  No recorded quota windows overlap this range.");
  } else {
    const accounts = new Set(shown.map((w) => `${w.provider}\u0000${w.account}`));
    const providers = new Set(shown.map((w) => w.provider));
    const showAccount = accounts.size > providers.size;
    lines.push(
      ...table(
        [
          "provider",
          ...(showAccount ? ["account"] : []),
          "window",
          "start",
          "reset",
          "used",
          "sessions",
          "resp",
          "tokens",
        ],
        shown.map((w) => [
          w.provider,
          ...(showAccount ? [w.account.slice(0, 8)] : []),
          w.model ? `${w.window} ${w.model}` : w.window,
          `${utcMinute(w.startMs)}${w.startMethod === "first-observation" ? "+" : ""}`,
          utcMinute(w.endMs),
          (w.percentUsed === null ? NA : `${Math.round(w.percentUsed)}%`) +
            (w.concurrent ? "?" : ""),
          String(w.sessions),
          String(w.responses),
          formatTokens(w.totalTokens),
        ]),
      ),
    );
    if (shown.some((w) => w.startMethod === "first-observation")) {
      lines.push("  + start is the first observation; the window may have started earlier.");
    }
    if (shown.some((w) => w.concurrent)) {
      lines.push(
        "  ? observed alongside another window of the same limit: more than one account,",
        "    not told apart, so usage in it is not placed.",
      );
    }
  }
  if (usage.unattributed.length > 0) {
    lines.push("Not placed on a window:");
    for (const u of usage.unattributed) {
      const scope = [u.provider ?? "unknown provider", u.window].filter(Boolean).join(" ");
      lines.push(
        `  ${scope}: ${u.responses} responses, ${formatTokens(u.totalTokens)} tokens (${UNATTRIBUTED_LABELS[u.reason]})`,
      );
    }
  }
  lines.push("");
  return lines;
}

export function formatSessionUsageText(report: SessionUsageReport, limit: number): string {
  const lines: string[] = [];
  const until = report.untilMs === null ? "now" : isoDate(report.untilMs);
  lines.push(`Session usage ${isoDate(report.sinceMs)} to ${until} (UTC)`);
  lines.push(`Machine: ${describeMachineIdentity(report.machine)}`, "");

  lines.push("Sources:");
  for (const c of report.coverage) {
    const detail =
      c.status === "read"
        ? `${c.sessions} sessions, ${c.responses} responses` +
          (c.undatedResponses ? `, ${c.undatedResponses} undated` : "") +
          (c.marksSubagents ? "" : ", subagents not marked")
        : c.status === "not-found"
          ? "no local store found"
          : `unavailable: ${c.reason ?? "read failed"}`;
    lines.push(`  ${c.source.padEnd(12)} ${detail}`);
  }
  lines.push("");

  if (report.sessions.length === 0) {
    lines.push("No sessions with reported usage in this window.", "");
  } else {
    lines.push("Totals:");
    lines.push(...table(["", ...SUMMARY_HEADER], [["all", ...summaryCells(report.totals)]]));
    lines.push("");

    lines.push("Weekly (weeks start Monday UTC):");
    lines.push(
      ...table(
        ["week", "source", ...SUMMARY_HEADER],
        report.weekly.map((w) => [w.weekStart, w.source, ...summaryCells(w)]),
      ),
    );
    lines.push("");

    lines.push("By session length (responses):");
    lines.push(
      ...table(
        ["length", "source", ...SUMMARY_HEADER],
        report.lengthBuckets.map((b) => [b.bucket, b.source, ...summaryCells(b)]),
      ),
    );
    lines.push("");

    if (limit > 0) {
      const shown = report.sessions.slice(0, limit);
      lines.push(`Top ${shown.length} of ${report.sessions.length} sessions by tokens:`);
      lines.push(
        ...table(
          [
            "source",
            "session",
            "project",
            "start",
            "active",
            "resp",
            "tokens",
            "cache",
            "subagent",
            "cost",
            "model",
          ],
          shown.map((s) => [
            s.source,
            s.sessionID.slice(0, 12),
            s.directory ? basename(s.directory) : NA,
            s.startMs === null
              ? NA
              : new Date(s.startMs).toISOString().slice(0, 16).replace("T", " "),
            minutes(s.activeMinutes),
            String(s.responses),
            formatTokens(s.totalTokens),
            pct(s.cacheReadShare),
            s.subagentResponses > 0 ? formatTokens(s.subagentTokens) : "-",
            s.costUsd !== null && s.unpricedTokens > 0 ? `${usd(s.costUsd)}*` : usd(s.costUsd),
            s.models[0]?.model ?? NA,
          ]),
        ),
      );
      lines.push("");
    }
  }

  if (report.quotaWindows) lines.push(...formatQuotaWindowLines(report.quotaWindows));

  lines.push("Notes:");
  for (const note of report.notes) lines.push(`  - ${note}`);
  lines.push(`  - ${NA} means the value is not available, not zero.`);
  lines.push(
    "  - priced: share of tokens with a known price; * marks a partly priced session cost.",
  );
  return lines.join("\n") + "\n";
}

export async function runCliSessionsCommand(
  options: RunCliSessionsCommandOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const nowMs = options.nowMs ?? Date.now();
  const parsed = parseSessionsArgs(options.argv ?? [], nowMs);

  if (!parsed.ok) {
    stderr.write(`${parsed.error}\n\n${SESSIONS_USAGE}\n`);
    return 1;
  }
  if (parsed.help) {
    stdout.write(`${SESSIONS_USAGE}\n`);
    return 0;
  }

  const report = await buildSessionUsageReport(
    { sinceMs: parsed.sinceMs, untilMs: parsed.untilMs, nowMs, quotaWindows: parsed.windows },
    options.deps,
  );
  stdout.write(
    parsed.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatSessionUsageText(report, parsed.limit),
  );
  return 0;
}
