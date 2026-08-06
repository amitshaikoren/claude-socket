import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../core/config.ts";
import type { SessionClass } from "../core/types.ts";
import { log } from "../util/log.ts";

export interface SpawnPlan {
  args: string[];
  env: Record<string, string>;
  /** Inherited variables to remove from the child's environment. */
  unsetEnv: string[];
  cwd: string;
  /** Temp dir holding prompt files; removed when the process is disposed. */
  scratchDir: string;
}

const BASE_URL_VARS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_URL"];

/**
 * Detect an inherited base URL that points back at this very server.
 *
 * Pointing a Claude client at the bridge is the whole idea, but the CLI the
 * bridge spawns inherits that environment too — so without this the child would
 * call the bridge, which would spawn another child, forever. Only a
 * self-reference is stripped; a corporate gateway or proxy URL is left alone.
 */
function selfReferencingVars(port: number): string[] {
  const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);
  return BASE_URL_VARS.filter((name) => {
    const value = process.env[name];
    if (!value) return false;
    try {
      const url = new URL(value);
      const urlPort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
      return loopback.has(url.hostname) && urlPort === port;
    } catch {
      return false;
    }
  });
}

/**
 * Long or awkward values (system prompts) go through files rather than argv:
 * it sidesteps command-line length limits and Windows quoting entirely.
 */
function writePromptFile(dir: string, name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

/**
 * Translate a session class into a CLI invocation.
 *
 * Oracle mode strips the agent down to a bare completion endpoint: no tools, no
 * settings sources, no MCP, no skills, and a caller-supplied system prompt
 * replacing the Claude Code preamble. Harness mode leaves Claude Code intact.
 */
export function buildSpawnPlan(cfg: Config, cls: SessionClass, resumeSessionId?: string): SpawnPlan {
  const scratchDir = mkdtempSync(join(tmpdir(), "claude-bridge-"));
  const args: string[] = [
    ...cfg.claude.binaryArgs,
    "--print",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", cls.model,
  ];

  if (resumeSessionId) args.push("--resume", resumeSessionId);
  if (cls.effort) args.push("--effort", cls.effort);
  if (cls.jsonSchema) args.push("--json-schema", cls.jsonSchema);

  const env: Record<string, string> = {
    // Nothing here is interactive; keep the CLI from doing background work that
    // costs tokens or mutates the install underneath a long-lived server.
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_BUG_COMMAND: "1",
  };

  if (cls.mode === "oracle") {
    const o = cfg.oracle;
    args.push("--system-prompt-file", writePromptFile(scratchDir, "system.txt", cls.systemPrompt));
    args.push("--tools", "");
    args.push("--strict-mcp-config");
    args.push("--disable-slash-commands");
    args.push("--setting-sources", o.settingSources);
    if (o.disableNonEssentialModelCalls) env["DISABLE_NON_ESSENTIAL_MODEL_CALLS"] = "1";
  } else {
    const h = cfg.harness;
    if (cls.systemPrompt) {
      args.push(
        "--append-system-prompt-file",
        writePromptFile(scratchDir, "append-system.txt", cls.systemPrompt),
      );
    }
    args.push("--permission-mode", h.permissionMode);
    if (h.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
    if (h.tools) args.push("--tools", h.tools.join(","));
    if (h.allowedTools.length > 0) args.push("--allowed-tools", h.allowedTools.join(","));
    if (h.disallowedTools.length > 0) args.push("--disallowed-tools", h.disallowedTools.join(","));
    args.push("--setting-sources", h.settingSources);
    // Moves cwd/env/git status out of the system prompt so the cached prefix is
    // stable across sessions and machines.
    args.push("--exclude-dynamic-system-prompt-sections");
    if (h.disableNonEssentialModelCalls) env["DISABLE_NON_ESSENTIAL_MODEL_CALLS"] = "1";
  }

  args.push(...cfg.claude.extraArgs);
  Object.assign(env, cfg.claude.env);

  const unsetEnv = selfReferencingVars(cfg.server.port).filter((name) => !(name in cfg.claude.env));
  if (unsetEnv.length > 0) {
    log.warn(`unsetting ${unsetEnv.join(", ")} for the CLI: it points back at this server`);
  }

  return { args, env, unsetEnv, cwd: cls.cwd, scratchDir };
}
