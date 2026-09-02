import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMode, type Mode } from "./types.ts";
import type { LogLevel } from "../util/log.ts";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** One entry in the advertised model catalog. */
export interface ModelEntry {
  /** What clients see and send in `model`. Rename freely to disguise the backend. */
  id: string;
  /** What the CLI is actually told via --model. */
  model: string;
  mode: Mode;
  effort: string | null;
  /** Cosmetic, reported by /v1/models. */
  contextWindow: number;
  ownedBy: string;
  /**
   * Tool set for a `semi` (or `harness`) entry, overriding the mode's config
   * default. Lets one catalog entry be "the agent, but read-only" and another
   * be the full thing, without either touching the other.
   */
  tools?: string[] | null;
  allowedTools?: string[];
  disallowedTools?: string[];
}

/** Settings shared by the two agentic modes. */
export interface AgentModeConfig {
  workspaceRoot: string;
  /** Absolute directory roots a client may target via X-Claude-Cwd. */
  allowedCwds: string[];
  permissionMode: string;
  tools: string[] | null;
  allowedTools: string[];
  disallowedTools: string[];
  dangerouslySkipPermissions: boolean;
  appendSystemPrompt: string | null;
  settingSources: string;
  /** How intermediate agent activity reaches the client. */
  activity: "off" | "content" | "reasoning";
  disableNonEssentialModelCalls: boolean;
}

export interface Config {
  server: { host: string; port: number };
  auth: { tokens: string[]; required: boolean };
  claude: { binary: string; binaryArgs: string[]; extraArgs: string[]; env: Record<string, string> };
  defaults: { mode: Mode; model: string; effort: string | null };
  oracle: {
    systemPrompt: string;
    settingSources: string;
    disableNonEssentialModelCalls: boolean;
    /**
     * How the model's own thinking reaches the client. Oracle hands the loop to
     * the caller, so there is no tool narration here — this governs the thinking
     * blocks alone.
     *
     * `content` merges them into the reply text and is a deliberate opt-in: a
     * client that grounds or cites what it is given would read the thinking as
     * assertions rather than as narration. The side channel is the default for
     * that reason.
     */
    activity: "off" | "content" | "reasoning";
  };
  harness: AgentModeConfig;
  /**
   * Claude Code with a narrowed tool set. Same spawn path as `harness`, but the
   * tools are an allowlist — the defaults here are read-only, so `semi` is safe
   * to expose by default in a way `harness` is not.
   */
  semi: AgentModeConfig & {
    /** Whether a request may widen its own tool set beyond this default. */
    allowRequestTools: boolean;
  };
  sessions: {
    max: number;
    idleMs: number;
    reuse: boolean;
    turnTimeoutMs: number;
    /**
     * Where the pids of spawned CLI processes are written, so a restarted
     * bridge can kill what the previous one abandoned. Their parent pid is dead
     * by then, so this file is the only thing tying them back to us.
     */
    registryPath: string;
  };
  usage: {
    /** Persist turn history to SQLite. Off keeps it in a memory ring buffer. */
    persist: boolean;
    path: string;
    /** How often queued records are written. */
    flushMs: number;
    /** Rows older than this are dropped at startup. 0 keeps everything. */
    retentionDays: number;
    /** Ring-buffer size when `persist` is false. */
    memoryMax: number;
  };
  dashboard: {
    /**
     * Hand the configured API tokens to a dashboard loaded from loopback, so a
     * local operator does not have to copy one out of the terminal. Never
     * applies to a remote or proxied request.
     */
    localAutoAuth: boolean;
  };
  models: ModelEntry[];
  logLevel: LogLevel;
}

const BASE_MODELS: Array<{ model: string; context: number }> = [
  { model: "claude-opus-5", context: 500_000 },
  { model: "claude-sonnet-5", context: 1_000_000 },
  { model: "claude-fable-5", context: 200_000 },
  { model: "claude-haiku-4-5", context: 200_000 },
];

/**
 * The default tool set for `semi`: everything the agent needs to look around and
 * nothing that changes the machine. Chosen so the mode is safe to expose without
 * further configuration — widening it is a deliberate act.
 */
export const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite"];

/** Mode suffix on an advertised model id. */
const MODE_SUFFIX: Record<Mode, string> = { oracle: "", harness: "-harness", semi: "-semi" };

function defaultModels(defaults: Config["defaults"]): ModelEntry[] {
  const entries: ModelEntry[] = [];
  for (const base of BASE_MODELS) {
    for (const mode of ["oracle", "harness", "semi"] as Mode[]) {
      entries.push({
        id: base.model + MODE_SUFFIX[mode],
        model: base.model,
        mode,
        effort: null,
        contextWindow: base.context,
        ownedBy: "local",
      });
    }
  }
  // Convenience aliases so a client can just ask for the mode by name.
  for (const mode of ["oracle", "harness", "semi"] as Mode[]) {
    entries.push({
      id: mode,
      model: defaults.model,
      mode,
      effort: defaults.effort,
      contextWindow: 1_000_000,
      ownedBy: "local",
    });
  }
  return entries;
}

