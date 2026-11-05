#!/usr/bin/env node
/**
 * Convert a Session Knowledge trace store to usage import contract 1 records.
 *
 * Stand-in for Session Knowledge's own metadata export (UA-SK-05) so the
 * import (UA-TW-04) can be validated against real traces. It reads each
 * `traces/<machineId>/<source>/*.csf.jsonl` file and writes one JSON line per
 * session with metadata only:
 *
 * - machine, source and session ids, parent session, start and end time;
 * - the model, and message counts by role (user, assistant, tool);
 * - tokens only where the session header reports them;
 * - `outcome: null`, because the traces carry no git linkage yet (UA-SK-03).
 *
 * Message content is read to count lines but never written. A project id that
 * is not already a hash is replaced by its SHA-1, so no path leaves the store.
 *
 * Usage:
 *   node scripts/session-knowledge-to-usage-import.mjs [--traces <dir>] [--out <file>]
 *
 * Default traces dir: $SESSION_TRACE_DIR/traces, else ~/session-trace-data/traces.
 * A summary goes to stderr; records go to --out or stdout.
 */

import { createHash } from "node:crypto";
import { createReadStream, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

class SafeError extends Error {}

function parseArgs(argv) {
  const opts = { traces: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--traces") opts.traces = argv[++i];
    else if (arg === "--out") opts.out = argv[++i];
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

function defaultTracesDir() {
  const base = process.env.SESSION_TRACE_DIR?.trim() || join(homedir(), "session-trace-data");
  return join(base, "traces");
}

const HASH = /^[0-9a-f]{16,64}$/;
function safeProjectId(value) {
  if (typeof value !== "string" || value === "") return null;
  return HASH.test(value) ? value : createHash("sha1").update(value).digest("hex");
}

function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function usageFrom(header) {
  const tu = header.tokenUsage && typeof header.tokenUsage === "object" ? header.tokenUsage : {};
  const usage = {
    method: "reported",
    input: count(header.tokensIn),
    output: count(header.tokensOut),
    cacheRead: count(tu.cachedReadTokens),
    cacheWrite: count(tu.cachedWriteTokens),
    reasoning: count(tu.reasoningTokens),
  };
  return usage.input === null && usage.output === null ? { method: "unavailable" } : usage;
}

async function convertFile(path) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let header = null;
  const roles = { user: 0, assistant: 0, tool: 0 };
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row.type === "session") header = row.data;
    else if (row.type === "message" && row.data && row.data.role in roles) roles[row.data.role]++;
  }
  if (!header) throw new SafeError("no session header");
  if (typeof header.id !== "string" || !header.id) throw new SafeError("session header has no id");
  return {
    contract: 1,
    machineId: header.machineId,
    source: header.source,
    sessionId: header.id,
    parentSessionId: header.parentSessionId ?? null,
    isSubagent: header.parentSessionId ? true : null,
    projectId: safeProjectId(header.projectId),
    startedAt: header.createdAt ?? null,
    endedAt: header.updatedAt ?? null,
    models: header.model ? [header.model] : [],
    activity: { userTurns: roles.user, assistantTurns: roles.assistant, toolCalls: roles.tool },
    usage: usageFrom(header),
    outcome: null,
  };
}

function listCsfFiles(tracesDir) {
  const files = [];
  for (const machine of readdirSync(tracesDir)) {
    const machineDir = join(tracesDir, machine);
    if (!statSync(machineDir).isDirectory()) continue;
    for (const source of readdirSync(machineDir)) {
      const sourceDir = join(machineDir, source);
      if (!statSync(sourceDir).isDirectory()) continue;
      for (const name of readdirSync(sourceDir)) {
        if (name.endsWith(".csf.jsonl"))
          files.push({ machine, source, path: join(sourceDir, name) });
      }
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: session-knowledge-to-usage-import.mjs [--traces <dir>] [--out <file>]");
    return 0;
  }
  const tracesDir = opts.traces ?? defaultTracesDir();
  const records = [];
  const summary = {};
  let failed = 0;
  for (const file of listCsfFiles(tracesDir)) {
    const key = `${file.machine}/${file.source}`;
    summary[key] ??= { sessions: 0, reportedTokens: 0, failed: 0 };
    try {
      const record = await convertFile(file.path);
      // The machine directory and the header must agree; a mismatch is reported, not guessed.
      // The source comes from the header: Copilot traces live in `vscode-copilot/` but
      // their sessions are recorded as `copilot-chat`.
      if (record.machineId !== file.machine)
        throw new SafeError("machine id differs from its directory");
      records.push(record);
      summary[key].sessions++;
      if (record.usage.method === "reported") summary[key].reportedTokens++;
    } catch (error) {
      failed++;
      summary[key].failed++;
      // Parser messages can quote trace content, so only our own messages are reported.
      const reason = error instanceof SafeError ? error.message : (error?.name ?? "error");
      summary[key].reasons ??= {};
      summary[key].reasons[reason] = (summary[key].reasons[reason] ?? 0) + 1;
    }
  }
  const text = records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
  if (opts.out) writeFileSync(opts.out, text, { mode: 0o600 });
  else process.stdout.write(text);
  process.stderr.write(
    JSON.stringify({ tracesDir, records: records.length, failed, bySource: summary }, null, 2) +
      "\n",
  );
  return failed ? 2 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
