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
import { parseBucket, type UsageFilter, type UsageStore } from "../core/store.ts";
import { log } from "../util/log.ts";

const MAX_BODY_BYTES = 32 * 1024 * 1024;

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers":
    "authorization, content-type, x-api-key, anthropic-version, anthropic-beta, " +
    "x-claude-mode, x-claude-effort, x-claude-cwd, x-claude-session, x-claude-max-budget-usd, " +
    "x-claude-tools, x-claude-disallowed-tools, x-claude-authoritative-text",
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

export function createBridgeServer(
  cfg: Config,
  sessions: SessionManager,
  store: UsageStore,
): Server {
  const server = createServer((req, res) => {
    void handle(cfg, sessions, store, req, res);
  });
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  // Streamed turns can legitimately run for a long time.
  server.requestTimeout = 0;
  return server;
}

/**
 * True only for a request that physically arrived on the loopback interface and
 * was not relayed. A proxy hop would otherwise make every remote request look
 * local, which would turn token disclosure into a credential leak.
 */
function isLocalRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? "";
  const loopback =
    address === "::1" || address === "::ffff:127.0.0.1" || address.startsWith("127.");
  const relayed =
    req.headers["x-forwarded-for"] !== undefined ||
    req.headers["x-real-ip"] !== undefined ||
    req.headers["forwarded"] !== undefined;
  return loopback && !relayed;
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

/**
 * Read the usage filter out of the query string.
 *
 * `from`/`to` accept either epoch milliseconds or anything Date can parse, and
 * `window` is the shorthand the dashboard actually uses: `24h`, `7d`, `30m`.
 * Everything is optional — no filter means the whole history.
 */
function parseUsageFilter(params: URLSearchParams): UsageFilter {
  const time = (key: string): number | undefined => {
    const raw = params.get(key);
    if (!raw) return undefined;
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && raw.trim() !== "") return asNumber;
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? undefined : parsed;
  };

  let from = time("from");
  const window = params.get("window");
  if (from === undefined && window) {
    const match = /^(\d+)([mhd])$/.exec(window.trim());
    if (match) {
      const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "m" | "h" | "d"];
      from = Date.now() - Number(match[1]) * unit;
    }
  }

  const status = params.get("status");
  const limit = Number(params.get("limit"));
  const offset = Number(params.get("offset"));

  return {
    from,
    to: time("to"),
    mode: params.get("mode") ?? undefined,
    model: params.get("model") ?? undefined,
    sessionId: params.get("session") ?? undefined,
    dialect: params.get("dialect") ?? undefined,
    tool: params.get("tool") ?? undefined,
    q: params.get("q") ?? undefined,
    status: status === "ok" || status === "error" ? status : undefined,
    // Capped: this endpoint is a dashboard feed, not a bulk export.
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 200,
    offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
  };
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
  store: UsageStore,
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

    // Lets a dashboard opened on this machine authenticate itself instead of
    // asking the operator to paste a key that is already printed on their
    // terminal. Tokens are disclosed only to a direct loopback request.
    if (req.method === "GET" && path === "/admin/bootstrap") {
      const local = isLocalRequest(req) && cfg.dashboard.localAutoAuth;
      sendJson(res, 200, {
        authRequired: cfg.auth.required,
        local,
        tokens: !cfg.auth.required ? [] : local ? cfg.auth.tokens : [],
        defaultMode: cfg.defaults.mode,
        defaultModel: cfg.defaults.model,
      });
      return;
    }

    if (!isAuthorized(cfg, req, url)) {
      throw new BridgeError(401, "authentication_error", "invalid or missing API key");
    }

    if (req.method === "GET" && path === "/v1/models") {
      handleModels({
        cfg,
        sessions,
        store,
        req,
        res,
        body: {},
        signal: new AbortController().signal,
      });
      return;
    }

    if (req.method === "GET" && path.startsWith("/v1/models/")) {
      const id = decodeURIComponent(path.slice("/v1/models/".length));
      const entry = resolveModel(cfg, id);
      const section = entry.mode === "semi" ? cfg.semi : entry.mode === "harness" ? cfg.harness : null;
      sendJson(res, 200, {
        id: entry.id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: entry.ownedBy,
        context_window: entry.contextWindow,
        mode: entry.mode,
        // What the agent may run. `null` is the CLI's own default set.
        tools: entry.tools !== undefined ? entry.tools : (section?.tools ?? null),
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
          usagePersisted: cfg.usage.persist,
          semiTools: cfg.semi.tools,
          harnessTools: cfg.harness.tools,
        },
      });
      return;
    }

    if (req.method === "GET" && path === "/admin/events") {
      streamEvents(res, Number(url.searchParams.get("history") ?? 60));
      return;
    }

    // ── usage history ─────────────────────────────────────────────────────
    // Everything below reads the persisted store rather than live telemetry,
    // so it survives restarts and answers questions about last week.

    if (req.method === "GET" && path === "/admin/usage") {
      const filter = parseUsageFilter(url.searchParams);
      sendJson(res, 200, {
        filter,
        summary: store.summary(filter),
        facets: store.facets(),
      });
      return;
    }

    if (req.method === "GET" && path === "/admin/usage/turns") {
      const filter = parseUsageFilter(url.searchParams);
      const turns = store.turns(filter);
      sendJson(res, 200, {
        turns,
        // Lets the dashboard show "showing 200 of 4,312" without a second call.
        total: store.summary(filter).turns,
        limit: filter.limit,
        offset: filter.offset,
      });
      return;
    }

    if (req.method === "GET" && path.startsWith("/admin/usage/turns/")) {
      const id = decodeURIComponent(path.slice("/admin/usage/turns/".length)).replace(/\/steps$/, "");
      sendJson(res, 200, { turnId: id, steps: store.steps(id) });
      return;
    }

    if (req.method === "GET" && path === "/admin/usage/series") {
      const filter = parseUsageFilter(url.searchParams);
      const bucket = parseBucket(url.searchParams.get("bucket"));
      sendJson(res, 200, { bucket, points: store.series(filter, bucket) });
      return;
    }

    if (req.method === "GET" && path === "/admin/usage/tools") {
      const filter = parseUsageFilter(url.searchParams);
      sendJson(res, 200, { tools: store.tools(filter) });
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
    const ctx: Ctx = { cfg, sessions, store, req, res, body, signal: controller.signal };

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