export function defaultConfig(): Config {
  const defaults: Config["defaults"] = { mode: "oracle", model: "claude-sonnet-5", effort: null };
  return {
    server: { host: "127.0.0.1", port: 8787 },
    auth: { tokens: [], required: true },
    claude: { binary: "claude", binaryArgs: [], extraArgs: [], env: {} },
    defaults,
    oracle: {
      systemPrompt: "You are a helpful assistant.",
      settingSources: "",
      disableNonEssentialModelCalls: true,
      activity: "reasoning",
    },
    harness: {
      workspaceRoot: join(projectRoot, "workspaces"),
      allowedCwds: [],
      permissionMode: "acceptEdits",
      tools: null,
      allowedTools: [],
      disallowedTools: [],
      dangerouslySkipPermissions: false,
      appendSystemPrompt: null,
      settingSources: "user,project,local",
      activity: "reasoning",
      disableNonEssentialModelCalls: true,
    },
    semi: {
      workspaceRoot: join(projectRoot, "workspaces"),
      allowedCwds: [],
      // Nothing in the default tool set can write, so there is nothing to accept.
      permissionMode: "default",
      tools: [...READ_ONLY_TOOLS],
      allowedTools: [],
      disallowedTools: [],
      dangerouslySkipPermissions: false,
      appendSystemPrompt: null,
      settingSources: "user,project,local",
      activity: "reasoning",
      disableNonEssentialModelCalls: true,
      allowRequestTools: true,
    },
    sessions: {
      max: 16,
      idleMs: 15 * 60_000,
      reuse: true,
      turnTimeoutMs: 20 * 60_000,
      registryPath: join(projectRoot, "data", "children.json"),
    },
    usage: {
      persist: true,
      path: join(projectRoot, "data", "usage.db"),
      flushMs: 2000,
      retentionDays: 90,
      memoryMax: 5000,
    },
    dashboard: { localAutoAuth: true },
    models: defaultModels(defaults),
    logLevel: "info",
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Shallow-per-section merge: a section in the file overrides only the keys it names. */
function merge(base: Config, override: Record<string, unknown>): Config {
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    if (isRecord(value) && isRecord(existing)) {
      out[key] = { ...existing, ...value };
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as unknown as Config;
}

function envList(name: string): string[] | null {
  const raw = process.env[name];
  if (!raw) return null;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(configPath?: string): Config {
  let cfg = defaultConfig();

  const path = configPath ?? process.env.SOCKET_CONFIG ?? join(projectRoot, "socket.config.json");
  if (existsSync(path)) {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) throw new Error(`${path}: expected a JSON object`);
    const hadModels = Array.isArray(parsed["models"]);
    cfg = merge(cfg, parsed);
    // Model entries are partial in config; fill in the boring fields.
    if (hadModels) {
      cfg.models = (parsed["models"] as Array<Record<string, unknown>>).map((m) => ({
        id: String(m["id"]),
        model: String(m["model"] ?? cfg.defaults.model),
        mode: isMode(m["mode"]) ? m["mode"] : "oracle",
        effort: m["effort"] == null ? null : String(m["effort"]),
        contextWindow: Number(m["contextWindow"] ?? 200_000),
        ownedBy: String(m["ownedBy"] ?? "local"),
        tools: Array.isArray(m["tools"]) ? m["tools"].map(String) : undefined,
        allowedTools: Array.isArray(m["allowedTools"]) ? m["allowedTools"].map(String) : undefined,
        disallowedTools: Array.isArray(m["disallowedTools"])
          ? m["disallowedTools"].map(String)
          : undefined,
      }));
    } else if (isRecord(parsed["defaults"])) {
      cfg.models = defaultModels(cfg.defaults);
    }
  }

  // Environment overrides win over the file, so containers can stay stateless.
  const tokens = envList("SOCKET_TOKENS") ?? envList("SOCKET_API_KEYS");
  if (tokens) cfg.auth.tokens = tokens;
  if (process.env["SOCKET_HOST"]) cfg.server.host = process.env["SOCKET_HOST"];
  if (process.env["SOCKET_PORT"]) cfg.server.port = Number(process.env["SOCKET_PORT"]);
  if (isMode(process.env["SOCKET_MODE"])) cfg.defaults.mode = process.env["SOCKET_MODE"];
  if (process.env["SOCKET_USAGE_DB"]) cfg.usage.path = process.env["SOCKET_USAGE_DB"];
  if (process.env["SOCKET_NO_USAGE_DB"] === "1") cfg.usage.persist = false;
  if (process.env["SOCKET_MODEL"]) cfg.defaults.model = process.env["SOCKET_MODEL"];
  if (process.env["SOCKET_CLAUDE_BIN"]) cfg.claude.binary = process.env["SOCKET_CLAUDE_BIN"];
  if (process.env["SOCKET_LOG_LEVEL"]) cfg.logLevel = process.env["SOCKET_LOG_LEVEL"] as LogLevel;
  if (process.env["SOCKET_NO_AUTH"] === "1") cfg.auth.required = false;

  return cfg;
}

/** Resolve an advertised model id, tolerating `<id>:<effort>` suffixes. */
export function resolveModel(cfg: Config, requested: string | undefined): ModelEntry {
  const fallback = requested ?? cfg.defaults.mode;
  const [idPart, effortPart] = fallback.split(":", 2);
  const id = (idPart ?? "").trim();

  let entry = cfg.models.find((m) => m.id === id);
  if (!entry) {
    // Unknown ids fall back to the default rather than erroring: clients like to
    // send whatever model name they were configured with, and a hard 404 there
    // is a worse experience than answering. A recognizable mode suffix is still
    // honoured, so `whatever-semi` lands in semi rather than the default.
    const mode: Mode = id.endsWith("-harness")
      ? "harness"
      : id.endsWith("-semi")
        ? "semi"
        : cfg.defaults.mode;
    entry = {
      id: id || cfg.defaults.model,
      model: cfg.defaults.model,
      mode,
      effort: cfg.defaults.effort,
      contextWindow: 200_000,
      ownedBy: "local",
    };
  }
  if (effortPart) entry = { ...entry, effort: effortPart };
  return entry;
}
