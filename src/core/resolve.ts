import { resolve, join, isAbsolute, relative } from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import { resolveModel, type Config, type ModelEntry } from "./config.ts";
import { BridgeError, type Mode, type SessionClass } from "./types.ts";

function header(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Resolve the working directory for a harness session. Client-supplied paths
 * are confined to the workspace root unless an operator has explicitly opted a
 * directory in: a remote client picking any path on disk would make this a
 * remote code execution endpoint by accident.
 */
function resolveCwd(cfg: Config, requested: string | null): string {
  const root = resolve(cfg.harness.workspaceRoot);
  if (!requested) return join(root, "default");

  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  const roots = [root, ...cfg.harness.allowedCwds.map((p) => resolve(p))];
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
  const mode: Mode = modeHeader === "harness" || modeHeader === "oracle" ? modeHeader : entry.mode;
  const effort = header(headers, "x-claude-effort") ?? entry.effort;
  const cwd = mode === "harness" ? resolveCwd(cfg, header(headers, "x-claude-cwd")) : process.cwd();

  const budgetHeader = header(headers, "x-claude-max-budget-usd");
  const maxBudgetUsd = budgetHeader ? Number(budgetHeader) : null;

  // In oracle mode the client's system prompt replaces the Claude Code preamble
  // entirely; in harness mode it is appended so the agent keeps its own. The
  // tool protocol is appended last either way, so it survives both.
  const base =
    mode === "oracle"
      ? systemPrompt || cfg.oracle.systemPrompt
      : [cfg.harness.appendSystemPrompt, systemPrompt].filter(Boolean).join("\n\n");
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
    },
    pinnedSession: header(headers, "x-claude-session"),
    maxBudgetUsd: Number.isFinite(maxBudgetUsd) ? maxBudgetUsd : null,
  };
}
