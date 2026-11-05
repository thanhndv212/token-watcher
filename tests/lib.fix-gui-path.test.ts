import { afterEach, describe, expect, it, vi } from "vitest";
import { promisify } from "util";

import { execFile } from "child_process";

// Node's real `child_process.execFile` carries a `util.promisify.custom`
// implementation that resolves `{ stdout, stderr }` from the (err, stdout,
// stderr) callback. A plain vi.fn() mock lacks that symbol, so
// `promisify(execFile)` (what fix-gui-path.ts actually calls) would silently
// fall back to generic promisify behavior and resolve with the wrong shape -
// this mock re-attaches the same custom behavior so the test exercises the
// real code path.
vi.mock("child_process", () => {
  const mocked = vi.fn() as unknown as typeof import("child_process").execFile & {
    [key: symbol]: unknown;
  };
  (mocked as any)[promisify.custom] = (file: string, args: string[], options: unknown) =>
    new Promise((resolve, reject) => {
      (mocked as any)(file, args, options, (err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });
  return { execFile: mocked };
});

const execFileMock = vi.mocked(execFile);
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

function mockShellOutput(stdout: string): void {
  execFileMock.mockImplementation((_file, _args, _options, callback) => {
    (callback as (err: Error | null, stdout: string, stderr: string) => void)(null, stdout, "");
    return {} as never;
  });
}

function mockShellError(): void {
  execFileMock.mockImplementation((_file, _args, _options, callback) => {
    (callback as (err: Error | null, stdout: string, stderr: string) => void)(
      new Error("command not found"),
      "",
      "",
    );
    return {} as never;
  });
}

afterEach(() => {
  execFileMock.mockReset();
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
});

describe("resolveLoginShellPath", () => {
  it("returns null on win32 without spawning a shell", async () => {
    setPlatform("win32");
    const { resolveLoginShellPath } = await import("../src/lib/fix-gui-path.js");

    await expect(resolveLoginShellPath()).resolves.toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("returns the login shell's PATH", async () => {
    setPlatform("darwin");
    mockShellOutput("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
    const { resolveLoginShellPath } = await import("../src/lib/fix-gui-path.js");

    await expect(resolveLoginShellPath("/bin/zsh")).resolves.toBe(
      "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    );
    expect(execFileMock).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-ilc", 'echo -n "$PATH"'],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function),
    );
  });

  it("takes the last non-blank line when the shell prints a banner first", async () => {
    setPlatform("darwin");
    mockShellOutput("Welcome to my shell!\n\n/opt/homebrew/bin:/usr/bin:/bin");
    const { resolveLoginShellPath } = await import("../src/lib/fix-gui-path.js");

    await expect(resolveLoginShellPath("/bin/zsh")).resolves.toBe(
      "/opt/homebrew/bin:/usr/bin:/bin",
    );
  });

  it("returns null when the shell invocation fails", async () => {
    setPlatform("darwin");
    mockShellError();
    const { resolveLoginShellPath } = await import("../src/lib/fix-gui-path.js");

    await expect(resolveLoginShellPath("/bin/zsh")).resolves.toBeNull();
  });

  it("returns null on empty output", async () => {
    setPlatform("darwin");
    mockShellOutput("   \n  ");
    const { resolveLoginShellPath } = await import("../src/lib/fix-gui-path.js");

    await expect(resolveLoginShellPath("/bin/zsh")).resolves.toBeNull();
  });
});

describe("mergePathEnv", () => {
  it("prepends login-shell entries missing from the current PATH", async () => {
    const { mergePathEnv } = await import("../src/lib/fix-gui-path.js");

    expect(mergePathEnv("/usr/bin:/bin", "/opt/homebrew/bin:/usr/bin")).toBe(
      "/opt/homebrew/bin:/usr/bin:/bin",
    );
  });

  it("de-duplicates without reordering the first occurrence", async () => {
    const { mergePathEnv } = await import("../src/lib/fix-gui-path.js");

    expect(mergePathEnv("/usr/bin:/bin", "/usr/bin:/opt/homebrew/bin")).toBe(
      "/usr/bin:/opt/homebrew/bin:/bin",
    );
  });

  it("treats an undefined current PATH as empty", async () => {
    const { mergePathEnv } = await import("../src/lib/fix-gui-path.js");

    expect(mergePathEnv(undefined, "/opt/homebrew/bin")).toBe("/opt/homebrew/bin");
  });
});

describe("fixGuiProcessPath", () => {
  it("merges the login shell's PATH into the given env object", async () => {
    setPlatform("darwin");
    mockShellOutput("/opt/homebrew/bin:/usr/bin:/bin");
    const { fixGuiProcessPath } = await import("../src/lib/fix-gui-path.js");

    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    await fixGuiProcessPath(env);

    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin");
  });

  it("leaves env.PATH untouched when the login shell can't be resolved", async () => {
    setPlatform("darwin");
    mockShellError();
    const { fixGuiProcessPath } = await import("../src/lib/fix-gui-path.js");

    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    await fixGuiProcessPath(env);

    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  it("fills SESSION_TRACE_DIR from the login shell only when it is unset", async () => {
    setPlatform("darwin");
    execFileMock.mockImplementation((_file, args, _options, callback) => {
      const cmd = (args as string[])[1]!;
      const out = cmd.includes("SESSION_TRACE_DIR")
        ? "banner\n/Users/me/Develop/traces"
        : "/usr/bin";
      (callback as (err: Error | null, stdout: string, stderr: string) => void)(null, out, "");
      return {} as never;
    });
    const { fixGuiProcessPath } = await import("../src/lib/fix-gui-path.js");

    const env: NodeJS.ProcessEnv = { PATH: "/bin" };
    await fixGuiProcessPath(env);
    expect(env.SESSION_TRACE_DIR).toBe("/Users/me/Develop/traces");

    const preset: NodeJS.ProcessEnv = { PATH: "/bin", SESSION_TRACE_DIR: "/already/set" };
    await fixGuiProcessPath(preset);
    expect(preset.SESSION_TRACE_DIR).toBe("/already/set");
  });

  it("leaves SESSION_TRACE_DIR unset when the login shell has none", async () => {
    setPlatform("darwin");
    execFileMock.mockImplementation((_file, args, _options, callback) => {
      const cmd = (args as string[])[1]!;
      (callback as (err: Error | null, stdout: string, stderr: string) => void)(
        null,
        cmd.includes("SESSION_TRACE_DIR") ? "" : "/usr/bin",
        "",
      );
      return {} as never;
    });
    const { fixGuiProcessPath } = await import("../src/lib/fix-gui-path.js");
    const env: NodeJS.ProcessEnv = { PATH: "/bin" };
    await fixGuiProcessPath(env);
    expect("SESSION_TRACE_DIR" in env).toBe(false);
  });
});
