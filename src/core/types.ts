/** Shared types for the bridge. */

// Type-only, so the usage <-> types cycle is erased before it reaches Node.
import type { Step } from "./usage.ts";

/**
 * How much of Claude Code a request gets.
 *
 * `oracle` strips the CLI to a completion endpoint and hands the loop to the
 * caller. `harness` is Claude Code intact. `semi` is Claude Code with its tool
 * set narrowed by the request — the agent still runs its own loop, but only over
 * the tools it was given.
 */
export type Mode = "oracle" | "harness" | "semi";

export const MODES: readonly Mode[] = ["oracle", "harness", "semi"];

export function isMode(value: unknown): value is Mode {
  return value === "oracle" || value === "harness" || value === "semi";
}

/** True for the modes that spawn a real Claude Code agent. */
export function isAgentic(mode: Mode): boolean {
  return mode === "harness" || mode === "semi";
}

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
  /** One completed model call within the turn, with its own billed usage. */
  | { kind: "step"; step: Step }
  | {
      kind: "done";
      usage: Usage;
      stopReason: string;
      text: string;
      thinking: string;
      /** Per-call breakdown; empty when the CLI reported no per-message usage. */
      steps: Step[];
    }
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
  /**
   * The agent's own tool set, for `harness` and `semi`. Part of the class — and
   * therefore of the reuse hash — because a process spawned with one tool set
   * can never serve a request that asked for another.
   */
  tools: ToolPolicy;
}

/** Which of Claude Code's built-in tools a session may use. */
export interface ToolPolicy {
  /** Exact `--tools` list. `null` leaves the CLI's default set in place. */
  tools: string[] | null;
  allowed: string[];
  disallowed: string[];
}

export function emptyToolPolicy(): ToolPolicy {
  return { tools: null, allowed: [], disallowed: [] };
}

/** Stable rendering of a policy, for hashing and for display. */
export function toolPolicyKey(policy: ToolPolicy): string {
  return JSON.stringify([policy.tools, policy.allowed, policy.disallowed]);
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
