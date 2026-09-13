import { resolve, join, isAbsolute, relative } from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import { resolveModel, type AgentModeConfig, type Config, type ModelEntry } from "./config.ts";
import {
  SocketError,
  emptyToolPolicy,
  isMode,
  type Mode,
  type Provider,
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
    throw new SocketError(
      403,
      "permission_error",
      `working directory is outside the permitted roots: ${candidate}`,
    );
  }
  return candidate;
}

/**
 * Where an oracle session runs.
 *
 * On Claude this barely matters: oracle spawns with `--tools ""`, so the CLI's
 * working directory is a detail nothing can reach. On Codex it matters a great
 * deal — the sandbox is the only lever there, and a read-only sandbox rooted
 * wherever the bridge happens to have been started is a read-only sandbox over
 * the bridge's own source, config file and API tokens included. So Codex gets a
 * directory inside the workspace root like every other mode, and it is not
 * settable per request: oracle is not supposed to be about a directory at all.
 */
function oracleCwd(cfg: Config, provider: Provider): string {
  if (provider !== "codex") return process.cwd();
  return join(resolve(cfg.semi.workspaceRoot), "oracle");
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
  provider: Provider,
  mode: Mode,
  entry: ModelEntry,
  headers: IncomingHttpHeaders,
): ToolPolicy {
  // `codex exec` has no tool allowlist — a sandbox is the only lever it takes —
  // so a request that asks to narrow one cannot be honoured. Saying so is the
  // only safe answer: silently ignoring it would leave a caller believing it
  // had restricted an agent that is still holding every tool it started with.
  if (provider === "codex") {
    if (headerList(headers, "x-claude-tools") || headerList(headers, "x-claude-disallowed-tools")) {
      throw new SocketError(
        400,
        "invalid_request_error",
        "codex has no tool allowlist, so X-Claude-Tools cannot be applied; " +
          `its tool access is set by the sandbox for this mode (${mode})`,
      );
    }
    return emptyToolPolicy();
  }

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
        throw new SocketError(
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
  // The catalog entry decides the backend; a header can move a request between
  // modes but never between CLIs, because the model id would no longer mean
  // anything to the one it landed on.
  const provider: Provider = entry.provider;
  const effort = header(headers, "x-claude-effort") ?? entry.effort;
  const section = modeConfig(cfg, mode);
  const cwd = section
    ? resolveCwd(section, header(headers, "x-claude-cwd"))
    : oracleCwd(cfg, provider);

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
      provider,
      mode,
      model: entry.model,
      systemPrompt: resolvedSystem,
      effort,
      cwd,
      jsonSchema: jsonSchema ? JSON.stringify(jsonSchema) : null,
      tools: resolveToolPolicy(cfg, provider, mode, entry, headers),
    },
    pinnedSession: header(headers, "x-claude-session"),
    maxBudgetUsd: Number.isFinite(maxBudgetUsd) ? maxBudgetUsd : null,
  };
}

/**
 * Whether a mode streams intermediate agent activity to the client.
 *
 * Every mode has a say. For the agentic pair that means tool narration and the
 * agent's thinking; oracle runs no loop, so it means the thinking alone, which
 * this used to drop on the floor before the config was ever consulted.
 *
 * Note what this does *not* buy on its own. Claude Code 2.1.220 emits thinking
 * blocks over stream-json with the text redacted — `thinking: ""` plus a
 * signature and a token estimate — in every mode, and MAX_THINKING_TOKENS does
 * not change it. So the side channel is wired end to end but carries nothing
 * until the CLI exposes the text. That is a CLI-side gap this function cannot
 * close, and it applies just as much to harness and semi.
 */
export function activityMode(cfg: Config, mode: Mode): "off" | "content" | "reasoning" {
  return (modeConfig(cfg, mode) ?? cfg.oracle).activity;
}
