import { mkdirSync } from "node:fs";
import type { Config } from "../core/config.ts";
import { ClaudeProcess } from "./process.ts";
import { ChildRegistry, killTree, killTreeSync, listChildren } from "./reaper.ts";
import { Mutex } from "../util/mutex.ts";
import { chain, sha256 } from "../util/hash.ts";
import { log } from "../util/log.ts";
import { telemetry } from "../core/telemetry.ts";
import { formatToolUse } from "../core/activity.ts";
import { isAgentic, toolPolicyKey } from "../core/types.ts";
import type {
  SocketMessage,
  SocketRequest,
  ContentBlock,
  SessionClass,
  TurnEvent,
} from "../core/types.ts";

interface Entry {
  proc: ClaudeProcess;
  mutex: Mutex;
  /** Hash of the conversation prefix this process has already consumed. */
  chainKey: string;
}

function canonicalMessage(msg: SocketMessage): string {
  const parts = msg.content.map((block) => {
    if (block.type === "text") return "t:" + block.text;
    if (block.source.type === "base64") return "i:" + sha256(block.source.data);
    return "i:" + block.source.url;
  });
  return msg.role + "|" + parts.join("\0");
}

function classKey(cls: SessionClass): string {
  return sha256(
    JSON.stringify([
      cls.mode,
      cls.model,
      cls.systemPrompt,
      cls.effort,
      cls.cwd,
      cls.jsonSchema,
      // A process spawned with one tool set can never answer for another: the
      // flags are fixed at spawn time and the agent has already been told what
      // it has. Two tool sets are two session classes.
      toolPolicyKey(cls.tools),
    ]),
  );
}

/**
 * Hash chain over the *user* messages only.
 *
 * Assistant turns are deliberately excluded: they live in the CLI's context
 * already, and clients do not always echo them back byte-for-byte (whitespace
 * trimming, injected metadata). Chaining on user messages alone keeps prefix
 * matching stable across those rewrites.
 */
function userChain(cls: SessionClass, messages: SocketMessage[]): string[] {
  const hashes: string[] = [];
  let current = classKey(cls);
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    current = chain(current, canonicalMessage(msg));
    hashes.push(current);
  }
  return hashes;
}

