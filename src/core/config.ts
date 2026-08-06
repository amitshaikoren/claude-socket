import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Mode } from "./types.ts";
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
  };
  harness: {
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
  };
  sessions: { max: number; idleMs: number; reuse: boolean; turnTimeoutMs: number };
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

function defaultModels(defaults: Config["defaults"]): ModelEntry[] {
  const entries: ModelEntry[] = [];
  for (const base of BASE_MODELS) {
    entries.push({
      id: base.model,
      model: base.model,
      mode: "oracle",
      effort: null,
      contextWindow: base.context,
      ownedBy: "local",
    });
    entries.push({
      id: `${base.model}-harness`,
      model: base.model,
      mode: "harness",
      effort: null,
      contextWindow: base.context,
      ownedBy: "local",
    });
  }
  // Convenience aliases so a client can just ask for "oracle" or "harness".
  entries.push({
    id: "oracle",
    model: defaults.model,
    mode: "oracle",
    effort: defaults.effort,
    contextWindow: 1_000_000,
    ownedBy: "local",
  });
  entries.push({
    id: "harness",
    model: defaults.model,
    mode: "harness",
    effort: defaults.effort,
    contextWindow: 1_000_000,
    ownedBy: "local",
  });
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
    sessions: { max: 16, idleMs: 15 * 60_000, reuse: true, turnTimeoutMs: 20 * 60_000 },
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

  const path = configPath ?? process.env.BRIDGE_CONFIG ?? join(projectRoot, "bridge.config.json");
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
        mode: (m["mode"] === "harness" ? "harness" : "oracle") as Mode,
        effort: m["effort"] == null ? null : String(m["effort"]),
        contextWindow: Number(m["contextWindow"] ?? 200_000),
        ownedBy: String(m["ownedBy"] ?? "local"),
      }));
    } else if (isRecord(parsed["defaults"])) {
      cfg.models = defaultModels(cfg.defaults);
    }
  }

  // Environment overrides win over the file, so containers can stay stateless.
  const tokens = envList("BRIDGE_TOKENS") ?? envList("BRIDGE_API_KEYS");
  if (tokens) cfg.auth.tokens = tokens;
  if (process.env["BRIDGE_HOST"]) cfg.server.host = process.env["BRIDGE_HOST"];
  if (process.env["BRIDGE_PORT"]) cfg.server.port = Number(process.env["BRIDGE_PORT"]);
  if (process.env["BRIDGE_MODE"]) cfg.defaults.mode = process.env["BRIDGE_MODE"] as Mode;
  if (process.env["BRIDGE_MODEL"]) cfg.defaults.model = process.env["BRIDGE_MODEL"];
  if (process.env["BRIDGE_CLAUDE_BIN"]) cfg.claude.binary = process.env["BRIDGE_CLAUDE_BIN"];
  if (process.env["BRIDGE_LOG_LEVEL"]) cfg.logLevel = process.env["BRIDGE_LOG_LEVEL"] as LogLevel;
  if (process.env["BRIDGE_NO_AUTH"] === "1") cfg.auth.required = false;

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
    // is a worse experience than answering.
    const mode: Mode = id.endsWith("-harness") ? "harness" : cfg.defaults.mode;
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
