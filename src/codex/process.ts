import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../core/config.ts";
import { buildCodexPlan, seedPrompt } from "./args.ts";
import { codexHome } from "./home.ts";
import { findRollout, fileSize, readSteps } from "./rollout.ts";
import { isRunning, killTree } from "../agent/reaper.ts";
import { EventQueue, single } from "../agent/queue.ts";
import { isRecord, num, spawnCli, takeLines } from "../agent/spawn.ts";
import { log } from "../util/log.ts";
import { summarizeToolInput } from "../core/activity.ts";
import {
  emptyUsage,
  type AgentProcess,
  type ContentBlock,
  type RateLimitInfo,
  type SessionClass,
  type SpawnListener,
  type TurnEvent,
  type Usage,
} from "../core/types.ts";
import { addUsage, type Step } from "../core/usage.ts";

/** How long a killed child gets to disappear before the next escalation. */
const VERIFY_MS = 2000;

/** Item types that are the agent doing something rather than saying something. */
const TOOL_ITEMS = new Set([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "collab_tool_call",
  "web_search",
  "todo_list",
]);

/**
 * One `codex` conversation.
 *
 * The shape of this class is dictated by a single fact: `codex exec` is not a
 * server. It runs one turn and exits, and the way to continue a conversation is
 * `codex exec resume <thread>`, which starts a new process against the same
 * thread. So unlike {@link ClaudeProcess} — which holds one child open for the
 * life of the session and feeds it turns over stdin — this holds a *thread id*
 * and spawns a child per turn.
 *
 * What the pool sees is the same either way. `alive` means the conversation can
 * still take another turn, not that a process exists this instant; between
 * turns there is deliberately no child and `pid` is null. Session reuse is
 * unaffected, and so is the promise that matters to a client: it sends only the
 * new message, never the transcript.
 *
 * The streaming is coarser, and honestly so. `codex exec --json` publishes
 * whole items — a finished message, a finished command — with no token deltas
 * anywhere in its vocabulary, so a reply arrives as one delta rather than
 * many. Nothing is synthesized to hide that; a client that reassembles the
 * deltas still gets exactly the text a non-streamed turn returns.
 */
export class CodexProcess implements AgentProcess {
  readonly key: string;
  readonly cls: SessionClass;
  sessionId: string | null = null;
  lastUsedAt = Date.now();
  turns = 0;
  totalCostUsd = 0;
  /** Codex reports no rate-limit frames on this transport. */
  rateLimit: RateLimitInfo | null = null;
  alive = true;
  readonly spawnedAt = Date.now();
  readonly whenGone: Promise<void>;

  #cfg: Config;
  #onSpawn: SpawnListener | undefined;
  #child: ChildProcessWithoutNullStreams | null = null;
  #stdoutBuf = "";
  #stderrRing = "";
  #queue: EventQueue | null = null;
  #scratchDirs: string[] = [];
  #disposed = false;
  #goneResolve!: () => void;
  #readyResolve: (() => void) | null = null;
  #ready: Promise<void>;

  /** Located once the thread has an id; the source of per-call accounting. */
  #rolloutPath: string | null = null;
  /** Bytes of the transcript already accounted for by previous turns. */
  #rolloutMark = 0;

