import { describe, expect, it } from "vitest";

import {
  describeMachineIdentity,
  getMachineRegistryPath,
  normalizeHostname,
  resolveMachineIdentity,
} from "../src/lib/machine-identity.js";

function registry(value: unknown) {
  return () => JSON.stringify(value);
}

describe("resolveMachineIdentity", () => {
  it("prefers the registry entry for this host's native id over hostname matching", () => {
    const identity = resolveMachineIdentity({
      // macOS renamed the host after a name conflict, so the hostname no longer matches.
      hostname: "Thanhs-MacBook-Pro-3.local",
      nativeMachineId: "AED6D88B-1",
      readFile: registry({
        "AED6D88B-1": { hostname: "thanhs-macbook-pro" },
        "11f959c8-2": { hostname: "" },
      }),
    });
    expect(identity).toEqual({
      machineId: "AED6D88B-1",
      hostname: "Thanhs-MacBook-Pro-3.local",
      mapped: true,
      status: "mapped",
    });
  });

  it("maps a registry entry recorded without a hostname by native id", () => {
    expect(
      resolveMachineIdentity({
        hostname: "dell",
        nativeMachineId: "11f959c8-2",
        readFile: registry({ "11f959c8-2": { hostname: "" } }),
      }),
    ).toMatchObject({ machineId: "11f959c8-2", mapped: true });
  });

  it("falls back to hostname matching when the native id is unknown", () => {
    expect(
      resolveMachineIdentity({
        hostname: "dell",
        nativeMachineId: "not-registered",
        readFile: registry({ "11f959c8-2": { hostname: "dell" } }),
      }),
    ).toMatchObject({ machineId: "11f959c8-2", mapped: true });
  });

  it("maps an exact hostname match to its registry id", () => {
    const identity = resolveMachineIdentity({
      hostname: "Thanhs-MacBook.local",
      nativeMachineId: null,
      readFile: registry({
        "AED6D88B-1": { hostname: "thanhs-macbook" },
        "11f959c8-2": { hostname: "dell-linux" },
      }),
    });
    expect(identity).toEqual({
      machineId: "AED6D88B-1",
      hostname: "Thanhs-MacBook.local",
      mapped: true,
      status: "mapped",
    });
  });

  it("never lets an empty-hostname entry match every host", () => {
    const identity = resolveMachineIdentity({
      hostname: "dell-linux",
      readFile: registry({ "AED6D88B-1": { hostname: "" }, "BBBB-2": {} }),
    });
    expect(identity).toMatchObject({ machineId: "dell-linux", mapped: false, status: "no-match" });
  });

  it("keeps an ambiguous host unmapped instead of picking one entry", () => {
    const identity = resolveMachineIdentity({
      hostname: "box",
      readFile: registry({ a: { hostname: "box" }, b: { hostname: "BOX.local" } }),
    });
    expect(identity).toMatchObject({ machineId: "box", mapped: false, status: "ambiguous" });
  });

  it("reports a missing registry separately from an unreadable one", () => {
    const missing = resolveMachineIdentity({
      hostname: "box",
      readFile: () => {
        throw Object.assign(new Error("nope"), { code: "ENOENT" });
      },
    });
    expect(missing).toMatchObject({ machineId: "box", mapped: false, status: "no-registry" });

    const broken = resolveMachineIdentity({ hostname: "box", readFile: () => "{not json" });
    expect(broken).toMatchObject({ mapped: false, status: "unreadable" });

    const wrongShape = resolveMachineIdentity({ hostname: "box", readFile: registry(["box"]) });
    expect(wrongShape).toMatchObject({ mapped: false, status: "unreadable" });
  });

  it("keeps two unmapped machines distinct by hostname", () => {
    const read = registry({ mac: { hostname: "mac" } });
    const a = resolveMachineIdentity({ hostname: "linux-a", readFile: read });
    const b = resolveMachineIdentity({ hostname: "linux-b", readFile: read });
    expect(a.machineId).not.toBe(b.machineId);
    expect([a.mapped, b.mapped]).toEqual([false, false]);
  });

  it("reads the Session Knowledge registry under the home directory by default", () => {
    expect(getMachineRegistryPath("/home/u", "")).toBe("/home/u/session-trace-data/machines.json");
    expect(getMachineRegistryPath("/home/u", "/home/u/Develop/session-trace-data")).toBe(
      "/home/u/Develop/session-trace-data/machines.json",
    );
    let readPath = "";
    resolveMachineIdentity({
      hostname: "h",
      readFile: (path) => {
        readPath = path;
        return "{}";
      },
    });
    expect(readPath).toBe(getMachineRegistryPath());
  });
});

describe("machine identity helpers", () => {
  it("normalises case and the macOS .local suffix only", () => {
    expect(normalizeHostname(" Mac.Local ")).toBe("mac");
    expect(normalizeHostname("host.example.com")).toBe("host.example.com");
  });

  it("labels unmapped hosts visibly", () => {
    expect(
      describeMachineIdentity({
        machineId: "id-1",
        hostname: "mac",
        mapped: true,
        status: "mapped",
      }),
    ).toBe("id-1 (host mac)");
    expect(
      describeMachineIdentity({
        machineId: "linux",
        hostname: "linux",
        mapped: false,
        status: "no-match",
      }),
    ).toBe("linux (unmapped: host not in machine registry)");
  });
});