function textOf(msg: SocketMessage): string {
  return msg.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function imagesOf(messages: SocketMessage[]): ContentBlock[] {
  return messages.flatMap((m) => m.content.filter((b) => b.type === "image"));
}

/**
 * Build the content for a fresh session that has prior history to catch up on.
 * A single opening user message is passed through untouched so oracle mode
 * stays a faithful prompt-in/completion-out endpoint.
 */
export function renderSeed(messages: SocketMessage[]): ContentBlock[] {
  const conversational = messages.filter((m) => m.role !== "system");
  if (conversational.length === 1 && conversational[0]!.role === "user") {
    return conversational[0]!.content;
  }

  const history = conversational.slice(0, -1);
  const last = conversational[conversational.length - 1];
  const transcript = history
    .map((m) => `<turn role="${m.role}">\n${textOf(m)}\n</turn>`)
    .join("\n");

  const text =
    `<conversation_so_far>\n${transcript}\n</conversation_so_far>\n\n` +
    `Continue this conversation. Reply only with your next assistant message, ` +
    `with no preamble and no role label.\n\n` +
    `<current_message>\n${last ? textOf(last) : ""}\n</current_message>`;

  return [{ type: "text", text }, ...imagesOf(conversational)];
}

/** Join a tail of consecutive user messages into the content for one turn. */
function renderTail(messages: SocketMessage[]): ContentBlock[] {
  if (messages.length === 1) return messages[0]!.content;
  const text = messages.map((m) => textOf(m)).join("\n\n");
  return [{ type: "text", text }, ...imagesOf(messages)];
}

const REAP_INTERVAL_MS = 30_000;
/** How long a disposal is left alone before the orphan sweep counts it as leaked. */
const DISPOSAL_GRACE_MS = 30_000;
/** Margin past the turn timeout before a still-locked session is called wedged. */
const WEDGE_MARGIN_MS = 30_000;
/**
 * How old a child must be before the sweep will consider it an orphan.
 *
 * The bridge's own short-lived helpers are direct children too — the PowerShell
 * the enumeration runs in, the `taskkill` that follows it, the `claude
 * --version` probe at startup — and every one of them is younger than the sweep
 * that would find it. Anything genuinely leaked was spawned for a request long
 * before this tick, so nothing real is lost by ignoring the last few seconds,
 * and a process that leaks inside the window is caught on the next pass.
 */
const ORPHAN_MIN_AGE_MS = 10_000;

export class SessionManager {
  #cfg: Config;
  #byChain = new Map<string, Entry>();
  /** Populated once the CLI reports its session id, which it does lazily. */
  #bySessionId = new Map<string, Entry>();
  /** The authoritative set of live sessions, including ones still starting up. */
  #entries = new Set<Entry>();
  #reaper: NodeJS.Timeout;
  #registry: ChildRegistry;
  /** pid -> deadline until which a disposal in flight is not yet an orphan. */
  #disposing = new Map<number, number>();
  #sweeping = false;
  #closed = false;

  constructor(cfg: Config) {
    this.#cfg = cfg;
    this.#registry = new ChildRegistry(cfg.sessions.registryPath);
    void this.#sweepPreviousRun();
    this.#reaper = setInterval(() => this.#reap(), REAP_INTERVAL_MS);
    this.#reaper.unref?.();
  }

  /** Every pid this pool believes it is responsible for right now. */
  #trackedPids(): Set<number> {
    const pids = new Set<number>();
    for (const entry of this.#entries) {
      if (entry.proc.pid !== null) pids.add(entry.proc.pid);
    }
    const now = Date.now();
    for (const [pid, deadline] of this.#disposing) {
      if (deadline > now) pids.add(pid);
      else this.#disposing.delete(pid);
    }
    return pids;
  }

  /**
   * Kill what a previous bridge abandoned.
   *
   * Sweeping by parent pid cannot reach these: their parent pid names a process
   * that no longer exists. The registry is the only record that ties them to us,
   * and it carries a start time precisely so a pid the OS has since recycled
   * cannot be mistaken for one of ours.
   */
  async #sweepPreviousRun(): Promise<void> {
    const previous = this.#registry.takeOver();
    if (previous.length === 0) return;
    const survivors = await ChildRegistry.survivors(previous);
    if (survivors.length === 0) return;
    log.warn("killing CLI processes abandoned by a previous run", {
      count: survivors.length,
      pids: survivors.map((p) => p.pid),
    });
    for (const proc of survivors) await this.#kill(proc.pid, proc.name, "previous run");
  }

  /**
   * Reconcile the pool against what the OS actually holds.
   *
   * The pool's own bookkeeping is the wrong place to look for a process it has
   * forgotten — a session dropped, evicted, or lost to a bug is invisible to
   * every map here by definition. This is the only check that can see one, so
   * it asks the operating system instead: our own children, minus the pids we
   * are still accounting for, are orphans.
   *
   * Strictly by parent pid. Nothing outside this bridge's own children is ever
   * a candidate, which is what keeps the user's editor sessions and desktop app
   * — which have `claude.exe` children of their own — out of range.
   */
  async sweepOrphans(minAgeMs = ORPHAN_MIN_AGE_MS): Promise<void> {
    if (this.#sweeping || this.#closed) return;
    this.#sweeping = true;
    try {
      const cutoff = Date.now() - minAgeMs;
      const children = await listChildren(process.pid);
      if (children.length === 0) return;
      const tracked = this.#trackedPids();
      // A child whose start time could not be read is left alone: age is half
      // of what makes this safe, and an unverifiable process is not a target.
      const orphans = children.filter(
        (c) => !tracked.has(c.pid) && c.startedMs > 0 && c.startedMs < cutoff,
      );
      if (orphans.length === 0) return;
      // Loud on purpose. A silent sweep would keep the pool looking healthy
      // while quietly mopping up after whatever is actually leaking.
      log.warn("orphaned CLI processes found; killing them", {
        count: orphans.length,
        tracked: tracked.size,
        pids: orphans.map((p) => p.pid),
      });
      for (const proc of orphans) await this.#kill(proc.pid, proc.name, "orphan sweep");
    } finally {
      this.#sweeping = false;
    }
  }

  async #kill(pid: number, name: string, reason: string): Promise<void> {
    try {
      await killTree(pid);
      log.warn("killed orphaned CLI process", { pid, name, reason });
      this.#registry.remove(pid);
      telemetry.emit("session", { action: "orphan_killed", pid, name, reason });
    } catch (err) {
      log.error("could not kill orphaned CLI process", {
        pid,
        name,
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  stats(): Array<Record<string, unknown>> {
    return [...this.#entries].map((e) => ({
      sessionId: e.proc.sessionId,
      pid: e.proc.pid,
      mode: e.proc.cls.mode,
      model: e.proc.cls.model,
      turns: e.proc.turns,
      costUsd: Number(e.proc.totalCostUsd.toFixed(6)),
      idleSeconds: Math.round(e.proc.idleMs / 1000),
      busy: e.mutex.locked,
      alive: e.proc.alive,
      // `null` means the CLI's own default set, which is the harness case.
      tools: e.proc.cls.tools.tools,
      disallowedTools: e.proc.cls.tools.disallowed,
    }));
  }

  rateLimit(): unknown {
    for (const entry of this.#entries) {
      if (entry.proc.rateLimit) return entry.proc.rateLimit;
    }
    return null;
  }

  #reap(): void {
    for (const entry of [...this.#entries]) {
      if (entry.mutex.locked) {
        // A locked entry is skipped by eviction as well, so nothing else will
        // ever reclaim it — which makes a lock that is never released a
        // permanent leak of both the slot and the process behind it. No honest
        // turn can outlive its own timeout, so one that has is not busy, it is
        // wedged, and it gets dropped like anything else.
        if (entry.proc.idleMs > this.#cfg.sessions.turnTimeoutMs + WEDGE_MARGIN_MS) {
          log.warn("session held its lock past the turn timeout; dropping it", {
            sessionId: entry.proc.sessionId?.slice(0, 8),
            idleSeconds: Math.round(entry.proc.idleMs / 1000),
          });
          this.#drop(entry, "wedged");
        }
        continue;
      }
      const stale = !entry.proc.alive || entry.proc.idleMs > this.#cfg.sessions.idleMs;
      if (stale) this.#drop(entry, "idle");
    }
    // A burst can push the pool past `max`, because eviction gives up when every
    // session is mid-turn. Nothing used to bring it back down again except more
    // traffic, so a burst that ended quietly left its overshoot standing — 112
    // processes against a cap of 16, until the idle timeout got to them a
    // quarter of an hour later. The cap is checked here too, once they are idle.
    this.#trim(this.#cfg.sessions.max, "over capacity");
    void this.sweepOrphans();
  }

  #drop(entry: Entry, reason: string): void {
    this.#entries.delete(entry);
    this.#byChain.delete(entry.chainKey);
    if (entry.proc.sessionId) this.#bySessionId.delete(entry.proc.sessionId);
    // Held back from the orphan sweep only for as long as an honest disposal
    // takes; past that the sweep is welcome to it, because a disposal that has
    // not landed by then is itself the leak.
    const pid = entry.proc.pid;
    if (pid !== null) this.#disposing.set(pid, Date.now() + DISPOSAL_GRACE_MS);
    entry.proc.dispose();
    log.debug("session dropped", { reason, sessionId: entry.proc.sessionId?.slice(0, 8) });
    telemetry.emit("session", {
      action: "drop",
      reason,
      sessionId: entry.proc.sessionId,
      mode: entry.proc.cls.mode,
      model: entry.proc.cls.model,
      turns: entry.proc.turns,
      costUsd: entry.proc.totalCostUsd,
    });
  }

  /** Terminate one session by id. Returns false if it was not found. */
  kill(sessionId: string): boolean {
    const entry = this.#bySessionId.get(sessionId);
    if (!entry) return false;
    this.#drop(entry, "killed");
    return true;
  }

  /** Drop least-recently-used idle sessions until at most `limit` remain. */
  #trim(limit: number, reason: string): void {
    while (this.#entries.size > limit) {
      const idle = [...this.#entries]
        .filter((e) => !e.mutex.locked)
        .sort((a, b) => a.proc.lastUsedAt - b.proc.lastUsedAt);
      const victim = idle[0];
      if (!victim) return; // everything is busy; let the new session push us over
      this.#drop(victim, reason);
    }
  }

  #evictIfNeeded(): void {
    // One below the cap, so the session about to be created fits inside it.
    this.#trim(this.#cfg.sessions.max - 1, "evicted");
  }

  /** Find the longest already-consumed prefix of this conversation. */
  #match(req: SocketRequest): { entry: Entry; consumed: number; matchedKey: string } | null {
    if (!this.#cfg.sessions.reuse) return null;

    if (req.pinnedSession) {
      const entry = this.#bySessionId.get(req.pinnedSession);
      if (entry?.proc.alive) {
        return { entry, consumed: -1, matchedKey: entry.chainKey };
      }
      return null;
    }

    const hashes = userChain(req.cls, req.messages);
    // Never match the full conversation: the final user message is the one this
    // request is asking us to answer, so it must still be unconsumed.
    for (let i = hashes.length - 2; i >= 0; i--) {
      const key = hashes[i]!;
      const entry = this.#byChain.get(key);
      if (entry?.proc.alive && entry.chainKey === key) {
        return { entry, consumed: i + 1, matchedKey: key };
      }
    }
    return null;
  }

  /**
   * Start a CLI process. Deliberately does not wait for it to report a session
   * id: the CLI only does that once it has been given a message, so the id is
   * collected after the first turn has been sent.
   */
  #create(req: SocketRequest): Entry {
    this.#evictIfNeeded();
    if (isAgentic(req.cls.mode)) mkdirSync(req.cls.cwd, { recursive: true });

    const proc = new ClaudeProcess(this.#cfg, req.cls);
    const entry: Entry = { proc, mutex: new Mutex(), chainKey: classKey(req.cls) };
    this.#entries.add(entry);

    const pid = proc.pid;
    if (pid !== null) {
      // On disk before the process can matter, so a bridge that dies without
      // running its shutdown path still leaves the next one enough to find it.
      this.#registry.add(pid, proc.spawnedAt);
      void proc.whenGone.then(() => {
        this.#registry.remove(pid);
        this.#disposing.delete(pid);
      });
    }
    return entry;
  }

  /**
   * Run one turn for a request, reusing a live CLI process whenever the
   * conversation is an extension of one we already hold.
   */
  async *run(req: SocketRequest, signal?: AbortSignal): AsyncGenerator<TurnEvent> {
    const match = this.#match(req);
    let entry: Entry;
    let content: ContentBlock[];
    let reused = false;

    if (match) {
      entry = match.entry;
      reused = true;
    } else {
      try {
        entry = this.#create(req);
      } catch (err) {
        yield {
          kind: "error",
          status: 502,
          type: "upstream_error",
          message: err instanceof Error ? err.message : String(err),
        };
        return;
      }
    }

    const release = await entry.mutex.acquire();
    try {
      // Re-check after the wait: a concurrent turn may have advanced this
      // process past the prefix we matched, which would corrupt its context.
      if (reused && (this.#byChain.get(match!.matchedKey) !== entry || !entry.proc.alive)) {
        release();
        log.debug("prefix match invalidated by a concurrent turn; starting a new session");
        yield* this.run({ ...req, pinnedSession: null }, signal);
        return;
      }

      if (reused && match!.consumed >= 0) {
        const tail = req.messages.filter((m) => m.role === "user").slice(match!.consumed);
        if (tail.length === 0) {
          release();
          yield {
            kind: "error",
            status: 400,
            type: "invalid_request_error",
            message: "no new user message to answer",
          };
          return;
        }
        content = renderTail(tail);
      } else if (reused) {
        // Pinned session: only the final user message is new by definition.
        const users = req.messages.filter((m) => m.role === "user");
        const lastUser = users[users.length - 1];
        if (!lastUser) {
          release();
          yield {
            kind: "error",
            status: 400,
            type: "invalid_request_error",
            message: "no user message in request",
          };
          return;
        }
        content = lastUser.content;
      } else {
        content = renderSeed(req.messages);
      }

      const proc = entry.proc;
      const onAbort = () => void proc.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      let completed = false;
      try {
        // Sends the message straight away. A new process only announces its
        // session id once it has input, so the id is collected right after.
        const turn = proc.runTurn(content);
        if (!proc.sessionId) {
          await proc.ready();
          if (proc.sessionId) {
            this.#bySessionId.set(proc.sessionId, entry);
            telemetry.emit("session", {
              action: "create",
              sessionId: proc.sessionId,
              mode: proc.cls.mode,
              model: proc.cls.model,
              cwd: proc.cls.cwd,
            });
          }
        }
        yield { kind: "session", sessionId: proc.sessionId ?? "", model: proc.cls.model, reused };

        for await (const event of turn) {
          if (event.kind === "done") completed = true;
          if (event.kind === "tool_use") {
            telemetry.emit("tool", {
              sessionId: proc.sessionId,
              name: event.name,
              summary: formatToolUse(event.name, event.input).trim(),
            });
          }
          yield event;
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }

      if (completed) {
        // Advance this process's position in the conversation. A process holds
        // exactly one chain key, so the old one must go: reusing it would append
        // to a context that has already moved on.
        const hashes = userChain(req.cls, req.messages);
        const nextKey = hashes[hashes.length - 1] ?? entry.chainKey;
        this.#byChain.delete(entry.chainKey);
        entry.chainKey = nextKey;
        this.#byChain.set(nextKey, entry);
      } else if (!proc.alive) {
        this.#drop(entry, "process died");
      }
    } finally {
      release();
    }
  }

  shutdown(): void {
    this.#closed = true;
    clearInterval(this.#reaper);
    const pids = [...this.#entries]
      .map((e) => e.proc.pid)
      .filter((p): p is number => p !== null);
    for (const entry of [...this.#entries]) this.#drop(entry, "shutdown");
    // Every timer disposal relies on is unref'd, so the bridge may well be gone
    // before any of them fires — which is how a restart inside the kill window
    // used to strand a process for good. This is the one stop that does not
    // depend on the event loop still being here to run it. It costs the CLI its
    // graceful flush; a leaked process costs a gigabyte.
    killTreeSync(pids);
    this.#registry.clear();
  }
}
