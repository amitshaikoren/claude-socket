#!/usr/bin/env node
/**
 * Operator CLI for a running socket. Talks to the server over HTTP, so it works
 * against a local or remote instance and never touches the CLI directly.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

const USAGE = `claude-socket CLI

Usage: node src/cli.ts <command> [options]

Commands:
  status              Server health, totals, and configuration
  sessions            Live CLI sessions
  watch               Follow the activity feed until interrupted
  chat [text]         Talk to the proxy; omit text for an interactive session
  models              Advertised model catalog
  kill <session-id>   Terminate one session

Options:
  --url <url>       Base URL          (default http://127.0.0.1:8787, env SOCKET_URL)
  --token <token>   API token         (env SOCKET_TOKEN)
  --model <id>      Model for chat    (default oracle)
  --harness         Shorthand for --model harness
  --no-stream       Disable streaming in chat
`;

interface Options {
  url: string;
  token: string;
  model: string;
  stream: boolean;
  rest: string[];
}

function parse(argv: string[]): { command: string; options: Options } {
  const options: Options = {
    url: process.env["SOCKET_URL"] ?? "http://127.0.0.1:8787",
    token: process.env["SOCKET_TOKEN"] ?? "",
    model: "oracle",
    stream: true,
    rest: [],
  };
  let command = "";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--url") options.url = next();
    else if (arg === "--token") options.token = next();
    else if (arg === "--model") options.model = next();
    else if (arg === "--harness") options.model = "harness";
    else if (arg === "--no-stream") options.stream = false;
    else if (arg === "-h" || arg === "--help") command = "help";
    else if (!command) command = arg;
    else options.rest.push(arg);
  }

  return { command, options };
}

function headers(options: Options): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${options.token}`,
  };
}

async function api(options: Options, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(options.url.replace(/\/$/, "") + path, {
    ...init,
    headers: { ...headers(options), ...(init.headers as Record<string, string> | undefined) },
  });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const message = body?.error?.message ?? body?.message ?? text.slice(0, 200);
    throw new Error(`${res.status} ${message}`);
  }
  return body;
}

const usd = (n: number) => "$" + (n ?? 0).toFixed(4);
const num = (n: number) => (n ?? 0).toLocaleString();

function table(rows: string[][], headings: string[]): string {
  const all = [headings, ...rows];
  const widths = headings.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  const render = (row: string[], dim = false) =>
    (dim ? C.dim : "") +
    row.map((cell, i) => (cell ?? "").padEnd(widths[i]!)).join("  ") +
    (dim ? C.reset : "");
  return [render(headings, true), ...rows.map((r) => render(r))].join("\n");
}

async function cmdStatus(options: Options): Promise<void> {
  const health = await api(options, "/health");
  const stats = await api(options, "/admin/stats");
  const t = stats.totals;

  const uptime = Math.round(stats.uptimeMs / 1000);
  const uptimeText = uptime < 3600 ? `${Math.floor(uptime / 60)}m` : `${Math.floor(uptime / 3600)}h`;

  stdout.write(
    `${C.bold}claude-socket${C.reset} ${C.green}${health.status}${C.reset}  ${C.dim}${options.url}${C.reset}\n\n` +
      `  default      ${stats.config.defaultMode} · ${stats.config.defaultModel}\n` +
      `  sessions     ${stats.sessions.length} live, max ${stats.config.maxSessions}, reuse ${stats.config.reuse ? "on" : "off"}\n` +
      `  uptime       ${uptimeText}\n\n` +
      `  requests     ${num(t.requests)}   turns ${num(t.turns)}   errors ${t.errors > 0 ? C.red : ""}${num(t.errors)}${C.reset}\n` +
      `  tokens       in ${num(t.inputTokens)}  out ${num(t.outputTokens)}  ${C.green}cached ${num(t.cacheReadTokens)}${C.reset}\n` +
      `  tool calls   ${num(t.toolCalls)}\n` +
      `  cost         ${C.yellow}${usd(t.costUsd)}${C.reset}\n`,
  );

  if (stats.rateLimit) {
    stdout.write(`  rate limit   ${stats.rateLimit.status} (${stats.rateLimit.rateLimitType ?? "?"})\n`);
  }
}

async function cmdSessions(options: Options): Promise<void> {
  const { sessions } = await api(options, "/admin/sessions");
  if (sessions.length === 0) {
    stdout.write(`${C.dim}no live sessions${C.reset}\n`);
    return;
  }
  const rows = sessions.map((s: any) => [
    (s.sessionId ?? "").slice(0, 8),
    s.mode,
    s.model,
    String(s.turns),
    usd(s.costUsd),
    s.busy ? "busy" : `${s.idleSeconds}s idle`,
  ]);
  stdout.write(table(rows, ["ID", "MODE", "MODEL", "TURNS", "COST", "STATE"]) + "\n");
}

async function cmdModels(options: Options): Promise<void> {
  const { data } = await api(options, "/v1/models");
  const rows = data.map((m: any) => [m.id, m.mode, num(m.context_window), m.owned_by]);
  stdout.write(table(rows, ["ID", "MODE", "CONTEXT", "OWNED BY"]) + "\n");
}

async function cmdKill(options: Options): Promise<void> {
  const id = options.rest[0];
  if (!id) throw new Error("kill requires a session id");
  await api(options, `/admin/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  stdout.write(`${C.green}killed${C.reset} ${id}\n`);
}

/** Follow the SSE activity feed, formatting each event as one line. */
async function cmdWatch(options: Options): Promise<void> {
  const url =
    options.url.replace(/\/$/, "") + "/admin/events?history=20&api_key=" + encodeURIComponent(options.token);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`watch failed: ${res.status}`);

  stdout.write(`${C.dim}watching ${options.url} — ctrl-c to stop${C.reset}\n`);

  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split: number;
    while ((split = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try {
        printEvent(JSON.parse(line.slice(6)));
      } catch {
        /* ignore malformed frames */
      }
    }
  }
}

