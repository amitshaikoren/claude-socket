import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Config } from "../core/config.ts";
import { buildSpawnPlan, type SpawnPlan } from "./args.ts";
import { isRunning, killTree } from "../agent/reaper.ts";
import { EventQueue, single } from "../agent/queue.ts";
import { isRecord, num, spawnCli } from "../agent/spawn.ts";
import { log } from "../util/log.ts";
import {
  type AgentProcess,
  type ContentBlock,
  type RateLimitInfo,
  type SessionClass,
  type SpawnListener,
  type TurnEvent,
  type Usage,
} from "../core/types.ts";
import { rollUp, type Step, type StepTool } from "../core/usage.ts";
import { summarizeToolInput } from "../core/activity.ts";

/** A `tool_use` block, before its arguments are dropped for storage. */
interface RequestedTool extends StepTool {
  input: unknown;
}

/** Persisted form: the arguments are not kept, only a one-line summary. */
function toStepTool(tool: RequestedTool): StepTool {
  return { id: tool.id, name: tool.name, summary: tool.summary };
}

/** How long the CLI gets to flush and exit on its own after stdin closes. */
const GRACE_MS = 1500;
/** How long each escalation gets to take effect before the next one. */
const VERIFY_MS = 2000;

/**
 * A single long-lived `claude` CLI process.
 *
 * The process stays alive across turns, which is the entire point: the CLI
 * keeps the conversation in its own context, so each follow-up turn sends only
 * the new message instead of replaying the transcript.
 */
export class ClaudeProcess implements AgentProcess {
  readonly key: string;
  readonly cls: SessionClass;
  sessionId: string | null = null;
  lastUsedAt = Date.now();
  turns = 0;
  totalCostUsd = 0;
  rateLimit: RateLimitInfo | null = null;
  alive = true;

