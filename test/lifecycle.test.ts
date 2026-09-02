import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestServer, authHeaders, testConfig, testClass, FAKE_CLI } from "./helpers.ts";
import { SessionManager } from "../src/claude/sessions.ts";
import { ClaudeProcess } from "../src/claude/process.ts";
import { isRunning, listChildren } from "../src/claude/reaper.ts";
import type { Config } from "../src/core/config.ts";

/**
 * The leak these cover was never in the reaper. A turn that ended in an error —
 * an upstream 429, say — was thrown out of by the API layer, which abandoned the
 * `run()` generator mid-yield. An abandoned async generator never runs its
 * `finally`, so the session's mutex was never released; and a locked entry is
 * skipped by the reaper *and* by eviction, so the CLI behind it was never
 * disposed and never even considered again. Ninety of them, holding 8.2 GB.
 *
 * These tests take the mechanism apart at each layer: the lock, the pool, the
 * disposal, and the OS-level sweep that is the last line if all of it fails.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `check` holds, or give up. Returns whether it held. */
async function eventually(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
}

function pidsOf(sessions: SessionManager): number[] {
  return sessions.stats().map((s) => s["pid"] as number | null).filter((p): p is number => p !== null);
}

/** Kill something the test itself spawned, without going through the code under test. */
function cleanup(children: Array<ChildProcess | number>): void {
  for (const c of children) {
    const pid = typeof c === "number" ? c : c.pid;
    if (pid === undefined || !isRunning(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function tempRegistry(): string {
  return join(mkdtempSync(join(tmpdir(), "socket-pids-")), "children.json");
}

describe("a failed turn does not pin its session", () => {
  test("an upstream error leaves no session stuck busy, and its process is reclaimed", async () => {
    const cfg = testConfig();
    // The CLI reports a 429 and stays up, exactly as it does on a session limit.
    cfg.claude.env = { FAKE_ERROR: "429" };
    cfg.sessions.max = 3;
    const server = await startTestServer(cfg);
    try {
      for (let i = 0; i < 6; i++) {
        const res = await fetch(`${server.base}/v1/chat/completions`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ model: "oracle", messages: [{ role: "user", content: `ask ${i}` }] }),
        });
        assert.equal(res.ok, false, "the fake CLI was asked to fail this turn");
        await res.text();
      }

      const busy = server.sessions.stats().filter((s) => s["busy"] === true);
      assert.deepEqual(busy, [], "a turn that errored must not leave its session holding the lock");

      // With the lock released, `max` means something again: the pool is not
      // allowed to grow past it, which is what stopped happening in production.
      assert.ok(
        server.sessions.size <= cfg.sessions.max,
        `pool grew to ${server.sessions.size}, past max ${cfg.sessions.max}`,
      );
    } finally {
      await server.close();
    }
  });

  test("a client that hangs up mid-stream releases the session too", async () => {
    const cfg = testConfig();
    cfg.claude.env = { FAKE_SLOW: "1" };
    const server = await startTestServer(cfg);
    try {
      const abort = new AbortController();
      const res = await fetch(`${server.base}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders(),
        signal: abort.signal,
        body: JSON.stringify({
          model: "oracle",
          stream: true,
          messages: [{ role: "user", content: "start talking and I will leave" }],
        }),
      });
      const reader = res.body!.getReader();
      await reader.read();
      abort.abort();
      await reader.cancel().catch(() => {});

      const released = await eventually(
        () => server.sessions.stats().every((s) => s["busy"] !== true),
        10_000,
      );
      assert.ok(released, "the session was still marked busy after the client went away");
    } finally {
      await server.close();
    }
  });
});

describe("eviction and reaping reach the process", () => {
  test("a session dropped by eviction leaves no live process behind", async () => {
    const cfg = testConfig();
    cfg.sessions.max = 2;
    const server = await startTestServer(cfg);
    const seen = new Set<number>();
    try {
      for (let i = 0; i < 6; i++) {
        const res = await fetch(`${server.base}/v1/chat/completions`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({
            model: "oracle",
            messages: [{ role: "user", content: `unrelated conversation ${i}` }],
          }),
        });
        assert.equal(res.status, 200);
        await res.json();
        for (const pid of pidsOf(server.sessions)) seen.add(pid);
      }

      // Six unrelated conversations through a pool of two: at least four
      // sessions were evicted along the way.
      assert.ok(seen.size >= 4, `expected several sessions, saw ${seen.size}`);
      const live = new Set(pidsOf(server.sessions));
      const evicted = [...seen].filter((pid) => !live.has(pid));
      assert.ok(evicted.length > 0, "nothing was evicted, so this proves nothing");

      const dead = await eventually(() => evicted.every((pid) => !isRunning(pid)));
      assert.ok(
        dead,
        `evicted sessions still running: ${evicted.filter(isRunning).join(", ")}`,
      );
    } finally {
      await server.close();
    }
  });

  test("a process the pool has lost track of is still reaped", async () => {
    const cfg = testConfig();
    const sessions = new SessionManager(cfg);
    // A CLI the pool never knew about: dropped by a bug, orphaned by a botched
    // disposal, whatever. Nothing in the pool's own maps can see it — only a
    // reconciliation against the OS can.
    const stray = spawn(process.execPath, [FAKE_CLI], { stdio: "pipe" });
    try {
      await eventually(() => stray.pid !== undefined && isRunning(stray.pid));
      assert.ok(isRunning(stray.pid!), "the stray never started");
      assert.ok(
        !pidsOf(sessions).includes(stray.pid!),
        "the pool must not be tracking it, or this tests nothing",
      );

      // Age zero: the default guard exists to spare the bridge's own helper
      // processes, and is covered on its own below.
      await sessions.sweepOrphans(0);
      const dead = await eventually(() => !isRunning(stray.pid!));
      assert.ok(dead, "the orphan sweep left an untracked child of ours running");
    } finally {
      cleanup([stray]);
      sessions.shutdown();
    }
  });

  test("the sweep spares processes younger than its own probes", async () => {
    const cfg = testConfig();
    const sessions = new SessionManager(cfg);
    // The bridge's own helpers are direct children too — the PowerShell the
    // enumeration runs in most of all. Without the age guard the sweep finds
    // its own probe and tries to kill it, which is both wrong and noisy.
    const fresh = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });
    try {
      await eventually(() => fresh.pid !== undefined && isRunning(fresh.pid));
      await sessions.sweepOrphans();
      await sleep(500);
      assert.ok(isRunning(fresh.pid!), "the sweep killed a process it had no way to vouch for");
    } finally {
      cleanup([fresh]);
      sessions.shutdown();
    }
  });

  test("the sweep spares the sessions the pool is tracking", async () => {
    const cfg = testConfig();
    const server = await startTestServer(cfg);
    try {
      const res = await fetch(`${server.base}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ model: "oracle", messages: [{ role: "user", content: "keep me" }] }),
      });
      assert.equal(res.status, 200);
      await res.json();

      const tracked = pidsOf(server.sessions);
      assert.ok(tracked.length > 0);
      await server.sessions.sweepOrphans();
      await sleep(500);
      assert.deepEqual(
        tracked.filter((pid) => !isRunning(pid)),
        [],
        "the sweep killed a session the pool was still using",
      );
    } finally {
      await server.close();
    }
  });
});

