import { randomUUID } from "node:crypto";
import type { Ctx } from "../http/context.ts";
import { sendJson } from "../http/context.ts";
import { SseWriter } from "../http/sse.ts";
import { activityMode, resolveTarget, wantsAuthoritativeText } from "../core/resolve.ts";
import { formatToolResult, formatToolUse } from "../core/activity.ts";
import { recordTurn } from "../core/record.ts";
import { billed, peakContext, toolCalls, type Step } from "../core/usage.ts";
import {
  buildToolPrompt,
  extractToolCalls,
  parseAnthropicToolChoice,
  parseAnthropicTools,
  renderAssistantCalls,
  renderToolResult,
  ReplyStream,
  warnUnparsed,
  type ParsedCall,
} from "../core/tools.ts";
import {
  SocketError,
  emptyUsage,
  type BlockType,
  type SocketMessage,
  type ContentBlock,
  type Usage,
} from "../core/types.ts";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function contentBlocks(content: unknown): ContentBlock[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];

  const blocks: ContentBlock[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    switch (part["type"]) {
      case "text":
        if (typeof part["text"] === "string") blocks.push({ type: "text", text: part["text"] });
        break;
      case "image": {
        const source = part["source"];
        if (isRecord(source) && source["type"] === "base64") {
          blocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: String(source["media_type"] ?? "image/png"),
              data: String(source["data"] ?? ""),
            },
          });
        } else if (isRecord(source) && source["type"] === "url") {
          blocks.push({ type: "image", source: { type: "url", url: String(source["url"] ?? "") } });
        }
        break;
      }
      case "tool_use": {
        // A prior assistant turn: re-render it in the tagged form the model used.
        blocks.push({
          type: "text",
          text: renderAssistantCalls([
            {
              name: String(part["name"] ?? ""),
              argumentsJson: JSON.stringify(part["input"] ?? {}),
            },
          ]),
        });
        break;
      }
      case "tool_result": {
        const inner = part["content"];
        const text =
          typeof inner === "string"
            ? inner
            : Array.isArray(inner)
              ? inner
                  .filter((c): c is Record<string, unknown> => isRecord(c) && c["type"] === "text")
                  .map((c) => String(c["text"] ?? ""))
                  .join("\n")
              : "";
        blocks.push({
          type: "text",
          text: renderToolResult("", String(part["tool_use_id"] ?? ""), text),
        });
        break;
      }
      default:
        break;
    }
  }
  return blocks;
}

function systemText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter((b): b is Record<string, unknown> => isRecord(b) && b["type"] === "text")
    .map((b) => String(b["text"] ?? ""))
    .join("\n");
}

function normalize(raw: unknown): SocketMessage[] {
  if (!Array.isArray(raw)) {
    throw new SocketError(400, "invalid_request_error", "'messages' must be an array");
  }
  const messages: SocketMessage[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const blocks = contentBlocks(item["content"]);
    if (blocks.length === 0) continue;
    messages.push({ role: item["role"] === "assistant" ? "assistant" : "user", content: blocks });
  }
  if (messages.length === 0) {
    throw new SocketError(400, "invalid_request_error", "no usable messages in request");
  }
  if (messages[messages.length - 1]!.role !== "user") {
    throw new SocketError(400, "invalid_request_error", "the final message must be from the user");
  }
  return messages;
}

/**
 * Anthropic's usage shape, plus what this server knows and the API cannot say.
 *
 * `billed_tokens` is the headline — input + cache creation + output, leaving out
 * replayed cache reads. `step_usage` breaks a turn down by model call, which for
 * an agent looping through tools is the only place a per-call number exists.
 * `tool_call_count` is the same number as a scalar: a client auditing what the
 * harness was allowed to do should not have to sum array lengths to ask whether
 * it did anything.
 */
function usagePayload(usage: Usage, steps: Step[] = []): Record<string, unknown> {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_input_tokens: usage.cacheReadTokens,
    cache_creation_input_tokens: usage.cacheCreationTokens,
    cost_usd: Number(usage.costUsd.toFixed(6)),
    billed_tokens: billed(usage),
    peak_context_tokens: peakContext(steps),
    steps: steps.length,
    tool_call_count: toolCalls(steps),
    step_usage: steps.map((step) => ({
      index: step.index,
      model: step.model,
      input_tokens: step.usage.inputTokens,
      output_tokens: step.usage.outputTokens,
      cache_read_input_tokens: step.usage.cacheReadTokens,
      cache_creation_input_tokens: step.usage.cacheCreationTokens,
      billed_tokens: billed(step.usage),
      tools: step.tools.map((t) => t.name),
    })),
  };
}

/**
 * Emits a well-formed single-message Anthropic event stream.
 *
 * A harness turn produces several upstream messages as the agent loops through
 * tools; this collapses them into one message with our own block indices, so
 * the client always sees exactly one message_start/message_stop pair.
 */
class MessageStream {
  #sse: SseWriter;
  #index = -1;
  #open: BlockType | null = null;