  #cfg: Config;
  #plan: SpawnPlan;
  #child: ChildProcessWithoutNullStreams;
  #stdoutBuf = "";
  #stderrRing = "";
  #queue: EventQueue | null = null;
  #turnState = {
    blocks: new Map<number, string>(),
    text: "",
    thinking: "",
    openBlock: null as string | null,
    /** One entry per billed model call, keyed by message id to survive restates. */
    steps: new Map<string, Step>(),
    /** Message currently streaming, so its message_delta can be attributed. */
    streamingId: null as string | null,
    /** Final output counts from message_delta, which may arrive either side of
     *  the `assistant` record that creates the step. */
    finalOutput: new Map<string, number>(),
    /** Whether any text has streamed this turn, which is what decides whether
     *  the next text block needs a separator ahead of it. See `#textSeparator`. */
    textSeen: false,
  };
  #exitInfo: { code: number | null; signal: string | null } | null = null;
  #readyResolve: (() => void) | null = null;
  #ready: Promise<void>;
  #pendingControl = new Map<string, () => void>();
  #disposed = false;
  #goneResolve!: () => void;
  /**
   * Resolves once the OS process is confirmed gone — not merely once a kill has
   * been asked for. The pool waits on this to know when it may stop tracking
   * the pid.
   */
  readonly whenGone: Promise<void>;
  /** Epoch ms at spawn, paired with the pid to identify it after a restart. */
  readonly spawnedAt = Date.now();

  constructor(cfg: Config, cls: SessionClass, onSpawn?: SpawnListener) {
    this.#cfg = cfg;
    this.cls = cls;
    this.key = randomUUID();
    this.whenGone = new Promise<void>((resolve) => {
      this.#goneResolve = resolve;
    });
    this.#plan = buildSpawnPlan(cfg, cls);
    this.#ready = new Promise<void>((resolve) => {
      this.#readyResolve = resolve;
    });

    log.debug("spawning claude", { key: this.key.slice(0, 8), mode: cls.mode, model: cls.model });
    this.#child = spawnCli(
      cfg.claude.binary,
      this.#plan.args,
      this.#plan.cwd,
      this.#plan.env,
      this.#plan.unsetEnv,
    );
    if (this.#child.pid !== undefined) onSpawn?.(this.#child.pid, this.spawnedAt);

    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => this.#onStdout(chunk));
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderrRing = (this.#stderrRing + chunk).slice(-4000);
    });
    this.#child.on("error", (err: Error) => {
      this.alive = false;
      // A spawn that never produced a process has nothing to clean up, and no
      // `exit` is coming to say so.
      if (this.#child.pid === undefined) this.#goneResolve();
      this.#failTurn(502, "upstream_error", `failed to launch ${cfg.claude.binary}: ${err.message}`);
      this.#readyResolve?.();
    });
    this.#child.on("exit", (code, signal) => {
      this.alive = false;
      this.#exitInfo = { code, signal };
      this.#goneResolve();
      log.debug("claude exited", { key: this.key.slice(0, 8), code, signal });
      this.#failTurn(
        502,
        "upstream_error",
        `claude exited (code ${code}${signal ? `, signal ${signal}` : ""})` +
          (this.#stderrRing.trim() ? `: ${this.#stderrRing.trim().slice(-500)}` : ""),
      );
      this.#readyResolve?.();
    });
  }

  /**
   * Resolves once the CLI has reported its session id, or the process died.
   *
   * Note the CLI emits its init message only after it receives input, so this
   * must never be awaited before a turn has been sent.
   */
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

  /** The OS pid, or null if the spawn never produced one. */
  get pid(): number | null {
    return this.#child.pid ?? null;
  }

  /** One process, for the whole life of the session. */
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

  #onStdout(chunk: string): void {
    this.#stdoutBuf += chunk;
    for (;;) {
      const nl = this.#stdoutBuf.indexOf("\n");
      if (nl < 0) break;
      const line = this.#stdoutBuf.slice(0, nl).trim();
      this.#stdoutBuf = this.#stdoutBuf.slice(nl + 1);
      if (!line) continue;
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
    const type = msg["type"];

    if (type === "system" && msg["subtype"] === "init") {
      this.sessionId = typeof msg["session_id"] === "string" ? msg["session_id"] : null;
      this.#readyResolve?.();
      this.#readyResolve = null;
      return;
    }

    if (type === "control_response") {
      const res = isRecord(msg["response"]) ? msg["response"] : null;
      const id = res && typeof res["request_id"] === "string" ? res["request_id"] : null;
      if (id) {
        this.#pendingControl.get(id)?.();
        this.#pendingControl.delete(id);
      }
      return;
    }

    if (type === "rate_limit_event" && isRecord(msg["rate_limit_info"])) {
      const info = msg["rate_limit_info"];
      this.rateLimit = {
        status: String(info["status"] ?? "unknown"),
        rateLimitType: info["rateLimitType"] ? String(info["rateLimitType"]) : undefined,
        resetsAt: typeof info["resetsAt"] === "number" ? info["resetsAt"] : undefined,
        isUsingOverage: info["isUsingOverage"] === true,
      };
      return;
    }

    // Subagent chatter is not part of the top-level conversation.
    if (msg["parent_tool_use_id"]) return;

    if (type === "stream_event") this.#handleStreamEvent(msg);
    else if (type === "assistant") this.#handleAssistant(msg);
    else if (type === "user") this.#handleToolResults(msg);
    else if (type === "result") this.#handleResult(msg);
  }

  #handleStreamEvent(msg: Record<string, unknown>): void {
    const q = this.#queue;
    if (!q) return;
    const event = isRecord(msg["event"]) ? msg["event"] : null;
    if (!event) return;
    const state = this.#turnState;

    switch (event["type"]) {
      // The `assistant` record carries the usage as it stood at message_start,
      // where output_tokens is a placeholder (1-2) rather than a count. The real
      // figure only lands in message_delta at the end of the message. Verified
      // against the CLI's own transcript: a message the wire reported as out=2
      // was actually 65. Missing this under-reports output by ~97%, and with it
      // every tool's attributed request cost.
      case "message_start": {
        const message = isRecord(event["message"]) ? event["message"] : null;
        state.streamingId = typeof message?.["id"] === "string" ? message["id"] : null;
        break;
      }
      case "message_delta": {
        const usage = isRecord(event["usage"]) ? event["usage"] : null;
        if (!usage || !state.streamingId) break;
        this.#applyFinalOutput(state.streamingId, num(usage["output_tokens"]));
        break;
      }
      case "content_block_start": {
        const index = num(event["index"]);
        const block = isRecord(event["content_block"]) ? event["content_block"] : null;
        const blockType = block ? String(block["type"]) : "text";
        state.blocks.set(index, blockType);
        if (blockType === "text" || blockType === "thinking") {
          state.openBlock = blockType;
          q.push({ kind: "block_start", blockType });
          // The accumulator joins text blocks with a blank line; the wire has no
          // separator of its own. Synthesizing it here is what lets a consumer
          // reassemble the deltas into the same string `#handleAssistant`
          // builds, without either dialect knowing the rule.
          if (blockType === "text" && state.textSeen) {
            q.push({ kind: "delta", blockType: "text", text: "\n\n" });
          }
        }
        break;
      }
      case "content_block_delta": {
        const delta = isRecord(event["delta"]) ? event["delta"] : null;
        if (!delta) break;
        if (delta["type"] === "text_delta" && typeof delta["text"] === "string") {
          // Empty blocks contribute nothing to `state.text` and so earn no
          // separator either — hence "text seen", not "block seen".
          if (delta["text"]) state.textSeen = true;
          q.push({ kind: "delta", blockType: "text", text: delta["text"] });
        } else if (delta["type"] === "thinking_delta" && typeof delta["thinking"] === "string") {
          q.push({ kind: "delta", blockType: "thinking", text: delta["thinking"] });
        }
        break;
      }
      case "content_block_stop": {
        const index = num(event["index"]);
        const blockType = state.blocks.get(index);
        if (blockType === "text" || blockType === "thinking") {
          q.push({ kind: "block_stop", blockType });
          state.openBlock = null;
        }
        state.blocks.delete(index);
        break;
      }
      default:
        break;
    }
  }

  #handleAssistant(msg: Record<string, unknown>): void {
    const q = this.#queue;
    const message = isRecord(msg["message"]) ? msg["message"] : null;
    if (!q || !message || !Array.isArray(message["content"])) return;

    const state = this.#turnState;
    const tools: RequestedTool[] = [];

    // The completed message is authoritative for accumulated text; deltas are
    // only used for live streaming. This avoids reassembling partial chunks.
    for (const raw of message["content"]) {
      if (!isRecord(raw)) continue;
      if (raw["type"] === "text" && typeof raw["text"] === "string") {
        // Changing this join changes what a streaming client reassembles: the
        // separator is mirrored onto the delta stream at content_block_start.
        state.text += (state.text ? "\n\n" : "") + raw["text"];
      } else if (raw["type"] === "thinking" && typeof raw["thinking"] === "string") {
        state.thinking += raw["thinking"];
      } else if (raw["type"] === "tool_use") {
        tools.push({
          id: typeof raw["id"] === "string" ? raw["id"] : "",
          name: String(raw["name"] ?? "tool"),
          summary: summarizeToolInput(raw["input"]),
          input: raw["input"],
        });
      }
    }

    // Only the calls this message actually contributes are announced, so a
    // restated message never replays its tools into the client's stream.
    for (const tool of this.#recordStep(msg, message, tools)) {
      q.push({ kind: "tool_use", name: tool.name, input: tool.input });
    }
  }

  /**
   * Attach a final output count to its model call.
   *
   * message_delta and the `assistant` record arrive in no guaranteed order, so
   * this both updates a step that already exists and remembers the figure for
   * one that does not yet.
   */
  #applyFinalOutput(messageId: string, outputTokens: number): void {
    if (outputTokens <= 0) return;
    const state = this.#turnState;
    state.finalOutput.set(messageId, outputTokens);
    const step = state.steps.get(messageId);
    if (step) step.usage.outputTokens = outputTokens;
  }

  /**
   * Record one billed model call, and return the tool calls that were new.
   *
   * Every assistant message is a separate API request, so its `usage` block is
   * the only place a per-call number exists — the CLI's final `result` reports
   * just the turn aggregate.
   *
   * The CLI restates a message rather often: measured over real transcripts,
   * 40% of assistant messages arrive twice under the same id, always with
   * identical usage. So the first usage reading is kept and later ones dropped —
   * summing them would double every figure downstream.
   *
   * Tools need more care than "keep the first", because a restate is not
   * redundant. In the same sample, 119 restates carried tool calls the first
   * sighting did not have (ignoring them would lose those calls) while 65
   * repeated ids the first sighting already had (appending them would inflate
   * every tool count). Deduping on the `tool_use` block id is right for both:
   * every block observed carried one.
   */
  #recordStep(
    msg: Record<string, unknown>,
    message: Record<string, unknown>,
    tools: RequestedTool[],
  ): RequestedTool[] {
    const state = this.#turnState;
    const id =
      (typeof message["id"] === "string" && message["id"]) ||
      (typeof msg["uuid"] === "string" && msg["uuid"]) ||
      `step_${state.steps.size + 1}`;

    const existing = state.steps.get(id);
    if (existing) {
      const known = new Set(existing.tools.map((t) => t.id).filter(Boolean));
      // A block with no id cannot be told apart from a repeat, so it is dropped
      // rather than risk inflating the count.
      const fresh = tools.filter((t) => t.id && !known.has(t.id));
      existing.tools.push(...fresh.map(toStepTool));
      return fresh;
    }

    const usage = isRecord(message["usage"]) ? message["usage"] : null;
    const step: Step = {
      messageId: id,
      index: state.steps.size + 1,
      model: typeof message["model"] === "string" ? message["model"] : this.cls.model,
      usage: {
        inputTokens: num(usage?.["input_tokens"]),
        // message_delta wins: the snapshot on this record is a placeholder.
        outputTokens: state.finalOutput.get(id) ?? num(usage?.["output_tokens"]),
        cacheReadTokens: num(usage?.["cache_read_input_tokens"]),
        cacheCreationTokens: num(usage?.["cache_creation_input_tokens"]),
        // Cost is only ever reported for the turn as a whole; apportioning it
        // per call would be a guess, so it stays zero here and is carried on
        // the turn's own usage.
        costUsd: 0,
      },
      tools: tools.map(toStepTool),
      at: Date.now(),
    };

    state.steps.set(id, step);
    this.#queue?.push({ kind: "step", step });
    return tools;
  }

  #handleToolResults(msg: Record<string, unknown>): void {
    const q = this.#queue;
    const message = isRecord(msg["message"]) ? msg["message"] : null;
    if (!q || !message || !Array.isArray(message["content"])) return;

    for (const raw of message["content"]) {
      if (!isRecord(raw) || raw["type"] !== "tool_result") continue;
      let preview = "";
      const content = raw["content"];
      if (typeof content === "string") {
        preview = content;
      } else if (Array.isArray(content)) {
        preview = content
          .filter((c): c is Record<string, unknown> => isRecord(c) && c["type"] === "text")
          .map((c) => String(c["text"] ?? ""))
          .join("\n");
      }
      q.push({
        kind: "tool_result",
        name: String(raw["name"] ?? ""),
        isError: raw["is_error"] === true,
        preview: preview.slice(0, 400),
      });
    }
  }

  #handleResult(msg: Record<string, unknown>): void {
    const q = this.#queue;
    if (!q) return;
    const steps = [...this.#turnState.steps.values()];
    const usage = this.#extractUsage(msg, steps);
    this.totalCostUsd += usage.costUsd;
    this.turns += 1;

    if (msg["is_error"] === true) {
      const detail =
        typeof msg["result"] === "string" && msg["result"]
          ? msg["result"]
          : String(msg["subtype"] ?? "error_during_execution");
      const status = msg["api_error_status"] ? num(msg["api_error_status"]) || 502 : 500;
      q.push({ kind: "error", status, type: "upstream_error", message: detail });
    } else {
      const state = this.#turnState;
      // `result.result` is the final assistant message; the accumulated text is a
      // superset that includes intermediate narration during a tool loop.
      const text = state.text || (typeof msg["result"] === "string" ? msg["result"] : "");
      q.push({
        kind: "done",
        usage,
        stopReason: String(msg["stop_reason"] ?? "end_turn"),
        text,
        thinking: state.thinking,
        steps,
      });
    }
    q.close();
    this.#queue = null;
  }

  /**
   * Usage for the whole turn.
   *
   * The CLI's `result.usage` is preferred when it carries real numbers, since it
   * is the CLI's own accounting. When it is absent or empty — older builds, and
   * error results — the per-call steps are summed instead, which reaches the
   * same total by a different road. Cost only ever comes from `total_cost_usd`;
   * it is never derived, because prices are not ours to assume.
   */
  #extractUsage(msg: Record<string, unknown>, steps: Step[]): Usage {
    const raw = isRecord(msg["usage"]) ? msg["usage"] : {};
    const costUsd = num(msg["total_cost_usd"]);
    const reported: Usage = {
      inputTokens: num(raw["input_tokens"]),
      outputTokens: num(raw["output_tokens"]),
      cacheReadTokens: num(raw["cache_read_input_tokens"]),
      cacheCreationTokens: num(raw["cache_creation_input_tokens"]),
      costUsd,
    };

    const empty =
      reported.inputTokens === 0 &&
      reported.outputTokens === 0 &&
      reported.cacheReadTokens === 0 &&
      reported.cacheCreationTokens === 0;

    if (empty && steps.length > 0) {
      const rolled = rollUp(steps, costUsd);
      return rolled.usage;
    }
    return reported;
  }

  /**
   * Send one user message and stream the resulting turn. The caller must
   * serialize calls; SessionManager holds a per-process mutex for that.
   *
   * This is deliberately not an async generator: the message must reach stdin
   * immediately, not on the first pull. The CLI withholds its init message
   * until it has input, so a lazy write would deadlock anyone waiting on
   * ready().
   */
  runTurn(content: ContentBlock[]): AsyncGenerator<TurnEvent> {
    if (!this.alive) {
      return single({
        kind: "error",
        status: 502,
        type: "upstream_error",
        message: "claude process is not running",
      });
    }

    this.lastUsedAt = Date.now();
    this.#turnState = {
      blocks: new Map(),
      text: "",
      thinking: "",
      openBlock: null,
      steps: new Map(),
      streamingId: null,
      finalOutput: new Map(),
      textSeen: false,
    };
    const queue = new EventQueue();
    this.#queue = queue;

    // A single text block goes over the wire as a plain string, which is the
    // shape the CLI is most commonly exercised with.
    const onlyText = content.length === 1 && content[0]!.type === "text";
    const payload = {
      type: "user",
      message: {
        role: "user",
        content: onlyText ? (content[0] as { text: string }).text : content,
      },
      parent_tool_use_id: null,
    };

    try {
      this.#child.stdin.write(JSON.stringify(payload) + "\n");
    } catch (err) {
      this.#queue = null;
      const message = err instanceof Error ? err.message : String(err);
      return single({
        kind: "error",
        status: 502,
        type: "upstream_error",
        message: `stdin write failed: ${message}`,
      });
    }

    const timeout = setTimeout(() => {
      this.#failTurn(504, "timeout", `turn exceeded ${this.#cfg.sessions.turnTimeoutMs}ms`);
      void this.abort();
    }, this.#cfg.sessions.turnTimeoutMs);

    return this.#consume(queue, timeout);
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
   * Stop an in-flight turn. Tries the SDK interrupt first so the session stays
   * reusable; falls back to killing the process, because a stuck turn burning
   * tokens is worse than a lost session.
   */
  async abort(): Promise<void> {
    if (!this.alive) return;
    const requestId = `req_${randomUUID()}`;
    const acknowledged = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.#pendingControl.delete(requestId);
        resolve(false);
      }, 2000);
      this.#pendingControl.set(requestId, () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

    try {
      this.#child.stdin.write(
        JSON.stringify({
          type: "control_request",
          request_id: requestId,
          request: { subtype: "interrupt" },
        }) + "\n",
      );
    } catch {
      this.dispose();
      return;
    }

    if (!(await acknowledged)) {
      log.debug("interrupt not acknowledged; killing process", { key: this.key.slice(0, 8) });
      this.dispose();
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.alive = false;
    this.#failTurn(499, "aborted", "session disposed");
    try {
      this.#child.stdin.end();
    } catch {
      /* already gone */
    }
    void this.#terminate();
    try {
      rmSync(this.#plan.scratchDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  /**
   * Take the process down, checking at every step that it actually went.
   *
   * The old version fired one SIGKILL on a timer inside a swallowed catch: if
   * the kill did not land there was no retry, no escalation, and no log line —
   * and the session had already left the pool, so nothing would ever look at it
   * again. Each stage here confirms the outcome before deciding the next, and
   * the last one is loud, because a process that survives a tree kill is a fact
   * somebody needs to see.
   */
  async #terminate(): Promise<void> {
    const pid = this.pid;
    const key = this.key.slice(0, 8);
    if (pid === null) {
      this.#goneResolve();
      return;
    }

    // Closing stdin is the polite exit, and the one the CLI normally takes.
    if (await this.#exited(GRACE_MS)) return;

    this.sigkill();
    if (await this.#exited(VERIFY_MS)) return;

    // Still there. Either the signal did not land, or the CLI has children of
    // its own holding the tree up — `child.kill()` on Windows only ever reaches
    // the process we hold a handle to.
    log.warn("claude survived SIGKILL; escalating to a tree kill", { key, pid });
    try {
      await killTree(pid);
    } catch (err) {
      log.debug("tree kill reported an error", {
        key,
        pid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (await this.#exited(VERIFY_MS)) return;

    if (isRunning(pid)) {
      log.error("claude process could not be killed; it is leaking", { key, pid });
    } else {
      // Gone, but Node never saw the exit — the pid is free either way.
      this.#goneResolve();
    }
  }

  /**
   * The first kill, on the handle Node holds.
   *
   * Separated out so a test can make it miss: the whole point of the stages
   * around it is that the escalation still happens when it does.
   */
  protected sigkill(): void {
    try {
      this.#child.kill("SIGKILL");
    } catch (err) {
      log.debug("SIGKILL threw", {
        key: this.key.slice(0, 8),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Whether the process is gone within `ms`, resolving the moment it is.
   *
   * Timers here are unref'd so a pending kill can never hold the bridge open at
   * exit; `SessionManager.shutdown` is what guarantees the kill still happens
   * if the bridge leaves inside one of these windows.
   */
  #exited(ms: number): Promise<boolean> {
    if (this.#exitInfo !== null) {
      this.#goneResolve();
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const onExit = () => {
        clearTimeout(timer);
        this.#goneResolve();
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.#child.removeListener("exit", onExit);
        // The `exit` event is the truth when Node sees it, but a process it
        // never reaped can still be gone from the OS.
        const gone = this.#exitInfo !== null || !isRunning(this.pid ?? -1);
        if (gone) this.#goneResolve();
        resolve(gone);
      }, ms);
      timer.unref?.();
      this.#child.once("exit", onExit);
    });
  }
}
