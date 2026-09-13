import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Launch a provider CLI.
 *
 * On Windows a .cmd/.bat shim cannot be spawned directly (Node blocks it), so
 * route those through cmd.exe with verbatim arguments. Both CLIs need this —
 * `claude` is a .cmd under npm, and `codex` is one under WindowsApps.
 */
export function spawnCli(
  binary: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  unsetEnv: string[] = [],
): ChildProcessWithoutNullStreams {
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
  for (const name of unsetEnv) delete childEnv[name];

  const options = {
    cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"] as Array<"pipe">,
    windowsHide: true,
  };

  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(binary)) {
    const quoted = [binary, ...args]
      .map((a) => `"${a.replace(/"/g, '""')}"`)
      .join(" ");
    return spawn("cmd.exe", ["/d", "/s", "/c", quoted], {
      ...options,
      windowsVerbatimArguments: true,
    }) as ChildProcessWithoutNullStreams;
  }

  return spawn(binary, args, options) as ChildProcessWithoutNullStreams;
}

/** Split a JSONL buffer into whole lines, returning the unconsumed remainder. */
export function takeLines(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let rest = buffer;
  for (;;) {
    const nl = rest.indexOf("\n");
    if (nl < 0) break;
    const line = rest.slice(0, nl).trim();
    rest = rest.slice(nl + 1);
    if (line) lines.push(line);
  }
  return { lines, rest };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Detect inherited base URLs that point back at this very server.
 *
 * Pointing a client at the socket is the whole idea, but the CLI the socket
 * spawns inherits that environment too — so without this the child would call
 * the socket, which would spawn another child, forever. Only a self-reference
 * is stripped; a corporate gateway or proxy URL is left alone.
 */
export function selfReferencingVars(names: readonly string[], port: number): string[] {
  const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);
  return names.filter((name) => {
    const value = process.env[name];
    if (!value) return false;
    try {
      const url = new URL(value);
      const urlPort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
      return loopback.has(url.hostname) && urlPort === port;
    } catch {
      return false;
    }
  });
}
