import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../core/config.ts";
import type { SessionManager } from "../agent/sessions.ts";
import type { UsageStore } from "../core/store.ts";

export interface Ctx {
  cfg: Config;
  sessions: SessionManager;
  /** Where finished turns are written down. */
  store: UsageStore;
  req: IncomingMessage;
  res: ServerResponse;
  body: Record<string, unknown>;
  /** Aborts when the client hangs up, so we stop paying for the turn. */
  signal: AbortSignal;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}
