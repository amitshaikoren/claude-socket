import { execFile, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { log } from "../util/log.ts";

const execFileAsync = promisify(execFile);

/** One OS process, as the operating system reports it. */
export interface OsProcess {
  pid: number;
  name: string;
  /** Epoch ms the OS says the process started, or 0 if it could not be read. */
  startedMs: number;
}

/** Wall-clock ceiling on any probe; a wedged shell must not wedge the reaper. */
const PROBE_TIMEOUT_MS = 10_000;

/** Emits `pid|name|startedMs` per process, which `parseRows` reads back. */
const ROW =
  "'{0}|{1}|{2}' -f $_.ProcessId, $_.Name, " +
  "[int64]($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds";

function parseRows(stdout: string): OsProcess[] {
  const out: OsProcess[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [pid, name, started] = line.trim().split("|");
    if (!pid || !name) continue;
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) continue;
    out.push({ pid: n, name, startedMs: Number(started) || 0 });
  }
  return out;
}

async function powershell(command: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
  );
  return stdout;
}

/** `[[dd-]hh:]mm:ss`, as `ps` reports elapsed time, in milliseconds. */
function elapsedMs(etime: string): number {
  const dash = etime.indexOf("-");
  const days = dash < 0 ? 0 : Number(etime.slice(0, dash));
  const parts = etime.slice(dash + 1).split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts as [number, number, number];
  return ((days * 24 + h) * 3600 + m * 60 + s) * 1000;
}

function parsePosix(stdout: string): OsProcess[] {
  const out: OsProcess[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    // `ps` reports elapsed time, not a start instant; converting it here keeps
    // `startedMs` meaning the same thing on every platform.
    out.push({ pid: Number(m[1]), name: m[3]!.trim(), startedMs: Date.now() - elapsedMs(m[2]!) });
  }
  return out;
}