describe("the sweep stays inside our own children", () => {
  test("it never considers a pid that is not a direct child of this process", async () => {
    const cfg = testConfig();
    const childPidFile = join(mkdtempSync(join(tmpdir(), "socket-gc-")), "pid");
    // The CLI spawns a helper of its own, so there is a process that is ours by
    // descent but is not our child. The desktop app's `claude.exe` children sit
    // in exactly that relationship to the WindowsApps parent, which is why the
    // sweep is scoped to direct children and never to an image name.
    cfg.claude.env = { FAKE_SPAWN_CHILD: childPidFile };
    const server = await startTestServer(cfg);
    let grandchild: number | null = null;
    try {
      const res = await fetch(`${server.base}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ model: "oracle", messages: [{ role: "user", content: "hello" }] }),
      });
      assert.equal(res.status, 200);
      await res.json();

      await eventually(() => {
        try {
          grandchild = Number(readFileSync(childPidFile, "utf8"));
          return Number.isInteger(grandchild) && grandchild > 0;
        } catch {
          return false;
        }
      });
      assert.ok(grandchild !== null && isRunning(grandchild), "the grandchild never started");

      const children = await listChildren(process.pid);
      const childPids = children.map((c) => c.pid);
      assert.ok(
        !childPids.includes(grandchild!),
        "a grandchild showed up as a direct child; the sweep's scope is wrong",
      );
      // The process that spawned this test is emphatically not ours to kill.
      assert.ok(!childPids.includes(process.ppid), "our own parent is in the candidate set");
      assert.ok(!childPids.includes(process.pid), "we are in our own candidate set");

      await server.sessions.sweepOrphans();
      await sleep(500);
      assert.ok(isRunning(grandchild!), "the sweep reached outside our direct children");
    } finally {
      if (grandchild !== null) cleanup([grandchild]);
      await server.close();
    }
  });

  test("a sweep with nothing tracked still only sees our children", async () => {
    const cfg = testConfig();
    const sessions = new SessionManager(cfg);
    try {
      const children = await listChildren(process.pid);
      // Enumeration is the whole safety property: whatever it returns is what
      // the sweep may kill, so it must never contain a process we did not spawn.
      for (const child of children) {
        assert.notEqual(child.pid, process.pid);
        assert.notEqual(child.pid, process.ppid);
      }
    } finally {
      sessions.shutdown();
    }
  });
});

describe("disposal verifies the kill", () => {
  /** A process whose first kill silently misses, as a stuck SIGKILL would. */
  class DeafProcess extends ClaudeProcess {
    sigkilled = false;
    protected override sigkill(): void {
      this.sigkilled = true; // …and deliberately do not kill anything.
    }
  }

  test("dispose escalates when the first kill does not land", async () => {
    const cfg: Config = testConfig();
    // The CLI ignores its stdin closing, so the polite stage cannot succeed
    // either: disposal has to reach for something stronger, twice.
    cfg.claude.env = { FAKE_IGNORE_STDIN_CLOSE: "1" };

    const lines: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      lines.push(String(chunk));
      return (realWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;

    const proc = new DeafProcess(cfg, testClass());
    try {
      await eventually(() => proc.pid !== null && isRunning(proc.pid));
      const pid = proc.pid!;
      assert.ok(isRunning(pid), "the fake CLI never started");

      proc.dispose();
      const dead = await eventually(() => !isRunning(pid), 20_000);

      assert.ok(proc.sigkilled, "the first kill was never attempted");
      assert.ok(dead, "the process outlived a disposal whose first kill missed");
      assert.ok(
        lines.some((l) => l.includes("survived SIGKILL")),
        "the escalation was silent; a swallowed failure is how this went unnoticed",
      );
    } finally {
      process.stderr.write = realWrite;
      if (proc.pid !== null) cleanup([proc.pid]);
    }
  });

  test("an ordinary disposal needs no escalation and says nothing", async () => {
    const cfg = testConfig();
    const proc = new ClaudeProcess(cfg, testClass());
    await eventually(() => proc.pid !== null && isRunning(proc.pid));
    const pid = proc.pid!;
    proc.dispose();
    assert.ok(await eventually(() => !isRunning(pid)), "a cooperative CLI was not disposed");
    // `whenGone` is what the pool waits on before it stops tracking the pid.
    await proc.whenGone;
  });
});

describe("a restart cleans up after the run before it", () => {
  test("the startup sweep kills what a previous bridge abandoned", async () => {
    const registryPath = tempRegistry();

    const first = testConfig();
    first.sessions.registryPath = registryPath;
    // A bridge that spawned a CLI and then died without running its shutdown
    // path: the process survives, and its parent pid now names nothing, so no
    // sweep by parentage can ever find it again. The registry can.
    const abandoned = new SessionManager(first);
    const events = abandoned.run({
      cls: testClass(),
      messages: [{ role: "user", content: [{ type: "text", text: "orphan me" }] }],
      pinnedSession: null,
      maxBudgetUsd: null,
      advertisedModel: "oracle",
    });
    for await (const _event of events) {
      /* drained, so the turn completes normally */
    }

    const pid = pidsOf(abandoned)[0]!;
    assert.ok(isRunning(pid), "the session's process should be up");
    await eventually(() => {
      try {
        return JSON.parse(readFileSync(registryPath, "utf8")).length > 0;
      } catch {
        return false;
      }
    });

    try {
      const second = testConfig();
      second.sessions.registryPath = registryPath;
      const restarted = new SessionManager(second);
      try {
        const dead = await eventually(() => !isRunning(pid));
        assert.ok(dead, "the restarted bridge left the previous run's process running");
      } finally {
        restarted.shutdown();
      }
    } finally {
      cleanup([pid]);
    }
  });

  test("a recorded pid the OS has recycled is left alone", async () => {
    const registryPath = tempRegistry();
    // A stranger, recorded under a start time that cannot be ours. This is the
    // case that makes a pid file safe to act on: without the start-time check a
    // restart would kill whoever inherited the number.
    const stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
      stdio: "ignore",
    });
    try {
      await eventually(() => stranger.pid !== undefined && isRunning(stranger.pid));
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        registryPath,
        JSON.stringify([{ pid: stranger.pid, startedMs: Date.now() - 60 * 60_000 }]),
        "utf8",
      );

      const cfg = testConfig();
      cfg.sessions.registryPath = registryPath;
      const sessions = new SessionManager(cfg);
      try {
        await sleep(2000);
        assert.ok(
          isRunning(stranger.pid!),
          "the startup sweep killed a pid that was not the one recorded",
        );
      } finally {
        sessions.shutdown();
      }
    } finally {
      cleanup([stranger]);
    }
  });
});

describe("shutdown leaves nothing behind", () => {
  test("every session's process is gone once shutdown returns", async () => {
    const cfg = testConfig();
    // Nothing here exits politely, so only a real kill can clear them — which
    // is the case the unref'd disposal timers used to lose on a fast exit.
    cfg.claude.env = { FAKE_IGNORE_STDIN_CLOSE: "1" };
    const server = await startTestServer(cfg);

    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${server.base}/v1/chat/completions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ model: "oracle", messages: [{ role: "user", content: `hi ${i}` }] }),
      });
      assert.equal(res.status, 200);
      await res.json();
    }

    const pids = pidsOf(server.sessions);
    assert.ok(pids.length > 0);
    await server.close();
    // Synchronous by design: shutdown does not hand the kill to a timer that
    // the exiting process may never run.
    assert.deepEqual(pids.filter(isRunning), [], "shutdown returned with processes still alive");
  });
});
