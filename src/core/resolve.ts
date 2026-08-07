import { resolve, join, isAbsolute, relative } from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import { resolveModel, type AgentModeConfig, type Config, type ModelEntry } from "./config.ts";
import {
  BridgeError,
  emptyToolPolicy,
  isAgentic,
  isMode,
  type Mode,
  type SessionClass,
  type ToolPolicy,
} from "./types.ts";

/**
 * Whether the caller asked for the authoritative reply text on the terminal
 * stream frame. Off by default: it duplicates the whole reply on the wire, and
 * only a client that grounds or audits the output needs it.
 */
export function wantsAuthoritativeText(headers: IncomingHttpHeaders): boolean {
  const raw = header(headers, "x-claude-authoritative-text");
  return raw !== null && raw !== "0" && raw !== "false";
}

function header(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Comma-separated header value, or null when the header is absent. */
function headerList(headers: IncomingHttpHeaders, name: string): string[] | null {
  const raw = header(headers, name);
  if (raw === null) return null;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** The config section that governs a mode. Oracle spawns no agent, so it has none. */
export function modeConfig(cfg: Config, mode: Mode): AgentModeConfig | null {
  if (mode === "harness") return cfg.harness;
  if (mode === "semi") return cfg.semi;
  return null;
}

/**
 * Resolve the working directory for an agentic session. Client-supplied paths
 * are confined to the workspace root unless an operator has explicitly opted a
 * directory in: a remote client picking any path on disk would make this a
 * remote code execution endpoint by accident.
 */
function resolveCwd(mode: AgentModeConfig, requested: string | null): string {
  const root = resolve(mode.workspaceRoot);
  if (!requested) return join(root, "default");

  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  const roots = [root, ...mode.allowedCwds.map((p) => resolve(p))];
  const permitted = roots.some((allowed) => {
    const rel = relative(allowed, candidate);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });

  if (!permitted) {
    throw new BridgeError(
      403,
      "permission_error",
      `working directory is outside the permitted roots: ${candidate}`,
    );
  }
  return candidate;
}

/**
 * Decide which of Claude Code's own tools this session may use.
 *
 * Three layers, each narrower than the last: the mode's config default, then the
 * catalog entry, then the request headers. A request may only ever *narrow* the
 * set it was offered — `X-Claude-Tools` intersects, it does not replace. Letting
 * a header widen it would mean any client could promote itself from the
 * read-only `semi` mode to a full agent by naming `Bash`, which would make the
 * whole distinction decorative.
 *
 * `semi.allowRequestTools: false` turns the header off entirely.
 */
function resolveToolPolicy(
  cfg: Config,
  mode: Mode,
  entry: ModelEntry,
  headers: IncomingHttpHeaders,
): ToolPolicy {
  const section = modeConfig(cfg, mode);
  if (!section) return emptyToolPolicy();

  const base = entry.tools !== undefined ? entry.tools : section.tools;
  const allowed = entry.allowedTools ?? section.allowedTools;
  const disallowed = entry.disallowedTools ?? section.disallowedTools;

  const configurable = mode === "semi" ? cfg.semi.allowRequestTools : true;
  const requested = configurable ? headerList(headers, "x-claude-tools") : null;
  const requestDisallowed = configurable ? headerList(headers, "x-claude-disallowed-tools") : null;

  let tools = base === null ? null : [...base];
  if (requested) {
    if (tools === null) {
      // No configured ceiling: the request's list becomes the set. This is the
      // harness case, where the operator has already accepted full tool access.
      tools = requested;
    } else {
      const ceiling = new Set(tools);
      const narrowed = requested.filter((t) => ceiling.has(t));
      if (narrowed.length === 0) {
        throw new BridgeError(
          400,
          "invalid_request_error",
          `none of the requested tools are available in ${mode} mode ` +
            `(offered: ${tools.join(", ") || "none"})`,
        );
      }
      tools = narrowed;
    }
  }

  return {
    // Sorted so two requests naming the same tools in a different order share a
    // session instead of spawning two identical processes.
    tools: tools === null ? null : [...new Set(tools)].sort(),
    allowed: [...new Set(allowed)].sort(),
    disallowed: [...new Set([...disallowed, ...(requestDisallowed ?? [])])].sort(),
  };
}

export interface ResolvedTarget {
  entry: ModelEntry;
  cls: SessionClass;
  pinnedSession: string | null;
  maxBudgetUsd: number | null;
}

/**
 * Combine the advertised model, request headers and system prompt into the
 * session class that decides which CLI process can serve the request.
 */
export function resolveTarget(
  cfg: Config,
  headers: IncomingHttpHeaders,
  requestedModel: string | undefined,
  systemPrompt: string,
  jsonSchema: unknown | null,
  toolPrompt = "",
): ResolvedTarget {
  const entry = resolveModel(cfg, requestedModel);

  const modeHeader = header(headers, "x-claude-mode");
  const mode: Mode = isMode(modeHeader) ? modeHeader : entry.mode;
  const effort = header(headers, "x-claude-effort") ?? entry.effort;
  const section = modeConfig(cfg, mode);
  const cwd = section ? resolveCwd(section, header(headers, "x-claude-cwd")) : process.cwd();

  const budgetHeader = header(headers, "x-claude-max-budget-usd");
  const maxBudgetUsd = budgetHeader ? Number(budgetHeader) : null;

  // In oracle mode the client's system prompt replaces the Claude Code preamble
  // entirely; the agentic modes append it so the agent keeps its own. The tool
  // protocol is appended last either way, so it survives both.
  const base = section
    ? [section.appendSystemPrompt, systemPrompt].filter(Boolean).join("\n\n")
    : systemPrompt || cfg.oracle.systemPrompt;
  const resolvedSystem = [base, toolPrompt].filter(Boolean).join("\n\n");

  return {
    entry,
    cls: {
      mode,
      model: entry.model,
      systemPrompt: resolvedSystem,
      effort,
      cwd,
      jsonSchema: jsonSchema ? JSON.stringify(jsonSchema) : null,
      tools: resolveToolPolicy(cfg, mode, entry, headers),
    },
    pinnedSession: header(headers, "x-claude-session"),
    maxBudgetUsd: Number.isFinite(maxBudgetUsd) ? maxBudgetUsd : null,
  };
}

/** Whether a mode streams intermediate agent activity to the client. */
export function activityMode(cfg: Config, mode: Mode): "off" | "content" | "reasoning" {
  if (!isAgentic(mode)) return "off";
  return (modeConfig(cfg, mode) ?? cfg.harness).activity;
}
