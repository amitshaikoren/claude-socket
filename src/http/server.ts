import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../core/config.ts";
import { projectRoot, resolveModel } from "../core/config.ts";
import { SessionManager } from "../claude/sessions.ts";
import { isAuthorized } from "./auth.ts";
import { SseWriter } from "./sse.ts";
import { telemetry } from "../core/telemetry.ts";
import { sendJson, type Ctx } from "./context.ts";
import { handleChatCompletions, handleModels } from "../api/openai.ts";
import { handleCountTokens, handleMessages } from "../api/anthropic.ts";
import { BridgeError } from "../core/types.ts";
import { log } from "../util/log.ts";

const MAX_BODY_BYTES = 32 * 1024 * 1024;

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers":
    "authorization, content-type, x-api-key, anthropic-version, anthropic-beta, " +
    "x-claude-mode, x-claude-effort, x-claude-cwd, x-claude-session, x-claude-max-budget-usd",
  "access-control-expose-headers": "x-claude-session, x-ratelimit-status, x-ratelimit-reset",
};

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new BridgeError(413, "invalid_request_error", "request body too large");
    }
    chunks.push(buf);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new BridgeError(
      400,
      "invalid_request_error",
      `invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Errors are shaped to match whichever API the client thinks it is talking to. */
function errorBody(anthropicDialect: boolean, err: BridgeError): unknown {
  if (anthropicDialect) {
    return { type: "error", error: { type: err.type, message: err.message } };
  }
  return { error: { message: err.message, type: err.type, param: null, code: err.status } };
}

function toBridgeError(err: unknown): BridgeError {
  if (err instanceof BridgeError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new BridgeError(500, "internal_error", message);
}

export function createBridgeServer(cfg: Config, sessions: SessionManager): Server {
  const server = createServer((req, res) => {
    void handle(cfg, sessions, req, res);
  });
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  // Streamed turns can legitimately run for a long time.
  server.requestTimeout = 0;
  return server;
}

/** Live activity feed for the dashboard and the `watch` CLI. */
function streamEvents(res: ServerResponse, history: number): void {
  const sse = new SseWriter(res);
  for (const event of telemetry.recent(Math.max(0, Math.min(history, 500)))) {
    sse.send(event);
  }

  const unsubscribe = telemetry.subscribe((event) => {
    if (sse.closed) return;
    sse.send(event);
  });
  // Keeps proxies and idle connections from dropping a quiet feed.
  const heartbeat = setInterval(() => sse.comment("keepalive"), 15_000);
  heartbeat.unref?.();

  res.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    sse.end();
  });
}

/** The dashboard is a single self-contained file, read fresh on each request. */
function serveDashboard(res: ServerResponse): void {
  const file = join(projectRoot, "src", "ui", "index.html");
  const html = readFileSync(file, "utf8");
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
  });
  res.end(html);
}

async function handle(
  cfg: Config,
  sessions: SessionManager,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const anthropicDialect = path.startsWith("/v1/messages");

  for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  try {
    if (path === "/health") {
      sendJson(res, 200, {
        status: "ok",
        service: "claude-bridge",
        sessions: sessions.size,
        rate_limit: sessions.rateLimit(),
      });
      return;
    }

    // The dashboard shell carries no data and needs no token: a browser cannot
    // attach an auth header to a plain navigation. Everything it then fetches
    // does require one.
    if (req.method === "GET" && (path === "/" || path === "/ui")) {
      serveDashboard(res);
      return;
    }

    if (!isAuthorized(cfg, req, url)) {
      throw new BridgeError(401, "authentication_error", "invalid or missing API key");
    }

    if (req.method === "GET" && path === "/v1/models") {
      handleModels({ cfg, sessions, req, res, body: {}, signal: new AbortController().signal });
      return;
    }

    if (req.method === "GET" && path.startsWith("/v1/models/")) {
      const id = decodeURIComponent(path.slice("/v1/models/".length));
      const entry = resolveModel(cfg, id);
      sendJson(res, 200, {
        id: entry.id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: entry.ownedBy,
        context_window: entry.contextWindow,
        mode: entry.mode,
      });
      return;
    }

    if (req.method === "GET" && path === "/admin/sessions") {
      sendJson(res, 200, { sessions: sessions.stats() });
      return;
    }

    if (req.method === "DELETE" && path.startsWith("/admin/sessions/")) {
      const id = decodeURIComponent(path.slice("/admin/sessions/".length));
      if (!sessions.kill(id)) throw new BridgeError(404, "not_found_error", `no session ${id}`);
      sendJson(res, 200, { killed: id });
      return;
    }

    if (req.method === "GET" && path === "/admin/stats") {
      sendJson(res, 200, {
        totals: telemetry.totals,
        uptimeMs: Date.now() - telemetry.totals.startedAt,
        sessions: sessions.stats(),
        rateLimit: sessions.rateLimit(),
        config: {
          defaultMode: cfg.defaults.mode,
          defaultModel: cfg.defaults.model,
          maxSessions: cfg.sessions.max,
          reuse: cfg.sessions.reuse,
          claudeBinary: cfg.claude.binary,
        },
      });
      return;
    }

    if (req.method === "GET" && path === "/admin/events") {
      streamEvents(res, Number(url.searchParams.get("history") ?? 60));
      return;
    }

    if (req.method !== "POST") {
      throw new BridgeError(404, "not_found_error", `no route for ${req.method} ${path}`);
    }

    const controller = new AbortController();
    res.on("close", () => {
      // Watch the response, not the request: `req` emits 'close' as soon as the
      // body has been read, which is normal completion, not a disconnect. An
      // unfinished response at close means the client really did hang up, so
      // stop the turn rather than pay for tokens nobody will read.
      if (!res.writableFinished) controller.abort();
    });

    const body = await readBody(req);
    const ctx: Ctx = { cfg, sessions, req, res, body, signal: controller.signal };

    const started = Date.now();
    telemetry.emit("request", {
      path,
      model: typeof body["model"] === "string" ? body["model"] : null,
      stream: body["stream"] === true,
      dialect: anthropicDialect ? "anthropic" : "openai",
      tools: Array.isArray(body["tools"]) ? body["tools"].length : 0,
    });

    if (path === "/v1/chat/completions") {
      await handleChatCompletions(ctx);
    } else if (path === "/v1/messages") {
      await handleMessages(ctx);
    } else if (path === "/v1/messages/count_tokens") {
      handleCountTokens(ctx);
    } else {
      throw new BridgeError(404, "not_found_error", `no route for POST ${path}`);
    }
    log.info(`${req.method} ${path}`, { ms: Date.now() - started });
  } catch (err) {
    const bridgeError = toBridgeError(err);
    if (bridgeError.status >= 500) log.error(`${req.method} ${path} failed`, { error: bridgeError.message });
    else log.warn(`${req.method} ${path} rejected`, { status: bridgeError.status, error: bridgeError.message });

    telemetry.emit("error", {
      path,
      status: bridgeError.status,
      errorType: bridgeError.type,
      message: bridgeError.message,
    });

    if (res.headersSent) {
      // Mid-stream failure; the dialect handlers already emitted an error event.
      if (!res.writableEnded) res.end();
      return;
    }
    sendJson(res, bridgeError.status, errorBody(anthropicDialect, bridgeError));
  }
}
