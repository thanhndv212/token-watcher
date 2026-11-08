import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import { resolveLoginShellPath, resolveLoginShellVar } from "../src/lib/fix-gui-path.js";

// Spawns real processes (the sibling test mocks child_process). These model
// login shells that never finish: e.g. zsh blocked in open() on a
// TCC-protected ~/Downloads file sourced from .zshrc, which a GUI launch waits
// on indefinitely and which ignores SIGTERM. Startup must still continue.
const posix = process.platform !== "win32";
let dir = "";

async function script(name: string, body: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

beforeAll(async () => {
  if (posix) dir = await mkdtemp(path.join(tmpdir(), "fix-gui-path-"));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!posix)("login shell resolution against hung shells", () => {
  it("settles when the shell ignores SIGTERM", async () => {
    // Ignored signals survive exec, so `sleep` ignores SIGTERM like the hung zsh.
    const shell = await script("ignore-term.sh", "trap '' TERM\nexec sleep 30");
    const started = Date.now();
    await expect(resolveLoginShellPath(shell)).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it("settles when a background child keeps stdout open", async () => {
    const shell = await script("grandchild.sh", "sleep 30 &\ntrap '' TERM\nexec sleep 30");
    const started = Date.now();
    await expect(resolveLoginShellVar("SESSION_TRACE_DIR", shell)).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it("still returns the value from a shell that answers", async () => {
    const shell = await script("ok.sh", "printf 'banner\\n/opt/homebrew/bin:/usr/bin'");
    await expect(resolveLoginShellPath(shell)).resolves.toBe("/opt/homebrew/bin:/usr/bin");
  });
});
