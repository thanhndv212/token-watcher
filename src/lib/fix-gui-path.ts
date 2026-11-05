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
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const LOGIN_SHELL_PATH_TIMEOUT_MS = 2_000;

export async function resolveLoginShellPath(shellOverride?: string): Promise<string | null> {
  if (process.platform === "win32") return null;

  const shellPath = shellOverride ?? process.env.SHELL ?? "/bin/zsh";
  try {
    const { stdout } = await execFileAsync(shellPath, ["-ilc", 'echo -n "$PATH"'], {
      timeout: LOGIN_SHELL_PATH_TIMEOUT_MS,
      encoding: "utf8",
    });

    // Some shell configs print a banner/MOTD to stdout before our command
    // runs; PATH itself never contains a newline, so the last non-blank
    // line is safe to take even if earlier lines are noise.
    const lines = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const lastLine = lines[lines.length - 1];
    return lastLine || null;
  } catch {
    return null;
  }
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
  const shellPath = shellOverride ?? process.env.SHELL ?? "/bin/zsh";
  try {
    const { stdout } = await execFileAsync(shellPath, ["-ilc", `echo -n "$${name}"`], {
      timeout: LOGIN_SHELL_PATH_TIMEOUT_MS,
      encoding: "utf8",
    });
    const lines = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return lines[lines.length - 1] || null;
  } catch {
    return null;
  }
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
