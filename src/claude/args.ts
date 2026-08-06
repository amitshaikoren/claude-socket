import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../core/config.ts";
import type { SessionClass } from "../core/types.ts";

export interface SpawnPlan {
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** Temp dir holding prompt files; removed when the process is disposed. */
  scratchDir: string;
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

  return { args, env, cwd: cls.cwd, scratchDir };
}
