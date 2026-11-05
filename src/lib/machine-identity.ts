/**
 * Machine identity shared with Session Knowledge (UA-TW-01).
 *
 * Session Knowledge keeps a registry at `$SESSION_TRACE_DIR/machines.json`
 * (default `~/session-trace-data/machines.json`) keyed by machine id:
 * `{ "<machineId>": { "hostname": "<host>", ... } }`. Session Knowledge takes
 * that id from the operating system: `IOPlatformUUID` on macOS and
 * `/etc/machine-id` on Linux.
 *
 * Token Watcher resolves the same id so both tools key sessions by the same
 * `(machineId, source, sessionId)`:
 *
 * 1. When the registry has an entry for this host's native id, that is the id.
 *    This survives hostname changes (macOS renames `host` to `host-3` after a
 *    name conflict) and maps entries recorded without a hostname.
 * 2. Otherwise the hostname is matched exactly after normalisation (lower
 *    case, trailing `.local` removed). An entry with an empty or missing
 *    hostname never matches, and two entries for the same hostname are
 *    ambiguous.
 *
 * In every unmatched case the host keeps its hostname as its id and is
 * reported as unmapped, so two machines are never merged under one id.
 */

import { execFileSync } from "child_process";
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

export function getMachineRegistryPath(
  home: string = homedir(),
  traceDir: string | undefined = process.env.SESSION_TRACE_DIR,
): string {
  return join(
    traceDir?.trim() ? traceDir.trim() : join(home, "session-trace-data"),
    "machines.json",
  );
}

let nativeIdCache: string | null | undefined;

/** The id Session Knowledge records for this machine, or null when it can't be read. */
export function readNativeMachineId(): string | null {
  if (nativeIdCache !== undefined) return nativeIdCache;
  let id: string | null = null;
  try {
    if (process.platform === "darwin") {
      const out = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
        encoding: "utf8",
        timeout: 2_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      id = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1] ?? null;
    } else if (process.platform === "linux") {
      for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        try {
          id = readFileSync(path, "utf8").trim() || null;
        } catch {
          id = null;
        }
        if (id) break;
      }
    }
  } catch {
    id = null;
  }
  nativeIdCache = id;
  return id;
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
    /** This machine's native id; defaults to {@link readNativeMachineId}. */
    nativeMachineId?: string | null;
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

  const nativeId =
    opts.nativeMachineId !== undefined ? opts.nativeMachineId : readNativeMachineId();
  if (nativeId) {
    const entry = (registry as Record<string, unknown>)[nativeId];
    if (entry && typeof entry === "object") {
      return { machineId: nativeId, hostname: host, mapped: true, status: "mapped" };
    }
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
