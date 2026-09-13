/** Shared types for the socket. */

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

/**
 * Which CLI answers a request.
 *
 * The two are not interchangeable and the socket does not pretend otherwise:
 * `claude` can be stripped to a bare completion endpoint and handed an exact
 * tool list, `codex` can only be handed a sandbox. What they do share is a
 * conversation that survives between turns and per-model-call token
 * accounting, and that is what the rest of the socket is written against.
 */
export type Provider = "claude" | "codex";

export const PROVIDERS: readonly Provider[] = ["claude", "codex"];

export function isProvider(value: unknown): value is Provider {
  return value === "claude" || value === "codex";
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

/** A chat message as accepted by the socket, after dialect normalization. */
export interface SocketMessage {
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
  provider: Provider;
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
export interface SocketRequest {
  cls: SessionClass;
  messages: SocketMessage[];
  /** Explicit session pin from X-Claude-Session; bypasses prefix matching. */
  pinnedSession: string | null;
  maxBudgetUsd: number | null;
  /** Advertised model id, echoed back to the client verbatim. */
  advertisedModel: string;
}

export class SocketError extends Error {
  status: number;
  type: string;

  constructor(status: number, type: string, message: string) {
    super(message);
    this.name = "SocketError";
    this.status = status;
    this.type = type;
  }
}

/**
 * One conversation, held open by whichever CLI is behind it.
 *
 * The two drivers keep a session alive by different means and the pool does not
 * need to know which. `claude` holds one long-lived process and feeds it turns
 * over stdin; `codex exec` is one process per turn, with continuity coming from
 * `codex exec resume <thread>`. So "alive" here means *the conversation* is
 * still usable, not that an OS process exists right now — which is why `pid`
 * may legitimately be null between turns, and why the pool asks `pids()` rather
 * than reading a single field when it reconciles against the operating system.
 */
export interface AgentProcess {
  /** Stable identity for this session, independent of any OS pid. */
  readonly key: string;
  readonly cls: SessionClass;
  /** The CLI's own id for the conversation; null until it reports one. */
  sessionId: string | null;
  lastUsedAt: number;
  turns: number;
  totalCostUsd: number;
  rateLimit: RateLimitInfo | null;
  alive: boolean;
  /** Epoch ms at creation, paired with a pid to identify it after a restart. */
  readonly spawnedAt: number;
  /** Resolves once every process this session owns is confirmed gone. */
  readonly whenGone: Promise<void>;
  /** The current OS pid, or null when no child is running just now. */
  readonly pid: number | null;
  readonly idleMs: number;
  /** Every pid this session is responsible for at this instant. */
  pids(): number[];
  /** Resolves once the CLI has reported its session id, or died trying. */
  ready(timeoutMs?: number): Promise<void>;
  runTurn(content: ContentBlock[]): AsyncGenerator<TurnEvent>;
  abort(): Promise<void>;
  dispose(): void;
}

/**
 * Told by a driver whenever it spawns a child, so the pool can write the pid to
 * the crash registry. A long-lived driver fires this once; a per-turn one fires
 * it on every turn, which is exactly why the pool cannot just read `pid` at
 * creation time and be done.
 */
export type SpawnListener = (pid: number, spawnedAt: number) => void;