  #turnState = {
    text: "",
    thinking: "",
    /** Whether any text has streamed, which decides the next separator. */
    textSeen: false,
    usage: emptyUsage(),
    /** Tool calls seen on the wire, as a fallback when the transcript is not readable. */
    tools: [] as Array<{ id: string; name: string; summary: string }>,
    failure: null as { status: number; type: string; message: string } | null,
  };

  constructor(cfg: Config, cls: SessionClass, onSpawn?: SpawnListener) {
    this.#cfg = cfg;
    this.cls = cls;
    this.#onSpawn = onSpawn;
    this.key = randomUUID();
    this.whenGone = new Promise<void>((resolve) => {
      this.#goneResolve = resolve;
    });
    this.#ready = new Promise<void>((resolve) => {
      this.#readyResolve = resolve;
    });
  }

  ready(timeoutMs = 60_000): Promise<void> {
    let timer: NodeJS.Timeout;
    const expiry = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    return Promise.race([this.#ready, expiry]).finally(() => clearTimeout(timer));
  }

  get idleMs(): number {
    return Date.now() - this.lastUsedAt;
  }

  /** The pid of the turn in flight, or null between turns. */
  get pid(): number | null {
    return this.#child?.pid ?? null;
  }

  pids(): number[] {
    const pid = this.pid;
    return pid === null ? [] : [pid];
  }

  #failTurn(status: number, type: string, message: string): void {
    const q = this.#queue;
    if (!q || q.closed) return;
    q.push({ kind: "error", status, type, message });
    q.close();
    this.#queue = null;
  }

  /**
   * Send one message and stream the resulting turn.
   *
   * Not an async generator, for the same reason the Claude driver is not: the
   * child has to be spawned and fed immediately rather than on the first pull,
   * because `ready()` waits on the thread id the child announces.
   */
  runTurn(content: ContentBlock[]): AsyncGenerator<TurnEvent> {
    if (!this.alive) {
      return single({
        kind: "error",
        status: 502,
        type: "upstream_error",
        message: "codex session has been disposed",
      });
    }

    this.lastUsedAt = Date.now();
    this.#turnState = {
      text: "",
      thinking: "",
      textSeen: false,
      usage: emptyUsage(),
      tools: [],
      failure: null,
    };
    const queue = new EventQueue();
    this.#queue = queue;
    this.#stdoutBuf = "";
    this.#stderrRing = "";

    // Take the watermark before the turn runs, so only what this turn appends
    // is read back as its own. On the opening turn there is no thread and so no
    // transcript, and a mark of zero is the right answer.
    const path = this.#resolveRollout();
    this.#rolloutMark = path ? fileSize(path) : 0;

    try {
      this.#spawn(content);
    } catch (err) {
      this.#queue = null;
      return single({
        kind: "error",
        status: 502,
        type: "upstream_error",
        message: `failed to launch ${this.#cfg.codex.binary}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }

    const timeout = setTimeout(() => {
      this.#failTurn(504, "timeout", `turn exceeded ${this.#cfg.sessions.turnTimeoutMs}ms`);
      void this.abort();
    }, this.#cfg.sessions.turnTimeoutMs);

    return this.#consume(queue, timeout);
  }

  /** Build the command for this turn, start it, and write the prompt to stdin. */
  #spawn(content: ContentBlock[]): void {
    const first = this.sessionId === null;
    const scratchDir = mkdtempSync(join(tmpdir(), "claude-socket-codex-"));
    this.#scratchDirs.push(scratchDir);

    // Images have to be files on disk before the command that names them can be
    // built, so they are decoded into the scratch dir the turn already owns and
    // removed with it.
    const imagePaths: string[] = [];
    const texts: string[] = [];
    let index = 0;
    for (const block of content) {
      if (block.type === "text") {
        texts.push(block.text);
        continue;
      }
      const path = this.#writeImage(scratchDir, index++, block);
      if (path) imagePaths.push(path);
    }

    const plan = buildCodexPlan(this.#cfg, this.cls, {
      scratchDir,
      threadId: this.sessionId ?? undefined,
      imagePaths,
    });

    const body = texts.join("\n\n");
    const prompt = first ? seedPrompt(this.cls.systemPrompt, body) : body;

    log.debug("spawning codex", {
      key: this.key.slice(0, 8),
      mode: this.cls.mode,
      model: this.cls.model,
      resume: this.sessionId ?? undefined,
    });

    const child = spawnCli(
      this.#cfg.codex.binary,
      plan.args,
      plan.cwd,
      plan.env,
      plan.unsetEnv,
    );
    this.#child = child;
    if (child.pid !== undefined) this.#onSpawn?.(child.pid, Date.now());

    // Every handler is gated on this child still being the current one. A turn
    // that timed out fails its own queue and *then* kills the child, so the
    // mutex can be released and the next turn started while the old process is
    // still dying — and its parting output would otherwise be parsed into the
    // new turn's state and its exit would end the new turn.
    const current = () => this.#child === child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (current()) this.#onStdout(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (current()) this.#stderrRing = (this.#stderrRing + chunk).slice(-4000);
    });
    child.on("error", (err: Error) => {
      if (!current()) return;
      this.#child = null;
      this.#failTurn(
        502,
        "upstream_error",
        `failed to launch ${this.#cfg.codex.binary}: ${err.message}`,
      );
      this.#readyResolve?.();
    });
    child.on("exit", (code, signal) => {
      if (!current()) {
        this.#goneIfDisposed();
        return;
      }
      this.#child = null;
      this.#onExit(code, signal);
      this.#readyResolve?.();
    });

    try {
      child.stdin.end(prompt);
    } catch (err) {
      this.#failTurn(
        502,
        "upstream_error",
        `stdin write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  #writeImage(dir: string, index: number, block: ContentBlock): string | null {
    if (block.type !== "image") return null;
    const source = block.source;
    // A URL has nothing to write and `--image` takes no URLs, so it is dropped
    // rather than silently turned into a broken path.
    if (source.type !== "base64") {
      log.debug("dropping image: codex takes files, not URLs", { key: this.key.slice(0, 8) });
      return null;
    }
    const ext = (source.media_type.split("/")[1] ?? "png").replace(/[^a-z0-9]/gi, "") || "png";
    const path = join(dir, `image-${index}.${ext}`);
    try {
      writeFileSync(path, Buffer.from(source.data, "base64"));
      return path;
    } catch (err) {
      log.debug("could not write image for codex", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  #onStdout(chunk: string): void {
    const { lines, rest } = takeLines(this.#stdoutBuf + chunk);
    this.#stdoutBuf = rest;
    for (const line of lines) {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        log.debug("unparsable CLI line", { line: line.slice(0, 200) });
        continue;
      }
      if (isRecord(msg)) this.#handle(msg);
    }
  }

  #handle(msg: Record<string, unknown>): void {
    switch (msg["type"]) {
      case "thread.started": {
        const id = typeof msg["thread_id"] === "string" ? msg["thread_id"] : null;
        if (id) this.sessionId = id;
        this.#readyResolve?.();
        this.#readyResolve = null;
        return;
      }
      case "item.started":
      case "item.completed":
        this.#handleItem(msg["type"] === "item.completed", msg["item"]);
        return;
      case "turn.completed":
        this.#turnState.usage = toUsage(msg["usage"]);
        return;
      case "turn.failed":
        this.#turnState.failure = describeFailure(msg["error"]);
        return;
      case "error":
        // A stream-level error is not always fatal on its own — `turn.failed`
        // normally follows — so it is remembered rather than pushed, and the
        // exit handler decides whether the turn survived it.
        this.#turnState.failure ??= describeFailure(msg);
        return;
      default:
        return;
    }
  }

  #handleItem(completed: boolean, raw: unknown): void {
    const q = this.#queue;
    if (!q || !isRecord(raw)) return;
    const type = String(raw["type"] ?? "");
    const state = this.#turnState;

    if (type === "agent_message") {
      if (!completed) return;
      const text = typeof raw["text"] === "string" ? raw["text"] : "";
      if (!text) return;
      q.push({ kind: "block_start", blockType: "text" });
      // The accumulator joins messages with a blank line and the wire carries no
      // separator of its own, so it is synthesized here for the same reason the
      // Claude driver does it: a client reassembling deltas must land on the
      // exact string a non-streamed turn returns.
      if (state.textSeen) q.push({ kind: "delta", blockType: "text", text: "\n\n" });
      q.push({ kind: "delta", blockType: "text", text });
      q.push({ kind: "block_stop", blockType: "text" });
      state.text += (state.text ? "\n\n" : "") + text;
      state.textSeen = true;
      return;
    }

    if (type === "reasoning") {
      if (!completed) return;
      const text = typeof raw["text"] === "string" ? raw["text"] : "";
      if (!text) return;
      q.push({ kind: "block_start", blockType: "thinking" });
      q.push({ kind: "delta", blockType: "thinking", text });
      q.push({ kind: "block_stop", blockType: "thinking" });
      state.thinking += (state.thinking ? "\n\n" : "") + text;
      return;
    }

    if (type === "error") {
      // An `error` item is a warning in the transcript, not a failed turn — a
      // model-metadata miss, say. It reaches the client as a failed tool result
      // rather than ending anything.
      const message = typeof raw["message"] === "string" ? raw["message"] : "";
      if (completed && message) {
        q.push({ kind: "tool_result", name: "codex", isError: true, preview: message.slice(0, 400) });
      }
      return;
    }

    if (!TOOL_ITEMS.has(type)) return;

    const name = toolName(type, raw);
    if (!completed) {
      const input = toolInput(raw);
      state.tools.push({
        id: String(raw["id"] ?? ""),
        name,
        summary: summarizeToolInput(input),
      });
      q.push({ kind: "tool_use", name, input });
      return;
    }

    const failed =
      raw["status"] === "failed" || (raw["exit_code"] !== undefined && num(raw["exit_code"]) !== 0);
    q.push({
      kind: "tool_result",
      name,
      isError: failed,
      preview: String(raw["aggregated_output"] ?? raw["output"] ?? raw["result"] ?? "").slice(0, 400),
    });
  }

  /**
   * Finish the turn once the child is gone.
   *
   * The transcript is read here rather than at `turn.completed` on purpose: the
   * CLI is still appending to it when that event goes out, and the last model
   * call's usage record is one of the things still in flight. Waiting for exit
   * costs a few milliseconds and is the difference between accounting for every
   * call and losing the final one.
   */
  #onExit(code: number | null, signal: string | null): void {
    const q = this.#queue;
    this.#goneIfDisposed();
    if (!q || q.closed) return;

    const state = this.#turnState;
    if (state.failure) {
      this.turns += 1;
      q.push({ kind: "error", ...state.failure });
      q.close();
      this.#queue = null;
      return;
    }

    // A non-zero exit with nothing said is the CLI failing to run at all.
    if (code !== 0 && !state.text) {
      this.turns += 1;
      const detail = this.#stderrRing.trim().slice(-500);
      q.push({
        kind: "error",
        status: 502,
        type: "upstream_error",
        message:
          `codex exited (code ${code}${signal ? `, signal ${signal}` : ""})` +
          (detail ? `: ${detail}` : ""),
      });
      q.close();
      this.#queue = null;
      return;
    }

    const steps = this.#collectSteps();
    for (const step of steps) q.push({ kind: "step", step });

    this.turns += 1;
    q.push({
      kind: "done",
      usage: this.#turnUsage(steps),
      stopReason: "end_turn",
      text: state.text,
      thinking: state.thinking,
      steps,
    });
    q.close();
    this.#queue = null;
  }

  /**
   * The path to this thread's transcript, found once and remembered.
   *
   * Deliberately lazy rather than resolved when the thread id arrives: the CLI
   * announces the thread on stdout and creates the file on disk at very nearly
   * the same moment, and looking too early finds nothing and caches the miss
   * for the life of the session.
   */
  #resolveRollout(): string | null {
    if (!this.#cfg.codex.readRollout || this.sessionId === null) return null;
    this.#rolloutPath ??= findRollout(codexHome(this.#cfg), this.sessionId);
    return this.#rolloutPath;
  }

  /**
   * The turn's per-call breakdown, from the transcript where it is readable.
   *
   * When it is not — an unwritable sessions directory, a format that has moved
   * on — the turn still has its aggregate from `turn.completed`, so it degrades
   * to a single step carrying the tools seen on the wire. That is coarser than
   * the Claude side but never wrong: no tokens are invented and none go
   * missing.
   */
  #collectSteps(): Step[] {
    const path = this.#resolveRollout();
    if (path) {
      const { steps, endByte } = readSteps(path, this.#rolloutMark, this.cls.model);
      this.#rolloutMark = endByte;
      if (steps.length > 0) return steps;
      log.debug("codex rollout yielded no per-call usage; falling back to the turn total", { path });
    }

    const usage = this.#turnState.usage;
    const empty =
      usage.inputTokens === 0 &&
      usage.outputTokens === 0 &&
      usage.cacheReadTokens === 0 &&
      usage.cacheCreationTokens === 0;
    if (empty) return [];

    return [
      {
        messageId: `${this.sessionId ?? this.key}:${this.turns + 1}`,
        index: 1,
        model: this.cls.model,
        usage,
        tools: this.#turnState.tools.map((t) => ({ ...t })),
        at: Date.now(),
      },
    ];
  }

  /**
   * Usage for the whole turn.
   *
   * `turn.completed` is the CLI's own accounting and wins when it has numbers.
   * The steps are summed only when it does not, which is the same precedence
   * the Claude driver applies to its `result` message.
   */
  #turnUsage(steps: Step[]): Usage {
    const reported = this.#turnState.usage;
    const empty =
      reported.inputTokens === 0 &&
      reported.outputTokens === 0 &&
      reported.cacheReadTokens === 0 &&
      reported.cacheCreationTokens === 0;
    if (!empty) return reported;

    const total = emptyUsage();
    for (const step of steps) addUsage(total, step.usage);
    return total;
  }

  async *#consume(queue: EventQueue, timeout: NodeJS.Timeout): AsyncGenerator<TurnEvent> {
    try {
      for await (const event of queue.drain()) {
        yield event;
      }
    } finally {
      clearTimeout(timeout);
      this.lastUsedAt = Date.now();
      if (this.#queue === queue) this.#queue = null;
    }
  }

  /**
   * Stop an in-flight turn.
   *
   * There is no interrupt to ask for here — `codex exec` takes no control
   * channel on stdin — so the child is killed outright. The thread survives it:
   * the conversation lives in the transcript, not in the process, so the next
   * turn can still resume it.
   */
  async abort(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    await this.#terminate(child);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.alive = false;
    this.#failTurn(499, "aborted", "session disposed");
    const child = this.#child;
    if (child) void this.#terminate(child);
    else this.#goneResolve();
    for (const dir of this.#scratchDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    this.#scratchDirs = [];
  }

  /** Resolve `whenGone` once a disposed session has no child left running. */
  #goneIfDisposed(): void {
    if (this.#disposed && this.#child === null) this.#goneResolve();
  }

  /**
   * Take a child down, checking that it actually went.
   *
   * Same escalation as the Claude driver, and for the same reason: `kill()` on
   * Windows reaches only the process we hold a handle to, and `codex` runs
   * shells and MCP servers of its own underneath it.
   */
  async #terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
    const pid = child.pid;
    if (pid === undefined) {
      this.#goneIfDisposed();
      return;
    }
    const key = this.key.slice(0, 8);

    try {
      child.kill("SIGKILL");
    } catch (err) {
      log.debug("SIGKILL threw", { key, error: err instanceof Error ? err.message : String(err) });
    }
    if (await exited(child, pid, VERIFY_MS)) {
      this.#goneIfDisposed();
      return;
    }

    log.warn("codex survived SIGKILL; escalating to a tree kill", { key, pid });
    try {
      await killTree(pid);
    } catch (err) {
      log.debug("tree kill reported an error", {
        key,
        pid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!(await exited(child, pid, VERIFY_MS)) && isRunning(pid)) {
      log.error("codex process could not be killed; it is leaking", { key, pid });
      return;
    }
    this.#goneIfDisposed();
  }
}

/** Whether a child is gone within `ms`, resolving the moment it is. */
function exited(
  child: ChildProcessWithoutNullStreams,
  pid: number,
  ms: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      // The `exit` event is the truth when Node sees it, but a process it never
      // reaped can still be gone from the OS.
      resolve(child.exitCode !== null || !isRunning(pid));
    }, ms);
    timer.unref?.();
    child.once("exit", onExit);
  });
}

/**
 * Normalize one Codex usage block.
 *
 * See the note in `rollout.ts`: Codex counts cached and cache-written tokens
 * inside `input_tokens`, and the socket's vocabulary keeps them apart.
 */
function toUsage(raw: unknown): Usage {
  if (!isRecord(raw)) return emptyUsage();
  const cacheRead = num(raw["cached_input_tokens"]);
  const cacheWrite = num(raw["cache_write_input_tokens"]);
  return {
    inputTokens: Math.max(0, num(raw["input_tokens"]) - cacheRead - cacheWrite),
    outputTokens: num(raw["output_tokens"]),
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheWrite,
    costUsd: 0,
  };
}

/**
 * Recover a status and a type from a Codex failure.
 *
 * The CLI passes the upstream error through as a JSON *string*, so a 400 from
 * the API arrives looking like prose. Unwrapping it means a client gets the
 * status the API actually returned instead of a blanket 502.
 */
function describeFailure(raw: unknown): { status: number; type: string; message: string } {
  const message = isRecord(raw)
    ? String(raw["message"] ?? raw["error"] ?? "codex turn failed")
    : String(raw ?? "codex turn failed");

  try {
    const inner: unknown = JSON.parse(message);
    if (isRecord(inner)) {
      const err = isRecord(inner["error"]) ? inner["error"] : inner;
      const status = num(inner["status"]) || num(err["status"]);
      return {
        status: status >= 400 && status < 600 ? status : 502,
        type: typeof err["type"] === "string" ? err["type"] : "upstream_error",
        message: String(err["message"] ?? message),
      };
    }
  } catch {
    /* not a wrapped API error; use it as it came */
  }
  return { status: 502, type: "upstream_error", message };
}

/** A display name for a tool item, preferring whatever the item names itself. */
function toolName(type: string, raw: Record<string, unknown>): string {
  if (typeof raw["tool"] === "string" && raw["tool"]) return raw["tool"];
  if (typeof raw["server"] === "string" && typeof raw["tool_name"] === "string") {
    return `${raw["server"]}.${raw["tool_name"]}`;
  }
  return type;
}

/** The argument worth showing for a tool item. */
function toolInput(raw: Record<string, unknown>): unknown {
  for (const key of ["command", "query", "path", "arguments", "changes", "items"]) {
    const value = raw[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return raw;
}
