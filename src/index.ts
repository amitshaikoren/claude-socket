#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { loadConfig, type Config } from "./core/config.ts";
import { SessionManager } from "./claude/sessions.ts";
import { createSocketServer } from "./http/server.ts";
import { createUsageStore } from "./core/store.ts";
import { log, setLogLevel, type LogLevel } from "./util/log.ts";
import { isMode, MODES } from "./core/types.ts";

const execFileAsync = promisify(execFile);

const USAGE = `claude-socket - an OpenAI/Anthropic-compatible API in front of the Claude Code CLI

Usage: node src/index.ts [options]

Options:
  --port <n>          Port to listen on (default 8787)
  --host <addr>       Address to bind (default 127.0.0.1)
  --config <path>     Config file (default ./socket.config.json)
  --token <value>     API token clients must present (repeatable)
  --no-auth           Disable authentication entirely (loopback only, please)
  --mode <mode>       Default mode for unsuffixed models: oracle | harness | semi
  --model <name>      Default underlying model (default claude-sonnet-5)
  --claude-bin <path> Path to the claude executable
  --usage-db <path>   Where to keep token history (default ./data/usage.db)
  --no-usage-db       Keep token history in memory only, lost on restart
  --log-level <level> error | warn | info | debug
  -h, --help          Show this message
`;

function parseArgs(argv: string[]): { config: Config; help: boolean } {
  let configPath: string | undefined;
  const tokens: string[] = [];
  const overrides: Array<(cfg: Config) => void> = [];
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case "-h":
      case "--help":
        help = true;
        break;
      case "--config":
        configPath = next();
        break;
      case "--port": {
        const port = Number(next());
        overrides.push((c) => void (c.server.port = port));
        break;
      }
      case "--host": {
        const host = next();
        overrides.push((c) => void (c.server.host = host));
        break;
      }
      case "--token":
        tokens.push(next());
        break;
      case "--no-auth":
        overrides.push((c) => void (c.auth.required = false));
        break;
      case "--mode": {
        const mode = next();
        if (!isMode(mode)) throw new Error(`invalid mode: ${mode} (want ${MODES.join(" | ")})`);
        overrides.push((c) => void (c.defaults.mode = mode));
        break;
      }
      case "--no-usage-db":
        overrides.push((c) => void (c.usage.persist = false));
        break;
      case "--usage-db": {
        const path = next();
        overrides.push((c) => {
          c.usage.path = path;
          c.usage.persist = true;
        });
        break;
      }
      case "--model": {
        const model = next();
        overrides.push((c) => void (c.defaults.model = model));
        break;
      }
      case "--claude-bin": {
        const bin = next();
        overrides.push((c) => void (c.claude.binary = bin));
        break;
      }
      case "--log-level": {
        const level = next() as LogLevel;
        overrides.push((c) => void (c.logLevel = level));
        break;
      }
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  const config = loadConfig(configPath);
  if (tokens.length > 0) config.auth.tokens = tokens;
  for (const apply of overrides) apply(config);
  return { config, help };
}

async function checkClaudeBinary(cfg: Config): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cfg.claude.binary, [...cfg.claude.binaryArgs, "--version"], {
      timeout: 20_000,
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    process.exit(2);
  }

  if (parsed.help) {
    process.stdout.write(USAGE);
    return;
  }

  const cfg = parsed.config;
  setLogLevel(cfg.logLevel);

  if (cfg.auth.required && cfg.auth.tokens.length === 0) {
    // Refusing to start would be unhelpful; starting wide open would be worse.
    const generated = "sk-socket-" + randomBytes(24).toString("base64url");
    cfg.auth.tokens = [generated];
    log.warn("no API token configured; generated one for this run");
  }

  const version = await checkClaudeBinary(cfg);
  if (version) log.info(`claude CLI: ${version}`);
  else log.warn(`could not run '${cfg.claude.binary} --version'; requests will fail until it works`);

  const sessions = new SessionManager(cfg);
  const store = await createUsageStore({
    enabled: cfg.usage.persist,
    path: cfg.usage.path,
    flushMs: cfg.usage.flushMs,
    retentionDays: cfg.usage.retentionDays,
    memoryMax: cfg.usage.memoryMax,
  });
  const server = createSocketServer(cfg, sessions, store);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.server.port, cfg.server.host, resolve);
  });

  const shown = cfg.server.host === "0.0.0.0" ? "localhost" : cfg.server.host;
  const base = `http://${shown}:${cfg.server.port}/v1`;
  const key = cfg.auth.required ? cfg.auth.tokens[0]! : "(auth disabled)";

  const origin = `http://${shown}:${cfg.server.port}`;
  process.stdout.write(
    `\nclaude-socket listening on ${base}\n` +
      `  API key      ${key}\n` +
      `  dashboard    ${origin}/ui\n` +
      `  default      mode=${cfg.defaults.mode} model=${cfg.defaults.model}\n` +
      `  models       ${cfg.models.map((m) => m.id).join(", ")}\n\n` +
      `  export OPENAI_BASE_URL=${base}\n` +
      `  export OPENAI_API_KEY=${key}\n\n` +
      `  watch it work:  node src/cli.ts watch --url ${origin} --token ${key}\n` +
      `  talk to it:     node src/cli.ts chat  --url ${origin} --token ${key}\n\n`,
  );

  if (cfg.server.host !== "127.0.0.1" && cfg.server.host !== "localhost") {
    log.warn(
      `bound to ${cfg.server.host}: anyone who can reach this port and holds the token ` +
        `can spend your Claude usage` +
        (cfg.defaults.mode === "harness"
          ? " and run tools on this machine"
          : cfg.defaults.mode === "semi"
            ? ` and run ${(cfg.semi.tools ?? []).join(", ") || "tools"} on this machine`
            : ""),
    );
  }

  const shutdown = () => {
    log.info("shutting down");
    sessions.shutdown();
    // Flushes anything still queued, so the last turns of a run are not lost.
    store.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  log.error("fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
