/** Shared types for the bridge. */

export type Mode = "oracle" | "harness";

export type BlockType = "text" | "thinking";

/** Normalized token accounting for one turn. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
  };
}

/**
 * Provider-neutral events for one turn, normalized from the CLI's stream-json
 * output. Both the OpenAI and the Anthropic renderers are built from these, so
 * neither dialect depends on the CLI's wire format.
 */
export type TurnEvent =
  | { kind: "session"; sessionId: string; model: string; reused: boolean }
  | { kind: "block_start"; blockType: BlockType }
  | { kind: "delta"; blockType: BlockType; text: string }
  | { kind: "block_stop"; blockType: BlockType }
  | { kind: "tool_use"; name: string; input: unknown }
  | { kind: "tool_result"; name: string; isError: boolean; preview: string }
  | { kind: "done"; usage: Usage; stopReason: string; text: string; thinking: string }
  | { kind: "error"; status: number; type: string; message: string };

/** Rate-limit state as last reported by the CLI. */
export interface RateLimitInfo {
  status: string;
  rateLimitType?: string;
  resetsAt?: number;
  isUsingOverage?: boolean;
}

/** A chat message as accepted by the bridge, after dialect normalization. */
export interface BridgeMessage {
  role: "system" | "user" | "assistant";
  /** Anthropic-shaped content blocks; text-only messages carry one text block. */
  content: ContentBlock[];
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: ImageSource };

export type ImageSource =
  | { type: "base64"; media_type: string; data: string }
  | { type: "url"; url: string };

/**
 * Everything that defines which CLI process a request may be routed to. Every
 * field here is a process-level CLI flag, so two requests may only share a
 * process when their whole session class matches.
 */
export interface SessionClass {
  mode: Mode;
  model: string;
  systemPrompt: string;
  effort: string | null;
  cwd: string;
  /** Serialized --json-schema, or null. */
  jsonSchema: string | null;
}

/** A fully resolved request, independent of which HTTP dialect produced it. */
export interface BridgeRequest {
  cls: SessionClass;
  messages: BridgeMessage[];
  /** Explicit session pin from X-Claude-Session; bypasses prefix matching. */
  pinnedSession: string | null;
  maxBudgetUsd: number | null;
  /** Advertised model id, echoed back to the client verbatim. */
  advertisedModel: string;
}

export class BridgeError extends Error {
  status: number;
  type: string;

  constructor(status: number, type: string, message: string) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
    this.type = type;
  }
}
