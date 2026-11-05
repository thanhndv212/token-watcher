/**
 * Machine identity shared with Session Knowledge (UA-TW-01).
 *
 * Session Knowledge keeps a registry at `~/session-trace-data/machines.json`
 * keyed by machine id: `{ "<machineId>": { "hostname": "<host>", ... } }`.
 * Token Watcher maps this host's hostname through that registry so both tools
 * key sessions by the same `(machineId, source, sessionId)`.
 *
 * Matching is exact after normalisation (lower case, trailing `.local`
 * removed). An entry with an empty or missing hostname never matches, and two
 * entries for the same hostname are ambiguous. In every unmatched case the
 * host keeps its hostname as its id and is reported as unmapped, so two
 * machines are never merged under one id.
 */

import { readFileSync } from "fs";
import { homedir, hostname as osHostname } from "os";
import { join } from "path";

export type MachineIdentityStatus =
  | "mapped"
  | "no-registry"
  | "unreadable"
  | "no-match"
  | "ambiguous";

export type MachineIdentity = {
  machineId: string;
  hostname: string;
  mapped: boolean;
  status: MachineIdentityStatus;
};

export function getMachineRegistryPath(home: string = homedir()): string {
  return join(home, "session-trace-data", "machines.json");
}

export function normalizeHostname(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.local$/, "");
}

function unmapped(host: string, status: MachineIdentityStatus): MachineIdentity {
  return { machineId: host, hostname: host, mapped: false, status };
}

export function resolveMachineIdentity(
  opts: {
    hostname?: string;
    registryPath?: string;
    readFile?: (path: string) => string;
  } = {},
): MachineIdentity {
  const host = opts.hostname ?? osHostname();
  const readFile = opts.readFile ?? ((path: string) => readFileSync(path, "utf-8"));

  let text: string;
  try {
    text = readFile(opts.registryPath ?? getMachineRegistryPath());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return unmapped(host, code === "ENOENT" ? "no-registry" : "unreadable");
  }

  let registry: unknown;
  try {
    registry = JSON.parse(text);
  } catch {
    return unmapped(host, "unreadable");
  }
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    return unmapped(host, "unreadable");
  }

  const wanted = normalizeHostname(host);
  const matches: string[] = [];
  for (const [id, info] of Object.entries(registry as Record<string, unknown>)) {
    if (!id || !info || typeof info !== "object") continue;
    const entryHost = (info as { hostname?: unknown }).hostname;
    if (typeof entryHost !== "string" || normalizeHostname(entryHost) === "") continue;
    if (normalizeHostname(entryHost) === wanted) matches.push(id);
  }

  if (matches.length === 0) return unmapped(host, "no-match");
  if (matches.length > 1) return unmapped(host, "ambiguous");
  return { machineId: matches[0]!, hostname: host, mapped: true, status: "mapped" };
}

export function describeMachineIdentity(identity: MachineIdentity): string {
  if (identity.mapped) return `${identity.machineId} (host ${identity.hostname})`;
  const why: Record<Exclude<MachineIdentityStatus, "mapped">, string> = {
    "no-registry": "no Session Knowledge machine registry",
    unreadable: "machine registry unreadable",
    "no-match": "host not in machine registry",
    ambiguous: "host matches several registry entries",
  };
  return `${identity.hostname} (unmapped: ${why[identity.status as Exclude<MachineIdentityStatus, "mapped">]})`;
}
