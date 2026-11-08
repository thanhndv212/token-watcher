/**
 * GUI apps launched via Finder/Dock/Spotlight (not a Terminal) get macOS's
 * bare default PATH (`/etc/paths`: /usr/local/bin, /usr/bin, /bin, ...) -
 * Homebrew on Apple Silicon (/opt/homebrew/bin), nvm, volta, etc. are only
 * on PATH because the user's shell profile (.zshrc/.zprofile) exports them,
 * and GUI launches never source that profile. Any provider that shells out
 * to a CLI (Claude Code, gh, etc.) then looks "not installed" even though a
 * Terminal finds it fine - the classic symptom being "works when I test it
 * myself, missing in the actual app." Fix: resolve the user's real
 * login-shell PATH once at startup and merge it in.
 */

import { execFile } from "child_process";

const LOGIN_SHELL_PATH_TIMEOUT_MS = 2_000;
/** Grace after the kill for the child's stdout to close before we give up on it. */
const LOGIN_SHELL_SETTLE_GRACE_MS = 500;

/**
 * Run `<shell> -ilc <command>` and return the last non-blank stdout line, or
 * null on any failure. Always settles within the timeout plus a short grace:
 * an interactive zsh ignores SIGTERM, and one blocked in a syscall (e.g. open()
 * on a TCC-protected ~/Downloads file sourced from .zshrc, which a GUI launch
 * waits on indefinitely) never exits on its own. A background job the profile
 * starts can also hold stdout open after the shell dies, so execFile's
 * callback alone is not a reliable end signal.
 */
function readFromLoginShell(shellPath: string, command: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(value);
    };
    const child = execFile(
      shellPath,
      ["-ilc", command],
      { timeout: LOGIN_SHELL_PATH_TIMEOUT_MS, killSignal: "SIGKILL", encoding: "utf8" },
      (error, stdout) => {
        if (error) return finish(null);
        // Some shell configs print a banner/MOTD to stdout before our command
        // runs; the value itself never contains a newline, so the last
        // non-blank line is safe to take even if earlier lines are noise.
        const lines = String(stdout)
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        finish(lines[lines.length - 1] || null);
      },
    );
    if (settled) return;
    deadline = setTimeout(() => {
      child?.kill?.("SIGKILL");
      child?.stdout?.destroy?.();
      child?.stderr?.destroy?.();
      finish(null);
    }, LOGIN_SHELL_PATH_TIMEOUT_MS + LOGIN_SHELL_SETTLE_GRACE_MS);
    deadline.unref?.();
  });
}

export async function resolveLoginShellPath(shellOverride?: string): Promise<string | null> {
  if (process.platform === "win32") return null;
  return readFromLoginShell(shellOverride ?? process.env.SHELL ?? "/bin/zsh", 'echo -n "$PATH"');
}

export function mergePathEnv(currentPath: string | undefined, loginShellPath: string): string {
  const current = (currentPath ?? "").split(":").filter(Boolean);
  const fromLoginShell = loginShellPath.split(":").filter(Boolean);
  return [...new Set([...fromLoginShell, ...current])].join(":");
}

/**
 * Variables other tools export from the shell profile that change where
 * Token Watcher reads data. `SESSION_TRACE_DIR` locates the Session Knowledge
 * machine registry.
 */
export const LOGIN_SHELL_ENV_VARS = ["SESSION_TRACE_DIR"] as const;

/** One variable from the login shell, or null when unset or unavailable. */
export async function resolveLoginShellVar(
  name: (typeof LOGIN_SHELL_ENV_VARS)[number],
  shellOverride?: string,
): Promise<string | null> {
  if (process.platform === "win32") return null;
  return readFromLoginShell(shellOverride ?? process.env.SHELL ?? "/bin/zsh", `echo -n "$${name}"`);
}

/**
 * Best-effort: never throws, leaves `env.PATH` untouched if the login shell
 * can't be resolved (unsupported shell, timeout, sandboxed environment).
 * Variables in {@link LOGIN_SHELL_ENV_VARS} are filled in only when unset.
 */
export async function fixGuiProcessPath(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const missing = LOGIN_SHELL_ENV_VARS.filter((name) => !env[name]);
  const [loginShellPath, ...values] = await Promise.all([
    resolveLoginShellPath(),
    ...missing.map((name) => resolveLoginShellVar(name)),
  ]);
  missing.forEach((name, i) => {
    if (values[i]) env[name] = values[i]!;
  });
  if (!loginShellPath) return;
  env.PATH = mergePathEnv(env.PATH, loginShellPath);
}
