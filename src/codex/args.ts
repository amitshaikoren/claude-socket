import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../core/config.ts";
import type { Mode, SessionClass } from "../core/types.ts";
import { selfReferencingVars } from "../agent/spawn.ts";
import { codexHome, windowsSandboxMode } from "./home.ts";
import { log } from "../util/log.ts";

/** Base URL variables that would send the CLI back to this very server. */
const BASE_URL_VARS = ["OPENAI_BASE_URL", "OPENAI_API_BASE", "CODEX_URL"];

export interface CodexPlan {
  args: string[];
  env: Record<string, string>;
  unsetEnv: string[];
  cwd: string;
}

export interface TurnOptions {
  /** Scratch dir for this turn's schema file and decoded images. */
  scratchDir: string;
  /** Thread to continue, or undefined to start one. */
  threadId?: string;
  /** Files already written for this turn's image blocks, in order. */
  imagePaths?: string[];
}

/**
 * The sandbox a mode gets when config does not say otherwise.
 *
 * This is the only tool lever `codex exec` has. There is no `--tools` and no
 * way to hand it an exact allowlist, so `oracle` and `semi` land on the same
 * setting — read-only — and are told apart by their system prompt rather than
 * by the CLI. See the note on {@link buildCodexPlan} for what that costs.
 */
const DEFAULT_SANDBOX: Record<Mode, string> = {
  oracle: "read-only",
  semi: "read-only",
  harness: "workspace-write",
};

export function sandboxFor(cfg: Config, mode: Mode): string {
  return cfg.codex.sandbox[mode] || DEFAULT_SANDBOX[mode];
}

/**
 * Translate a session class and one turn into a `codex exec` invocation.
 *
 * Two things differ from the Claude side and both are forced by the CLI.
 *
 * The command is rebuilt every turn, because `codex exec` is one process per
 * turn: continuity comes from `resume <thread>`, not from a process that stays
 * up. Flag order matters there — every option has to precede the `resume`
 * subcommand, and the trailing `-` that makes the CLI read the prompt from
 * stdin has to come last.
 *
 * And there is no system-prompt flag. `base_instructions` is an app-server
 * protocol field that `codex exec` does not accept as config — verified against
 * 0.153.4, which rejects it outright — and `$CODEX_HOME/AGENTS.md` is the
 * operator's own file, not ours to write. So the system prompt rides in-band on
 * the first message instead; {@link seedPrompt} is where that happens. Codex's
 * own coding-agent preamble stays underneath it either way, which is the main
 * reason `oracle` here is a weaker promise than `oracle` on Claude.
 */
export function buildCodexPlan(cfg: Config, cls: SessionClass, opts: TurnOptions): CodexPlan {
  const scratchDir = opts.scratchDir;
  const args: string[] = [...cfg.codex.binaryArgs, "exec", "--json", "--color", "never"];

  // The workspace roots are ordinary directories, not necessarily repositories,
  // and a bridge session has no business refusing to run in one.
  args.push("--skip-git-repo-check");

  // The operator's MCP servers, plugins and model defaults are theirs, not this
  // session's: they change the tool surface and cost several thousand prompt
  // tokens a turn. Auth still resolves from CODEX_HOME, which is why the socket
  // never needs a copy of auth.json.
  if (cfg.codex.ignoreUserConfig) args.push("--ignore-user-config");

  // Images first: `-i` takes a list, so it must never be the flag immediately
  // before the trailing `-`, which it would swallow as a filename.
  for (const path of opts.imagePaths ?? []) args.push("--image", path);

  args.push("--model", cls.model);
  args.push("--sandbox", sandboxFor(cfg, cls.mode));
  args.push("--cd", cls.cwd);

  if (cls.effort) args.push("-c", `model_reasoning_effort=${cls.effort}`);
  // Without this the reasoning tokens are billed and counted but never shown.
  // Unlike the Claude CLI's thinking blocks, which arrive with the text
  // redacted, these actually carry their summary — so the side channel that is
  // empty on one backend is the one place the other is more forthcoming.
  if (cfg.codex.reasoningSummary) {
    args.push("-c", `model_reasoning_summary=${cfg.codex.reasoningSummary}`);
  }
  if (cls.jsonSchema) {
    const path = join(scratchDir, "schema.json");
    writeFileSync(path, cls.jsonSchema, "utf8");
    args.push("--output-schema", path);
  }

  for (const [key, value] of Object.entries(cfg.codex.configOverrides)) {
    args.push("-c", `${key}=${value}`);
  }
  // Put back the one thing --ignore-user-config should not have taken: see
  // windowsSandboxMode for why losing it silently breaks every tool call.
  if (cfg.codex.ignoreUserConfig && !("windows.sandbox" in cfg.codex.configOverrides)) {
    const mode = windowsSandboxMode(codexHome(cfg));
    if (mode) args.push("-c", `windows.sandbox=${mode}`);
  }

  args.push(...cfg.codex.extraArgs);
  if (opts.threadId) args.push("resume", opts.threadId);
  // Read the prompt from stdin rather than argv: it sidesteps command-line
  // length limits and Windows quoting for the same reasons the Claude side
  // writes its prompts to files.
  args.push("-");

  const env: Record<string, string> = { ...cfg.codex.env };
  if (cfg.codex.home) env["CODEX_HOME"] = cfg.codex.home;

  const unsetEnv = selfReferencingVars(BASE_URL_VARS, cfg.server.port).filter(
    (name) => !(name in env),
  );
  if (unsetEnv.length > 0) {
    log.warn(`unsetting ${unsetEnv.join(", ")} for the CLI: it points back at this server`);
  }

  return { args, env, unsetEnv, cwd: cls.cwd };
}

/**
 * Fold the system prompt into the first message of a conversation.
 *
 * The wrapper is only added when there is a prompt to add, so a caller that
 * sent none still gets its own text through to the model byte for byte.
 */
export function seedPrompt(systemPrompt: string, text: string): string {
  if (!systemPrompt.trim()) return text;
  return `<system_instructions>\n${systemPrompt}\n</system_instructions>\n\n${text}`;
}