function printEvent(ev: any): void {
  const time = new Date(ev.at).toLocaleTimeString([], { hour12: false });
  const colors: Record<string, string> = {
    request: C.blue,
    turn: C.green,
    tool: C.magenta,
    session: C.dim,
    error: C.red,
  };
  const head = `${C.dim}${time}${C.reset} ${colors[ev.type] ?? ""}${ev.type.padEnd(7)}${C.reset}`;

  let body = "";
  switch (ev.type) {
    case "request":
      body = `${ev.model ?? "-"} ${ev.stream ? "stream" : "sync"}${ev.tools ? ` tools:${ev.tools}` : ""}`;
      break;
    case "turn":
      body =
        `${ev.prompt} ${C.dim}→${C.reset} ${ev.reply}\n` +
        `${" ".repeat(17)}${C.dim}${ev.mode} · in ${num(ev.inputTokens)}` +
        (ev.cacheReadTokens ? ` (+${num(ev.cacheReadTokens)} cached)` : "") +
        ` · out ${num(ev.outputTokens)} · ${usd(ev.costUsd)}` +
        (ev.toolCalls ? ` · ${ev.toolCalls} tool call(s)` : "") +
        C.reset;
      break;
    case "tool":
      body = ev.summary ?? ev.name;
      break;
    case "session":
      body = `${ev.action} ${(ev.sessionId ?? "").slice(0, 8)} ${ev.mode ?? ""}${ev.reason ? ` (${ev.reason})` : ""}`;
      break;
    case "error":
      body = ev.message ?? ev.errorType ?? "error";
      break;
    default:
      body = "";
  }
  stdout.write(`${head} ${body}\n`);
}

/** Send one chat turn, streaming the reply to the terminal. */
async function sendChat(options: Options, messages: unknown[]): Promise<string> {
  const res = await fetch(options.url.replace(/\/$/, "") + "/v1/chat/completions", {
    method: "POST",
    headers: headers(options),
    body: JSON.stringify({ model: options.model, messages, stream: options.stream }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${body.slice(0, 300)}`);
  }

  if (!options.stream) {
    const body: any = await res.json();
    const text = body.choices?.[0]?.message?.content ?? "";
    stdout.write(text + "\n");
    return text;
  }

  const decoder = new TextDecoder();
  const reader = res.body!.getReader();
  let buffer = "";
  let reply = "";
  let inReasoning = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split: number;
    while ((split = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, split).trim();
      buffer = buffer.slice(split + 2);
      if (!frame.startsWith("data: ")) continue;
      const payload = frame.slice(6);
      if (payload === "[DONE]") continue;

      let chunk: any;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (chunk.error) throw new Error(chunk.error.message ?? "stream error");

      const delta = chunk.choices?.[0]?.delta;
      if (delta?.reasoning_content) {
        // Agent activity, dimmed so it reads as background chatter.
        if (!inReasoning) inReasoning = true;
        stdout.write(C.dim + delta.reasoning_content + C.reset);
      }
      if (delta?.content) {
        if (inReasoning) {
          inReasoning = false;
          stdout.write("\n");
        }
        stdout.write(delta.content);
        reply += delta.content;
      }
      for (const call of delta?.tool_calls ?? []) {
        stdout.write(
          `\n${C.magenta}tool_call${C.reset} ${call.function?.name}(${call.function?.arguments})\n`,
        );
      }
    }
  }
  stdout.write("\n");
  return reply;
}

async function cmdChat(options: Options): Promise<void> {
  const messages: Array<Record<string, unknown>> = [];

  if (options.rest.length > 0) {
    messages.push({ role: "user", content: options.rest.join(" ") });
    await sendChat(options, messages);
    return;
  }

  stdout.write(
    `${C.dim}chatting with ${C.reset}${options.model}${C.dim} via ${options.url} — ctrl-c or /exit to quit${C.reset}\n`,
  );
  const rl = createInterface({ input: stdin, output: stdout });

  for (;;) {
    const line = (await rl.question(`${C.cyan}> ${C.reset}`)).trim();
    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;
    if (line === "/reset") {
      messages.length = 0;
      stdout.write(`${C.dim}history cleared${C.reset}\n`);
      continue;
    }

    messages.push({ role: "user", content: line });
    try {
      const reply = await sendChat(options, messages);
      messages.push({ role: "assistant", content: reply });
    } catch (err) {
      stdout.write(`${C.red}${err instanceof Error ? err.message : String(err)}${C.reset}\n`);
      messages.pop();
    }
  }
  rl.close();
}

async function main(): Promise<void> {
  const { command, options } = parse(process.argv.slice(2));

  if (!command || command === "help") {
    stdout.write(USAGE);
    return;
  }

  const commands: Record<string, (o: Options) => Promise<void>> = {
    status: cmdStatus,
    sessions: cmdSessions,
    watch: cmdWatch,
    chat: cmdChat,
    models: cmdModels,
    kill: cmdKill,
  };

  const run = commands[command];
  if (!run) {
    stdout.write(`unknown command: ${command}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  await run(options);
}

main().catch((err: unknown) => {
  process.stderr.write(`${C.red}${err instanceof Error ? err.message : String(err)}${C.reset}\n`);
  process.exit(1);
});