  constructor(sse: SseWriter) {
    this.#sse = sse;
  }

  delta(type: BlockType, text: string): void {
    if (!text) return;
    if (this.#open !== type) {
      this.closeBlock();
      this.#index += 1;
      this.#open = type;
      this.#sse.send(
        {
          type: "content_block_start",
          index: this.#index,
          content_block:
            type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" },
        },
        "content_block_start",
      );
    }
    this.#sse.send(
      {
        type: "content_block_delta",
        index: this.#index,
        delta:
          type === "text"
            ? { type: "text_delta", text }
            : { type: "thinking_delta", thinking: text },
      },
      "content_block_delta",
    );
  }

  /** Emit a complete tool_use block. Arguments arrive already parsed. */
  toolCall(call: ParsedCall): void {
    this.closeBlock();
    this.#index += 1;
    this.#sse.send(
      {
        type: "content_block_start",
        index: this.#index,
        content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
      },
      "content_block_start",
    );
    this.#sse.send(
      {
        type: "content_block_delta",
        index: this.#index,
        delta: { type: "input_json_delta", partial_json: call.argumentsJson },
      },
      "content_block_delta",
    );
    this.#sse.send({ type: "content_block_stop", index: this.#index }, "content_block_stop");
  }

  closeBlock(): void {
    if (this.#open === null) return;
    this.#sse.send({ type: "content_block_stop", index: this.#index }, "content_block_stop");
    this.#open = null;
  }
}

