import { randomUUID } from "node:crypto";

/**
 * Client-side tool calling.
 *
 * The CLI runs its own tools; it has no channel for handing a caller's tools
 * back out. So the bridge teaches the model a tagged protocol in the system
 * prompt and parses the tags back out of the reply. The tags are stripped from
 * anything the client sees, which keeps streaming intact — unlike a
 * JSON-schema-constrained response, where the whole turn would have to be
 * buffered and parsed before a single character could be forwarded.
 */

export interface ToolDef {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ParsedCall {
  id: string;
  name: string;
  /** Raw JSON text of the arguments, as OpenAI expects. */
  argumentsJson: string;
  arguments: unknown;
}

export type ToolChoice =
  | { kind: "auto" }
  | { kind: "none" }
  | { kind: "required" }
  | { kind: "named"; name: string };

const OPEN = "<tool_call>";
const CLOSE = "</tool_call>";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Normalize an OpenAI `tools` array. */
export function parseOpenAiTools(raw: unknown): ToolDef[] {
  if (!Array.isArray(raw)) return [];
  const tools: ToolDef[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const fn = isRecord(item["function"]) ? item["function"] : item;
    const name = fn["name"];
    if (typeof name !== "string" || !name) continue;
    tools.push({
      name,
      description: typeof fn["description"] === "string" ? fn["description"] : "",
      parameters: fn["parameters"] ?? { type: "object", properties: {} },
    });
  }
  return tools;
}

/** Normalize an Anthropic `tools` array. */
export function parseAnthropicTools(raw: unknown): ToolDef[] {
  if (!Array.isArray(raw)) return [];
  const tools: ToolDef[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const name = item["name"];
    if (typeof name !== "string" || !name) continue;
    tools.push({
      name,
      description: typeof item["description"] === "string" ? item["description"] : "",
      parameters: item["input_schema"] ?? { type: "object", properties: {} },
    });
  }
  return tools;
}

export function parseOpenAiToolChoice(raw: unknown): ToolChoice {
  if (raw === "none") return { kind: "none" };
  if (raw === "required") return { kind: "required" };
  if (isRecord(raw)) {
    const fn = isRecord(raw["function"]) ? raw["function"] : raw;
    if (typeof fn["name"] === "string") return { kind: "named", name: fn["name"] };
  }
  return { kind: "auto" };
}

export function parseAnthropicToolChoice(raw: unknown): ToolChoice {
  if (!isRecord(raw)) return { kind: "auto" };
  if (raw["type"] === "none") return { kind: "none" };
  if (raw["type"] === "any") return { kind: "required" };
  if (raw["type"] === "tool" && typeof raw["name"] === "string") {
    return { kind: "named", name: raw["name"] };
  }
  return { kind: "auto" };
}

/**
 * The protocol taught to the model. This becomes part of the system prompt, and
 * therefore part of the session class: a conversation with different tools is a
 * different session.
 */
export function buildToolPrompt(tools: ToolDef[], choice: ToolChoice): string {
  if (tools.length === 0 || choice.kind === "none") return "";

  const catalog = tools
    .map((t) => JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }))
    .join("\n");

  const lines = [
    "# Caller-provided tools",
    "",
    "These tools run on the caller's side, not here. You request a call and the",
    "result comes back in the next message.",
    "",
    "<tools>",
    catalog,
    "</tools>",
    "",
    "To call one, emit exactly:",
    `${OPEN}{"name": "tool_name", "arguments": {...}}${CLOSE}`,
    "",
    "Rules:",
    "- Put tool calls at the very end of your reply, after any text.",
    "- Emit one tag per call; several are allowed.",
    "- `arguments` must be a JSON object matching that tool's parameters.",
    "- Never invent a tool that is not listed above.",
    "- Stop after emitting calls. Results arrive next, inside <tool_result> tags.",
  ];

  if (choice.kind === "required") {
    lines.push("- You MUST call at least one tool in this reply.");
  } else if (choice.kind === "named") {
    lines.push(`- You MUST call the tool \`${choice.name}\` in this reply.`);
  } else {
    lines.push("- If no tool is needed, just answer normally with no tags.");
  }

  return lines.join("\n");
}

function recordCall(body: string, into: ParsedCall[]): void {
  const trimmed = body.trim();
  if (!trimmed) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return; // Malformed call: drop it rather than surface a broken tool_call.
  }
  if (!isRecord(parsed) || typeof parsed["name"] !== "string") return;

  const args = parsed["arguments"] ?? parsed["input"] ?? {};
  into.push({
    id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    name: parsed["name"],
    argumentsJson: typeof args === "string" ? args : JSON.stringify(args),
    arguments: args,
  });
}

/** Length of the longest suffix of `text` that is a proper prefix of `tag`. */
function partialSuffix(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1);
  for (let k = max; k > 0; k--) {
    if (text.endsWith(tag.slice(0, k))) return k;
  }
  return 0;
}

/**
 * Incremental scanner that separates prose from tool-call tags in a token
 * stream. Text that might be the start of a tag is held back until the next
 * chunk resolves it, so a half-written `<tool_` never reaches the client.
 */
export class ToolCallScanner {
  #buffer = "";
  #inCall = false;
  #calls: ParsedCall[] = [];

  get calls(): ParsedCall[] {
    return this.#calls;
  }

  /** Feed a chunk; returns the text that is safe to forward. */
  push(chunk: string): string {
    this.#buffer += chunk;
    let out = "";

    for (;;) {
      if (this.#inCall) {
        const end = this.#buffer.indexOf(CLOSE);
        if (end < 0) break;
        recordCall(this.#buffer.slice(0, end), this.#calls);
        this.#buffer = this.#buffer.slice(end + CLOSE.length);
        this.#inCall = false;
        continue;
      }

      const start = this.#buffer.indexOf(OPEN);
      if (start >= 0) {
        out += this.#buffer.slice(0, start);
        this.#buffer = this.#buffer.slice(start + OPEN.length);
        this.#inCall = true;
        continue;
      }

      const hold = partialSuffix(this.#buffer, OPEN);
      out += this.#buffer.slice(0, this.#buffer.length - hold);
      this.#buffer = hold > 0 ? this.#buffer.slice(this.#buffer.length - hold) : "";
      break;
    }

    return out;
  }

  /** Flush the tail. An unterminated call is still parsed if it looks complete. */
  finish(): { text: string; calls: ParsedCall[] } {
    let text = "";
    if (this.#inCall) {
      recordCall(this.#buffer, this.#calls);
    } else {
      text = this.#buffer;
    }
    this.#buffer = "";
    this.#inCall = false;
    return { text, calls: this.#calls };
  }
}

/** One-shot parse of a complete reply. */
export function extractToolCalls(text: string): { text: string; calls: ParsedCall[] } {
  const scanner = new ToolCallScanner();
  const head = scanner.push(text);
  const tail = scanner.finish();
  return { text: (head + tail.text).trim(), calls: tail.calls };
}

/** Render a tool result coming back from the client into the model's view. */
export function renderToolResult(name: string, id: string, body: string): string {
  const attrs = [name ? ` name="${name}"` : "", id ? ` id="${id}"` : ""].join("");
  return `<tool_result${attrs}>\n${body}\n</tool_result>`;
}

/** Render an assistant turn that contained tool calls, for transcript seeding. */
export function renderAssistantCalls(calls: Array<{ name: string; argumentsJson: string }>): string {
  return calls
    .map((c) => `${OPEN}{"name": ${JSON.stringify(c.name)}, "arguments": ${c.argumentsJson}}${CLOSE}`)
    .join("\n");
}
