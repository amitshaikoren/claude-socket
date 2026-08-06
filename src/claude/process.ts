import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Config } from "../core/config.ts";
import { buildSpawnPlan, type SpawnPlan } from "./args.ts";
import { log } from "../util/log.ts";
import {
  type ContentBlock,
  type RateLimitInfo,
  type SessionClass,
  type TurnEvent,
  type Usage,
} from "../core/types.ts";

/** Async queue that turns pushed events into an async iterable. */
class EventQueue {
  #items: TurnEvent[] = [];
  #waiter: ((v: IteratorResult<TurnEvent>) => void) | null = null;
  #closed = false;

  push(event: TurnEvent): void {
    if (this.#closed) return;
    if (this.#waiter) {
      const w = this.#waiter;
      this.#waiter = null;
      w({ value: event, done: false });
    } else {
      this.#items.push(event);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#waiter) {
      const w = this.#waiter;
      this.#waiter = null;
      w({ value: undefined as unknown as TurnEvent, done: true });
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  async *drain(): AsyncGenerator<TurnEvent> {
    for (;;) {
      if (this.#items.length > 0) {
        yield this.#items.shift()!;
        continue;
      }
      if (this.#closed) return;
      const next = await new Promise<IteratorResult<TurnEvent>>((resolve) => {
        this.#waiter = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A one-event stream, for turns that fail before they can start. */
async function* single(event: TurnEvent): AsyncGenerator<TurnEvent> {
  yield event;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * On Windows a .cmd/.bat shim cannot be spawned directly (Node blocks it), so
 * route those through cmd.exe with verbatim arguments.
 */
function spawnCli(
  binary: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): ChildProcessWithoutNullStreams {
  const options = {
    cwd,
    env: { ...process.env, ...env },
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

/**
 * A single long-lived `claude` CLI process.
 *
 * The process stays alive across turns, which is the entire point: the CLI
 * keeps the conversation in its own context, so each follow-up turn sends only
 * the new message instead of replaying the transcript.
 */
export class ClaudeProcess {
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
  };
  #exitInfo: { code: number | null; signal: string | null } | null = null;
  #readyResolve: (() => void) | null = null;
  #ready: Promise<void>;
  #pendingControl = new Map<string, () => void>();

  constructor(cfg: Config, cls: SessionClass, resumeSessionId?: string) {
    this.#cfg = cfg;
    this.cls = cls;
    this.key = randomUUID();
    this.#plan = buildSpawnPlan(cfg, cls, resumeSessionId);
    this.#ready = new Promise<void>((resolve) => {
      this.#readyResolve = resolve;
    });

    log.debug("spawning claude", { key: this.key.slice(0, 8), mode: cls.mode, model: cls.model });
    this.#child = spawnCli(cfg.claude.binary, this.#plan.args, this.#plan.cwd, this.#plan.env);

    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => this.#onStdout(chunk));
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderrRing = (this.#stderrRing + chunk).slice(-4000);
    });
    this.#child.on("error", (err: Error) => {
      this.alive = false;
      this.#failTurn(502, "upstream_error", `failed to launch ${cfg.claude.binary}: ${err.message}`);
      this.#readyResolve?.();
    });
    this.#child.on("exit", (code, signal) => {
      this.alive = false;
      this.#exitInfo = { code, signal };
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
      case "content_block_start": {
        const index = num(event["index"]);
        const block = isRecord(event["content_block"]) ? event["content_block"] : null;
        const blockType = block ? String(block["type"]) : "text";
        state.blocks.set(index, blockType);
        if (blockType === "text" || blockType === "thinking") {
          state.openBlock = blockType;
          q.push({ kind: "block_start", blockType });
        }
        break;
      }
      case "content_block_delta": {
        const delta = isRecord(event["delta"]) ? event["delta"] : null;
        if (!delta) break;
        if (delta["type"] === "text_delta" && typeof delta["text"] === "string") {
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

    // The completed message is authoritative for accumulated text; deltas are
    // only used for live streaming. This avoids reassembling partial chunks.
    for (const raw of message["content"]) {
      if (!isRecord(raw)) continue;
      if (raw["type"] === "text" && typeof raw["text"] === "string") {
        this.#turnState.text += (this.#turnState.text ? "\n\n" : "") + raw["text"];
      } else if (raw["type"] === "thinking" && typeof raw["thinking"] === "string") {
        this.#turnState.thinking += raw["thinking"];
      } else if (raw["type"] === "tool_use") {
        q.push({ kind: "tool_use", name: String(raw["name"] ?? "tool"), input: raw["input"] });
      }
    }
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
    const usage = this.#extractUsage(msg);
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
      });
    }
    q.close();
    this.#queue = null;
  }

  #extractUsage(msg: Record<string, unknown>): Usage {
    const usage = isRecord(msg["usage"]) ? msg["usage"] : {};
    return {
      inputTokens: num(usage["input_tokens"]),
      outputTokens: num(usage["output_tokens"]),
      cacheReadTokens: num(usage["cache_read_input_tokens"]),
      cacheCreationTokens: num(usage["cache_creation_input_tokens"]),
      costUsd: num(msg["total_cost_usd"]),
    };
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
    this.#turnState = { blocks: new Map(), text: "", thinking: "", openBlock: null };
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
    this.alive = false;
    this.#failTurn(499, "aborted", "session disposed");
    try {
      this.#child.stdin.end();
    } catch {
      /* already gone */
    }
    if (this.#exitInfo === null) {
      // Give the CLI a moment to flush and exit on its own before SIGKILL.
      const child = this.#child;
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 1500);
      timer.unref?.();
      child.once("exit", () => clearTimeout(timer));
    }
    try {
      rmSync(this.#plan.scratchDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