export async function handleMessages(ctx: Ctx): Promise<void> {
  const body = ctx.body;
  const messages = normalize(body["messages"]);
  const system = systemText(body["system"]);

  const tools = parseAnthropicTools(body["tools"]);
  const toolPrompt = buildToolPrompt(tools, parseAnthropicToolChoice(body["tool_choice"]));

  const requestedModel = typeof body["model"] === "string" ? body["model"] : undefined;
  const target = resolveTarget(ctx.cfg, ctx.req.headers, requestedModel, system, null, toolPrompt);
  const advertised = requestedModel ?? target.entry.id;
  const stream = body["stream"] === true;
  const activity = activityMode(ctx.cfg, target.cls.mode);
  const startedAt = Date.now();
  const promptPreview = messages[messages.length - 1]!.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const events = ctx.sessions.run(
    {
      cls: target.cls,
      messages,
      pinnedSession: target.pinnedSession,
      maxBudgetUsd: target.maxBudgetUsd,
      advertisedModel: advertised,
    },
    ctx.signal,
  );

  const id = `msg_${randomUUID().replace(/-/g, "")}`;
  const iterator = events[Symbol.asyncIterator]();
  // An async generator abandoned mid-iteration never runs its `finally`, and
  // the one in SessionManager.run is what releases the session's lock. A lock
  // that is never released pins its entry busy forever, and a busy entry is
  // skipped by both the reaper and eviction — so the CLI behind it lives until
  // the bridge dies. Every exit from here, thrown or broken out of, has to end
  // the iterator. See `release()` below and the `finally` in the stream path.
  const release = () => void iterator.return?.(undefined);
  const first = await iterator.next();
  if (!first.done && first.value.kind === "error") {
    const err = first.value;
    release();
    throw new SocketError(err.status, err.type, err.message);
  }
  const session = !first.done && first.value.kind === "session" ? first.value : null;
  const sessionId = session?.sessionId ?? "";
  const reused = session?.reused ?? false;

  if (!stream) {
    let text = "";
    let usage = emptyUsage();
    let steps: Step[] = [];
    let stopReason = "end_turn";
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      const event = next.value;
      if (event.kind === "error") {
        release();
        throw new SocketError(event.status, event.type, event.message);
      }
      if (event.kind === "done") {
        text = event.text;
        usage = event.usage;
        steps = event.steps;
        stopReason = event.stopReason;
      }
    }

    let calls: ParsedCall[] = [];
    let unparsed = 0;
    if (tools.length > 0) {
      const extracted = extractToolCalls(text);
      text = extracted.text;
      calls = extracted.calls;
      unparsed = extracted.unparsed;
    }
    if (unparsed > 0) warnUnparsed(unparsed, sessionId);

    const content: Array<Record<string, unknown>> = [];
    if (text) content.push({ type: "text", text });
    for (const call of calls) {
      content.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
    }
    if (content.length === 0) content.push({ type: "text", text: "" });

    recordTurn(ctx.store, {
      startedAt,
      sessionId,
      dialect: "anthropic",
      mode: target.cls.mode,
      model: target.cls.model,
      advertisedModel: advertised,
      stream: false,
      cwd: target.cls.cwd,
      reused,
      usage,
      steps,
      clientToolCalls: calls.length,
      prompt: promptPreview,
      reply: text || calls.map((c) => `${c.name}(${c.argumentsJson})`).join(" "),
    });

    sendJson(ctx.res, 200, {
      id,
      type: "message",
      role: "assistant",
      model: advertised,
      content,
      stop_reason: calls.length > 0 ? "tool_use" : stopReason,
      stop_sequence: null,
      usage: usagePayload(usage, steps),
      ...(unparsed > 0 ? { claude_socket: { unparsed_tool_calls: unparsed } } : {}),
    });
    return;
  }

  const sse = new SseWriter(ctx.res, sessionId ? { "x-claude-session": sessionId } : {});
  const writer = new MessageStream(sse);

  sse.send(
    {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: advertised,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
    "message_start",
  );

  let usage = emptyUsage();
  let steps: Step[] = [];
  let stopReason = "end_turn";
  let failed: { type: string; message: string } | null = null;
  let calls: ParsedCall[] = [];
  let replyText = "";
  let unparsed = 0;
  // Reassembles the reply so a streaming client ends up with the same string a
  // non-streaming one gets: half-written <tool_call> tags withheld, trimmed the
  // way extractToolCalls trims, tail released by finish() below.
  const reply = new ReplyStream(tools.length > 0);

  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      const event = next.value;
      if (sse.closed) break;

      switch (event.kind) {
        case "delta":
          if (event.blockType === "text") {
            writer.delta("text", reply.push(event.text));
          } else if (activity === "reasoning") {
            writer.delta("thinking", event.text);
          }
          break;
        case "tool_use":
          if (activity === "reasoning") writer.delta("thinking", formatToolUse(event.name, event.input));
          else if (activity === "content") writer.delta("text", formatToolUse(event.name, event.input));
          break;
        case "tool_result":
          if (activity !== "off") {
            const line = formatToolResult(event.name, event.isError, event.preview);
            if (line) writer.delta(activity === "reasoning" ? "thinking" : "text", line);
          }
          break;
        case "done":
          usage = event.usage;
          steps = event.steps;
          stopReason = event.stopReason;
          // The completed text is authoritative for what gets recorded and for
          // the tool calls; the delta stream can only ever be a best-effort
          // reassembly of it, since a block whose deltas never arrived is
          // unrecoverable from the wire.
          if (tools.length > 0) {
            const extracted = extractToolCalls(event.text);
            calls = extracted.calls;
            replyText = extracted.text;
            unparsed = extracted.unparsed;
            if (unparsed > 0) warnUnparsed(unparsed, sessionId);
          } else {
            replyText = event.text;
          }
          break;
        case "error":
          failed = { type: event.type, message: event.message };
          break;
        default:
          break;
      }
      if (failed) break;
    }
  } finally {
    // Covers every way out of the loop above, including the two that leave the
    // generator suspended: a client that hung up mid-stream, and a turn that
    // ended in an error event.
    release();
    if (!sse.closed) {
      // Release the held tail while the text block is still open; closeBlock()
      // below would otherwise strand it.
      if (!failed) writer.delta("text", reply.finish());
      writer.closeBlock();
      if (failed) {
        sse.send({ type: "error", error: { type: failed.type, message: failed.message } }, "error");
      } else {
        for (const call of calls) writer.toolCall(call);
        // The authoritative text is opt-in because it repeats the whole reply;
        // `unparsed_tool_calls` is not, because it is the only thing that tells
        // a client the difference between the model declining to call a tool and
        // the socket having eaten a call it could not parse.
        const trailer: Record<string, unknown> = {};
        if (wantsAuthoritativeText(ctx.req.headers)) trailer["text"] = replyText;
        if (unparsed > 0) trailer["unparsed_tool_calls"] = unparsed;
        sse.send(
          {
            type: "message_delta",
            delta: {
              stop_reason: calls.length > 0 ? "tool_use" : stopReason,
              stop_sequence: null,
            },
            usage: usagePayload(usage, steps),
            ...(Object.keys(trailer).length > 0 ? { claude_socket: trailer } : {}),
          },
          "message_delta",
        );
        sse.send({ type: "message_stop" }, "message_stop");
      }
      sse.end();
    }

    recordTurn(ctx.store, {
      startedAt,
      sessionId,
      dialect: "anthropic",
      mode: target.cls.mode,
      model: target.cls.model,
      advertisedModel: advertised,
      stream: true,
      cwd: target.cls.cwd,
      reused,
      usage,
      steps,
      clientToolCalls: calls.length,
      prompt: promptPreview,
      reply: replyText || calls.map((c) => `${c.name}(${c.argumentsJson})`).join(" "),
      error: failed?.message ?? null,
    });
  }
}

/**
 * Rough token estimate. The CLI gives no way to count without a round trip, and
 * clients use this only for budgeting, so an approximation beats a 404.
 */
export function handleCountTokens(ctx: Ctx): void {
  const messages = normalize(ctx.body["messages"]);
  const system = systemText(ctx.body["system"]);
  let characters = system.length;
  for (const message of messages) {
    for (const block of message.content) {
      characters += block.type === "text" ? block.text.length : 1600;
    }
  }
  sendJson(ctx.res, 200, { input_tokens: Math.ceil(characters / 3.8) });
}
