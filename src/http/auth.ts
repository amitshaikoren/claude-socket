import type { IncomingMessage } from "node:http";
import type { Config } from "../core/config.ts";
import { safeEqual } from "../util/hash.ts";

/** Extract the presented credential from any of the places clients put it. */
function presentedToken(req: IncomingMessage, url: URL): string | null {
  const auth = req.headers["authorization"];
  if (typeof auth === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1]!.trim();
  }
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey) return apiKey;
  return url.searchParams.get("api_key");
}

export function isAuthorized(cfg: Config, req: IncomingMessage, url: URL): boolean {
  if (!cfg.auth.required) return true;
  const token = presentedToken(req, url);
  if (!token) return false;
  // Compare against every configured token so timing does not reveal which
  // prefix matched.
  let ok = false;
  for (const candidate of cfg.auth.tokens) {
    if (safeEqual(token, candidate)) ok = true;
  }
  return ok;
}
