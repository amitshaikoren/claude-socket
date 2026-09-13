import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../core/config.ts";
import { log } from "../util/log.ts";

/** Where the CLI keeps its login, its config and its session transcripts. */
export function codexHome(cfg: Config): string {
  return cfg.codex.home || process.env["CODEX_HOME"] || join(homedir(), ".codex");
}

/**
 * The operator's `[windows] sandbox` setting, carried across `--ignore-user-config`.
 *
 * On Windows, `codex` can only run commands once `codex sandbox setup
 * --elevated` has been done on the machine, and the result is recorded in
 * `config.toml` as `[windows] sandbox`. That is machine setup, not a
 * preference — but `--ignore-user-config` discards it with everything else, and
 * the symptom is quietly terrible: the agent keeps its tools, every command it
 * runs is refused by the policy, and it reports back that it could not look at
 * anything. Verified against 0.153.4, where `semi` could not read a file in its
 * own workspace until this was put back.
 *
 * So this one key is read back out and re-applied. Nothing else from the file
 * is: the point of ignoring it stands, and an operator who never ran the setup
 * has no value here to carry, which is exactly the case where passing one would
 * be a guess.
 */
export function windowsSandboxMode(home: string): string | null {
  if (process.platform !== "win32") return null;
  let toml: string;
  try {
    toml = readFileSync(join(home, "config.toml"), "utf8");
  } catch {
    return null; // no config at all, so nothing was set up to carry
  }

  // Deliberately not a TOML parser. One key is wanted, in one known section,
  // and a dependency-free project should not grow a parser to read it.
  const section = /^\[windows\]\s*$([\s\S]*?)(?=^\[|\Z)/m.exec(toml);
  if (!section) return null;
  const value = /^\s*sandbox\s*=\s*["']([A-Za-z0-9_-]+)["']/m.exec(section[1] ?? "");
  if (!value) return null;

  log.debug("carrying the operator's windows sandbox mode across --ignore-user-config", {
    mode: value[1],
  });
  return value[1] ?? null;
}
