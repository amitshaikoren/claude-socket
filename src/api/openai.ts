import { randomUUID } from "node:crypto";
import type { Ctx } from "../http/context.ts";
import { sendJson } from "../http/context.ts";
import { SseWriter } from "../http/sse.ts";
import { activityMode, resolveTarget } from "../core/resolve.ts";
import { formatToolResult, formatToolUse } from "../core/activity.ts";
import { recordTurn } from "../core/record.ts";
import { billed, peakContext, type Step } from "../core/usage.ts";
import {
  buildToolPrompt,
  extractToolCalls,
  parseOpenAiToolChoice,
  parseOpenAiTools,
  renderAssistantCalls,
  renderToolResult,
  ToolCallScanner,
  type ParsedCall,
} from "../core/tools.ts";
import {
  BridgeError,
  emptyUsage,
  type BridgeMessage,
  type ContentBlock,
  type TurnEvent,
  type Usage,
} from "../core/types.ts";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Decode `data:image/png;base64,...` and plain URLs into Anthropic image blocks. */
function imageBlock(url: string): ContentBlock | null {
  const dataUri = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (dataUri) {
    return { type: "image", source: { type: "base64", media_type: dataUri[1]!, data: dataUri[2]! } };
  }
  if (/^https?:\/\//.test(url)) return { type: "image", source: { type: "url", url } };
  return null;
}

function contentBlocks(content: unknown): ContentBlock[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const blocks: ContentBlock[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part["type"] === "text" && typeof part["text"] === "string") {
      blocks.push({ type: "text", text: part["text"] });
    } else if (part["type"] === "image_url" && isRecord(part["image_url"])) {
      const url = part["image_url"]["url"];
      const block = typeof url === "string" ? imageBlock(url) : null;
      if (block) blocks.push(block);
    }
  }
  return blocks;
}

interface Normalized {
  messages: BridgeMessage[];
  system: string;
}