/** Every direct child of `parentPid` the OS currently holds. */
export async function listChildren(parentPid: number): Promise<OsProcess[]> {
  try {
    if (process.platform === "win32") {
      const filter = `ParentProcessId=${parentPid}`;
      return parseRows(
        await powershell(`Get-CimInstance Win32_Process -Filter '${filter}' | % { ${ROW} }`),
      );
    }
    const { stdout } = await execFileAsync(
      "ps",
      ["-o", "pid=,etime=,comm=", "--ppid", String(parentPid)],
      { timeout: PROBE_TIMEOUT_MS },
    );
    return parsePosix(stdout);
  } catch (err) {
    // A failed enumeration must never read as "there are no orphans": the
    // caller does nothing rather than act on an empty answer.
    log.warn("could not enumerate child processes", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Look up specific pids by number. Unknown or dead pids are simply absent. */
export async function describe(pids: number[]): Promise<OsProcess[]> {
  if (pids.length === 0) return [];
  try {
    if (process.platform === "win32") {
      const filter = pids.map((p) => `ProcessId=${p}`).join(" or ");
      return parseRows(
        await powershell(`Get-CimInstance Win32_Process -Filter '${filter}' | % { ${ROW} }`),
      );
    }
    const { stdout } = await execFileAsync("ps", ["-o", "pid=,etime=,comm=", "-p", pids.join(",")], {
      timeout: PROBE_TIMEOUT_MS,
    });
    return parsePosix(stdout);
  } catch {
    return [];
  }
}

/** Whether a pid currently names a live process. EPERM means alive but not ours. */
export function isRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Kill one process and everything below it.
 *
 * Node's `child.kill()` on Windows terminates only the process it holds a
 * handle to, so a CLI that spawned helpers of its own leaks them regardless.
 * `taskkill /T` walks the tree instead. Every pid reaching here has already
 * been established as a descendant of this bridge.
 */
export async function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    return;
  }
  process.kill(pid, "SIGKILL");
}

/**
 * The blocking form, for the shutdown path.
 *
 * Exit must not race a timer: anything still owed a kill when the bridge is on
 * its way out gets it now, on this stack, before the process leaves.
 */
export function killTreeSync(pids: number[]): void {
  const live = pids.filter(isRunning);
  if (live.length === 0) return;
  try {
    if (process.platform === "win32") {
      const args = live.flatMap((pid) => ["/PID", String(pid)]);
      execFileSync("taskkill.exe", [...args, "/T", "/F"], {
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
        stdio: "ignore",
      });
      return;
    }
    for (const pid of live) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  } catch {
    // taskkill exits non-zero when a pid dies between the check and the call,
    // which is the ordinary case and not a failure worth reporting.
  }
}

/** How far the OS's start time may sit from ours before a pid is a stranger. */
const IDENTITY_TOLERANCE_MS = 60_000;

interface Recorded {
  pid: number;
  startedMs: number;
}

/**
 * The pids this bridge has spawned, on disk.
 *
 * A sweep by parent pid cannot survive a restart: the orphans of a dead bridge
 * name a parent pid that no longer exists, and "the parent is gone" would put
 * every stranger's `claude.exe` in range — including the desktop app's. So the
 * bridge writes down what it spawned, and the next one kills only pids on that
 * list whose OS start time still matches what was recorded. A recycled pid
 * cannot pass that test.
 */
export class ChildRegistry {
  #path: string;
  #entries = new Map<number, number>();
  #dirty = false;
  #timer: NodeJS.Timeout | null = null;

  constructor(path: string) {
    this.#path = path;
  }

  /** What the previous run left behind. Reading it also takes the file over. */
  takeOver(): Recorded[] {
    let previous: Recorded[] = [];
    try {
      const raw: unknown = JSON.parse(readFileSync(this.#path, "utf8"));
      if (Array.isArray(raw)) {
        previous = raw.filter(
          (e): e is Recorded =>
            typeof e === "object" &&
            e !== null &&
            typeof (e as Recorded).pid === "number" &&
            typeof (e as Recorded).startedMs === "number",
        );
      }
    } catch {
      /* no file, or unreadable: nothing was recorded */
    }
    this.#entries.clear();
    this.#flush();
    return previous;
  }

  /**
   * Which of `previous` are still the very processes that were recorded.
   *
   * Both halves matter: the pid must still be live, and the OS must agree about
   * when it started. Anything else is a pid the OS has since handed to someone
   * else, and killing it would hit a stranger.
   */
  static async survivors(previous: Recorded[]): Promise<OsProcess[]> {
    const live = previous.filter((e) => isRunning(e.pid));
    if (live.length === 0) return [];
    const seen = await describe(live.map((e) => e.pid));
    const recorded = new Map(live.map((e) => [e.pid, e.startedMs]));
    return seen.filter((p) => {
      const at = recorded.get(p.pid);
      if (at === undefined) return false;
      return Math.abs(p.startedMs - at) <= IDENTITY_TOLERANCE_MS;
    });
  }

  add(pid: number, startedMs: number): void {
    this.#entries.set(pid, startedMs);
    this.#schedule();
  }

  remove(pid: number): void {
    if (this.#entries.delete(pid)) this.#schedule();
  }

  /**
   * Forget recorded pids that are neither still ours nor still running.
   *
   * A driver that spawns a child per turn records a new pid every turn and
   * never has an obvious moment to retract the last one. Nothing breaks if they
   * pile up — `survivors` checks start times, so a recycled pid is never
   * mistaken for ours — but the file would grow all session, so the reap tick
   * sweeps it instead.
   */
  prune(keep: ReadonlySet<number>): void {
    for (const pid of [...this.#entries.keys()]) {
      if (keep.has(pid) || isRunning(pid)) continue;
      this.#entries.delete(pid);
      this.#dirty = true;
    }
    if (this.#dirty) this.#schedule();
  }

  /** Coalesced: a burst of spawns costs one write, not one per process. */
  #schedule(): void {
    this.#dirty = true;
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#dirty) this.#flush();
    }, 250);
    this.#timer.unref?.();
  }

  #flush(): void {
    this.#dirty = false;
    const rows: Recorded[] = [...this.#entries].map(([pid, startedMs]) => ({ pid, startedMs }));
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      writeFileSync(this.#path, JSON.stringify(rows), "utf8");
    } catch (err) {
      log.debug("could not write the child pid registry", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Nothing is owed once the bridge has cleaned up after itself. */
  clear(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#entries.clear();
    try {
      rmSync(this.#path, { force: true });
    } catch {
      /* best effort */
    }
  }
}