function textOfBlocks(blocks: ContentBlock[]): string {
  return blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

/**
 * Fold an OpenAI message array into the bridge's shape.
 *
 * System/developer turns become the session's system prompt. A prior assistant
 * turn that made tool calls is re-rendered in the same tagged form the model
 * emitted, and the matching `role: "tool"` results are folded back in as user
 * turns, so the model sees one coherent transcript of its own protocol.
 */
function normalize(raw: unknown): Normalized {
  if (!Array.isArray(raw)) {
    throw new BridgeError(400, "invalid_request_error", "'messages' must be an array");
  }

  const messages: BridgeMessage[] = [];
  const system: string[] = [];
  const callNames = new Map<string, string>();

  for (const item of raw) {
    if (!isRecord(item)) continue;
    const role = String(item["role"] ?? "user");
    const blocks = contentBlocks(item["content"]);

    if (role === "system" || role === "developer") {
      const text = textOfBlocks(blocks);
      if (text) system.push(text);
      continue;
    }

    if (role === "tool" || role === "function") {
      const id = typeof item["tool_call_id"] === "string" ? item["tool_call_id"] : "";
      const name = callNames.get(id) ?? (typeof item["name"] === "string" ? item["name"] : "");
      messages.push({
        role: "user",
        content: [{ type: "text", text: renderToolResult(name, id, textOfBlocks(blocks)) }],
      });
      continue;
    }

    if (role === "assistant") {
      const rawCalls = Array.isArray(item["tool_calls"]) ? item["tool_calls"] : [];
      const calls = rawCalls.filter(isRecord).map((call) => {
        const fn = isRecord(call["function"]) ? call["function"] : call;
        const name = String(fn["name"] ?? "");
        const id = String(call["id"] ?? "");
        if (id) callNames.set(id, name);
        const args = fn["arguments"];
        return { name, argumentsJson: typeof args === "string" ? args : JSON.stringify(args ?? {}) };
      });

      const text = [textOfBlocks(blocks), calls.length > 0 ? renderAssistantCalls(calls) : ""]
        .filter(Boolean)
        .join("\n");
      if (text) messages.push({ role: "assistant", content: [{ type: "text", text }] });
      continue;
    }

    if (blocks.length === 0) continue;
    messages.push({ role: "user", content: blocks });
  }

  if (messages.length === 0) {
    throw new BridgeError(400, "invalid_request_error", "no usable messages in request");
  }
  if (messages[messages.length - 1]!.role !== "user") {
    throw new BridgeError(400, "invalid_request_error", "the final message must be from the user");
  }

  return { messages, system: system.join("\n\n") };
}

function finishReason(stopReason: string): string {
  if (stopReason === "max_tokens") return "length";
  if (stopReason === "refusal") return "content_filter";
  return "stop";
}

/**
 * OpenAI's usage shape, plus the numbers this server actually knows.
 *
 * `prompt_tokens` stays inclusive of cache reads, because that is what an OpenAI
 * client means by the field and clients do arithmetic on it. The extra keys are
 * non-standard and ignored by every client that does not want them:
 * `billed_tokens` is the headline (input + cache creation + output, excluding
 * replayed cache reads), and `steps` says how many model calls the turn took —
 * which for an agentic turn is the difference between one request and thirty.
 */
function usagePayload(usage: Usage, steps: Step[] = []): Record<string, unknown> {
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  return {
    prompt_tokens: prompt,
    completion_tokens: usage.outputTokens,
    total_tokens: prompt + usage.outputTokens,
    prompt_tokens_details: {
      cached_tokens: usage.cacheReadTokens,
      cache_creation_tokens: usage.cacheCreationTokens,
    },
    cost_usd: Number(usage.costUsd.toFixed(6)),
    billed_tokens: billed(usage),
    peak_context_tokens: peakContext(steps),
    steps: steps.length,
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

export async function handleChatCompletions(ctx: Ctx): Promise<void> {
  const body = ctx.body;
  const { messages, system } = normalize(body["messages"]);

  const format = isRecord(body["response_format"]) ? body["response_format"] : null;
  let jsonSchema: unknown | null = null;
  let systemPrompt = system;
  if (format?.["type"] === "json_schema" && isRecord(format["json_schema"])) {
    jsonSchema = format["json_schema"]["schema"] ?? null;
  } else if (format?.["type"] === "json_object") {
    systemPrompt = [system, "Respond with a single valid JSON object and nothing else."]
      .filter(Boolean)
      .join("\n\n");
  }

  const tools = parseOpenAiTools(body["tools"]);
  const toolChoice = parseOpenAiToolChoice(body["tool_choice"]);
  const toolPrompt = buildToolPrompt(tools, toolChoice);

  const requestedModel = typeof body["model"] === "string" ? body["model"] : undefined;
  const target = resolveTarget(
    ctx.cfg,
    ctx.req.headers,
    requestedModel,
    systemPrompt,
    jsonSchema,
    toolPrompt,
  );
  const advertised = requestedModel ?? target.entry.id;

  const stream = body["stream"] === true;
  const streamOptions = isRecord(body["stream_options"]) ? body["stream_options"] : null;
  const includeUsage = streamOptions?.["include_usage"] === true;
  const promptPreview = textOfBlocks(messages[messages.length - 1]?.content ?? []);

  const activity = activityMode(ctx.cfg, target.cls.mode);
  const startedAt = Date.now();
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

  const id = `chatcmpl-${randomUUID().replace(/-/g, "")}`;
  const created = Math.floor(Date.now() / 1000);

  const iterator = events[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (!first.done && first.value.kind === "error") {
    const err = first.value;
    throw new BridgeError(err.status, err.type, err.message);
  }

  const session = !first.done && first.value.kind === "session" ? first.value : null;
  const sessionId = session?.sessionId ?? "";
  const reused = session?.reused ?? false;

  if (!stream) {
    let text = "";
    let reasoning = "";
    let usage = emptyUsage();
    let steps: Step[] = [];
    let stopReason = "end_turn";

    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      const event = next.value;
      if (event.kind === "error") throw new BridgeError(event.status, event.type, event.message);
      if (event.kind === "tool_use" && activity !== "off") {
        reasoning += formatToolUse(event.name, event.input);
      } else if (event.kind === "tool_result" && activity !== "off") {
        reasoning += formatToolResult(event.name, event.isError, event.preview);
      } else if (event.kind === "done") {
        text = event.text;
        reasoning = event.thinking + reasoning;
        usage = event.usage;
        steps = event.steps;
        stopReason = event.stopReason;
      }
    }

    let calls: ParsedCall[] = [];
    if (tools.length > 0) {
      const extracted = extractToolCalls(text);
      text = extracted.text;
      calls = extracted.calls;
    }

    const message: Record<string, unknown> = { role: "assistant", content: text || null };
    if (reasoning && activity === "reasoning") message["reasoning_content"] = reasoning;
    if (reasoning && activity === "content") message["content"] = reasoning + "\n" + text;
    if (calls.length > 0) {
      message["tool_calls"] = calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.argumentsJson },
      }));
    }

    recordTurn(ctx.store, {
      startedAt,
      sessionId,
      dialect: "openai",
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
      object: "chat.completion",
      created,
      model: advertised,
      system_fingerprint: sessionId ? `claude-bridge-${sessionId.slice(0, 12)}` : undefined,
      choices: [
        {
          index: 0,
          message,
          logprobs: null,
          finish_reason: calls.length > 0 ? "tool_calls" : finishReason(stopReason),
        },
      ],
      usage: usagePayload(usage, steps),
    });
    return;
  }

  const sse = new SseWriter(ctx.res, sessionId ? { "x-claude-session": sessionId } : {});
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => {
    sse.send({
      id,
      object: "chat.completion.chunk",
      created,
      model: advertised,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
    });
  };

  chunk({ role: "assistant", content: "" });

  let usage = emptyUsage();
  let steps: Step[] = [];
  let stopReason = "end_turn";
  let failed: TurnEvent | null = null;
  let calls: ParsedCall[] = [];
  let replyText = "";

  // With tools in play, text is filtered so a half-written <tool_call> tag
  // never reaches the client.
  const scanner = tools.length > 0 ? new ToolCallScanner() : null;

  const reason = (text: string) => {
    if (activity === "reasoning") chunk({ reasoning_content: text });
    else if (activity === "content") chunk({ content: text });
  };

  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      const event = next.value;
      if (sse.closed) break;

      switch (event.kind) {
        case "delta":
          if (event.blockType === "text") {
            const safe = scanner ? scanner.push(event.text) : event.text;
            if (safe) chunk({ content: safe });
          } else if (activity === "reasoning") {
            chunk({ reasoning_content: event.text });
          }
          break;
        case "tool_use":
          if (activity !== "off") reason(formatToolUse(event.name, event.input));
          break;
        case "tool_result":
          if (activity !== "off") reason(formatToolResult(event.name, event.isError, event.preview));
          break;
        case "done":
          usage = event.usage;
          steps = event.steps;
          stopReason = event.stopReason;
          // The completed text is authoritative; re-parse it rather than trust
          // the reassembled delta stream.
          if (scanner) {
            const extracted = extractToolCalls(event.text);
            calls = extracted.calls;
            replyText = extracted.text;
          } else {
            replyText = event.text;
          }
          break;
        case "error":
          failed = event;
          break;
        default:
          break;
      }
      if (failed) break;
    }
  } finally {
    if (!sse.closed) {
      if (failed && failed.kind === "error") {
        sse.send({ error: { message: failed.message, type: failed.type, code: failed.status } });
      } else {
        calls.forEach((call, index) => {
          chunk({
            tool_calls: [
              {
                index,
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.argumentsJson },
              },
            ],
          });
        });
        chunk({}, calls.length > 0 ? "tool_calls" : finishReason(stopReason));
      }
      if (includeUsage) {
        sse.send({
          id,
          object: "chat.completion.chunk",
          created,
          model: advertised,
          choices: [],
          usage: usagePayload(usage, steps),
        });
      }
      sse.send("[DONE]");
      sse.end();
    }

    recordTurn(ctx.store, {
      startedAt,
      sessionId,
      dialect: "openai",
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
      error: failed && failed.kind === "error" ? failed.message : null,
    });
  }
}

export function handleModels(ctx: Ctx): void {
  const created = Math.floor(Date.now() / 1000);
  const cfg = ctx.cfg;
  sendJson(ctx.res, 200, {
    object: "list",
    data: cfg.models.map((m) => {
      const section = m.mode === "semi" ? cfg.semi : m.mode === "harness" ? cfg.harness : null;
      return {
        id: m.id,
        object: "model",
        created,
        owned_by: m.ownedBy,
        context_window: m.contextWindow,
        // Non-standard, but the two things a client of this server wants to
        // know: how much agent it gets, and which tools that agent may run.
        mode: m.mode,
        tools: m.tools !== undefined ? m.tools : (section?.tools ?? null),
      };
    }),
  });
}
